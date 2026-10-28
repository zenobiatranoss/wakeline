import bisect
import dis
import fnmatch
import inspect
import os
import sys
import threading
import time
import traceback

from wk_encode import value_encoder

# the python side of the recorder. a sys.settrace hook watches frames, starts a
# recording when the chosen function is called and writes one line event for
# every source line it executes. sys.settrace has to be fast because it runs on
# every line of the whole program, so the hot paths here stay as tight as they
# can and everything is wrapped so a recorder bug can't propagate into the
# user's code.


class call_state:
    # one per invocation of the target function. the local trace closure keeps a
    # reference to this, which is how nested calls stay separate.
    def __init__(self, cid, depth, started, encoder):
        self.id = cid
        self.depth = depth
        self.started = started
        self.encoder = encoder
        self.steps = 0
        self.capped = False
        self.cap_reason = "none"
        self.pending_exc = None


class tracer:
    def __init__(
        self,
        target_file,
        target_name,
        lines,
        writer,
        max_calls,
        max_events,
        max_bytes,
        max_depth=4,
        max_items=100,
        max_string=4096,
        max_value_bytes=65536,
        masked=None,
    ):
        # compare real, case-normalised paths. a file opened through a symlink or
        # with different casing still has to count as the same file.
        self.writer = writer
        self.target_file = os.path.normcase(os.path.realpath(target_file))
        self.target_name = target_name
        # simple_name is what co_name holds; target_qual is the qualified name
        # that python 3.11+ puts on a code object, with <locals> removed.
        self.simple_name = target_name.rsplit(".", 1)[-1]
        self.target_qual = target_name.replace(".<locals>.", ".")
        self.lines = lines
        self.max_calls = max(1, max_calls)
        self.max_events = max(1, max_events)
        self.max_bytes = max_bytes
        self.max_depth = max_depth
        self.max_items = max_items
        self.max_string = max_string
        self.max_value_bytes = max_value_bytes
        self.masked = list(masked or ())

        # the same state machine as the js runtime: stopped means no new calls,
        # hard_stop means nothing gets written unless forced.
        self.calls = 0
        self.next_id = 1
        self.active = 0
        self.stopped = False
        self.hard_stop = False
        self.hit = None  # first cap to fire, so later caps don't overwrite it

        # tracing can run on several threads, so writes and counters need a lock.
        # the caches are just there because these checks run constantly.
        self._lock = threading.Lock()
        self._file_cache = {}
        self._code_cache = {}
        self._ins_cache = {}
        self._prev_trace = None
        self._prev_thread_trace = None
        self._installed = False

    def install(self):
        # remember any tracer that was already there (a debugger, coverage) so
        # uninstall can put it back. we are a guest in this process.
        try:
            self._prev_trace = sys.gettrace()
        except Exception:
            self._prev_trace = None

        getter = getattr(threading, "gettrace", None)
        if getter is not None:
            try:
                self._prev_thread_trace = getter()
            except Exception:
                self._prev_thread_trace = None

        # threading.settrace covers threads started after this point. it raises
        # on exotic builds, and that should not stop the main thread tracing.
        sys.settrace(self._global_trace)
        try:
            threading.settrace(self._global_trace)
        except Exception:
            pass
        self._installed = True

    def uninstall(self):
        # safe to call more than once. a hard cap and interpreter shutdown can
        # both get here.
        if not self._installed:
            return
        self._installed = False
        try:
            sys.settrace(self._prev_trace)
        except Exception:
            try:
                sys.settrace(None)
            except Exception:
                pass
        try:
            threading.settrace(self._prev_thread_trace)
        except Exception:
            pass

    def _global_trace(self, frame, event, arg):
        # this runs on every function call in the entire program, so the first
        # job is to get out fast for anything that isn't a call event.
        if event != "call":
            return None
        if self.hard_stop or self.stopped:
            return None

        # generators and coroutines fire call again on every resume; python keeps
        # the old local trace on the frame, so reuse it instead of starting a new
        # call. the wk_owner tag is how we know the trace is ours and not some
        # other tool's.
        prev = frame.f_trace
        if prev is not None and getattr(prev, "wk_owner", None) is self:
            return prev

        try:
            if not self._is_target(frame):
                return None
            return self._start(frame)
        except Exception as exc:
            self._fail("trace", exc)
            return None

    def _start(self, frame):
        # reserve an id under the lock so concurrent threads can't reuse one.
        with self._lock:
            if self.calls >= self.max_calls:
                full = True
                cid = None
            else:
                full = False
                self.calls += 1
                cid = "c%d" % self.next_id
                self.next_id += 1
                self.active += 1

        if full:
            self._cap("max_calls")
            return None

        # one encoder per call, same reason as the js side: ref ids belong to a
        # single invocation.
        encoder = value_encoder(
            max_depth=self.max_depth,
            max_items=self.max_items,
            max_string=self.max_string,
            max_value_bytes=self.max_value_bytes,
        )
        state = call_state(cid, self._depth(frame), time.monotonic(), encoder)
        args = self._args(frame, encoder)

        ok = self._write(
            {
                "k": "call_start",
                "i": cid,
                "f": self.target_name,
                "l0": self.lines[0],
                "l1": self.lines[1],
                "dp": state.depth,
                "a": args,
                "t": int(time.time() * 1000),
            }
        )
        if not ok:
            with self._lock:
                self.active -= 1
            self._maybe_off()
            return None

        return self._make_local(state)

    def _make_local(self, state):
        # the per-frame trace. python calls it for line, return and exception
        # events until it returns None, which is how we stop tracing a finished
        # call without touching the global tracer.
        def local(frame, event, arg):
            try:
                if event == "line":
                    if not self.hard_stop:
                        self._on_line(state, frame)
                elif event == "return":
                    if not self._on_return(state, frame, arg):
                        return None
                elif event == "exception":
                    if not self.hard_stop:
                        self._on_exception(state, frame, arg)
            except Exception as exc:
                self._fail("trace", exc)
                return None
            return local

        # tagging the function object is what the resume check above looks for.
        local.wk_owner = self
        return local

    def _on_line(self, state, frame):
        # a line event clears any pending exception: the frame moved on, so the
        # exception it saw must have been caught somewhere.
        state.pending_exc = None
        if state.capped:
            return
        if state.steps >= self.max_events:
            self._cap_events(state)
            return

        # copy the whole local namespace. mutating it while iterating is not
        # allowed, and the encoder can call user code (a property or repr), so
        # take a snapshot first.
        values = {}
        for name, val in frame.f_locals.items():
            if self._masked(name):
                values[name] = {"$": "opaque", "cls": "masked", "why": "masked"}
            else:
                values[name] = state.encoder.encode(val)

        event = {
            "k": "line",
            "i": state.id,
            "s": state.steps,
            "l": frame.f_lineno,
            "v": values,
        }
        if self._write(event, state):
            state.steps += 1

    def _on_exception(self, state, frame, arg):
        # internal generator stops are not exceptions the user cares about. the
        # interpreter raises them to signal an exhausted generator.
        exc_type, exc_value, tb = arg
        if exc_type in (StopIteration, StopAsyncIteration) and self._is_generator(frame):
            return

        info = self._exc_info(exc_type, exc_value, tb)
        state.pending_exc = info
        if state.capped:
            return
        self._write({"k": "exception", "i": state.id, "x": info}, state)

    def _on_return(self, state, frame, arg):
        # a generator yielding looks like a return to the tracer. keep the trace
        # installed and wait for the next resume.
        if self._is_suspended(frame):
            return True

        # an exception we saw is only a real throw if the function is ending
        # right now. if it was caught, pending_exc was cleared by the next line.
        if state.pending_exc is not None:
            end = {
                "k": "call_end",
                "i": state.id,
                "s": state.steps - 1 if state.steps else 0,
                "o": "throw",
                "x": state.pending_exc,
                "ms": int((time.monotonic() - state.started) * 1000),
                "c": state.cap_reason,
            }
        else:
            end = {
                "k": "call_end",
                "i": state.id,
                "s": state.steps - 1 if state.steps else 0,
                "o": "return",
                "r": state.encoder.encode(arg),
                "ms": int((time.monotonic() - state.started) * 1000),
                "c": state.cap_reason,
            }

        try:
            self._write(end, state, force=True)
            self.writer.flush()
        finally:
            # detach the trace from this frame and give the active slot back,
            # even if writing the end line failed.
            frame.f_trace = None
            with self._lock:
                self.active -= 1
                active = self.active
            if active <= 0 and (self.stopped or self.hard_stop):
                self.uninstall()

        return False

    def _maybe_off(self):
        # turn the global tracer off once nothing is running. doing it earlier
        # would cut off calls that are still on the stack.
        with self._lock:
            active = self.active
        if active <= 0 and (self.stopped or self.hard_stop):
            self.uninstall()

    def _cap_events(self, state):
        # per call, like the js runtime. the program keeps running, we just stop
        # recording this invocation.
        if state.capped:
            return
        state.capped = True
        state.cap_reason = "max_events"
        self._write(
            {
                "k": "cap_hit",
                "i": state.id,
                "r": "max_events",
                "s": state.steps,
                "b": self.writer.bytes,
            },
            state,
            force=True,
        )

    def _cap(self, reason, state=None):
        # global cap. only the first reason is written, so the timeline can show
        # one clear cause instead of a pile-up.
        with self._lock:
            if self.hit is not None:
                return
            self.hit = reason

        if reason in ("max_calls", "max_bytes"):
            self.stopped = True
        if reason == "max_bytes":
            self.hard_stop = True

        entry = {
            "k": "cap_hit",
            "r": reason,
            "s": state.steps if state is not None else 0,
            "b": self.writer.bytes,
        }
        if state is not None:
            entry["i"] = state.id

        try:
            self.writer.write(entry, force=True)
            self.writer.flush()
        except Exception:
            pass

        if reason == "max_bytes":
            self.uninstall()
        else:
            self._maybe_off()

    def _write(self, obj, state=None, force=False):
        # every write goes through here so the byte cap is enforced in one place.
        # a negative result from the writer means the cap was reached.
        if self.hard_stop and not force:
            return False
        try:
            n = self.writer.write(obj, force=force)
        except Exception as exc:
            self._fail("write", exc)
            return False
        if n < 0:
            self._cap("max_bytes", state)
            return False
        return True

    def _fail(self, where, exc):
        # something in the recorder broke. write a failure line, then get out of
        # the way permanently. the user's program must keep running.
        if self.hard_stop:
            return
        self.hard_stop = True
        self.stopped = True
        try:
            message = str(exc)[:500]
        except Exception:
            message = "<unprintable>"
        try:
            self.writer.write({"k": "failure", "why": message, "where": where}, force=True)
            self.writer.flush()
        except Exception:
            pass
        self.uninstall()

    def _is_target(self, frame):
        return self._is_target_code(frame.f_code)

    def _is_target_code(self, code):
        # called for every function call in the program, so cache aggressively.
        # a code object is immutable, which makes it a safe key.
        hit = self._code_cache.get(code)
        if hit is not None:
            return hit

        ok = False
        try:
            if code.co_name == self.simple_name:
                if self.lines[0] <= code.co_firstlineno <= self.lines[1]:
                    if self._file_ok(code.co_filename):
                        # co_qualname is 3.11+. without it, name plus line range
                        # is the best we can do, and that is fine in practice.
                        qual = getattr(code, "co_qualname", None)
                        if not qual:
                            ok = True
                        else:
                            q = qual.replace(".<locals>.", ".")
                            ok = (
                                q == self.target_qual
                                or q.endswith("." + self.target_qual)
                                or self.target_qual.endswith("." + q)
                            )
        except Exception:
            ok = False

        self._code_cache[code] = ok
        return ok

    def _file_ok(self, filename):
        # realpath is a syscall, and this check happens constantly. cache by the
        # filename string the code object holds.
        hit = self._file_cache.get(filename)
        if hit is not None:
            return hit
        try:
            ok = os.path.normcase(os.path.realpath(filename)) == self.target_file
        except Exception:
            ok = False
        self._file_cache[filename] = ok
        return ok

    def _depth(self, frame):
        # count only frames for the same target function, so depth means
        # "recursion depth of this function" rather than call stack depth.
        n = 0
        f = frame.f_back
        while f is not None:
            if self._is_target_code(f.f_code):
                n += 1
            f = f.f_back
        return n

    def _args(self, frame, encoder):
        # rebuild the argument names from the code object. f_locals has all the
        # local variables too, and call_start should only carry real arguments.
        code = frame.f_code
        local = frame.f_locals
        positional = code.co_argcount
        keyword_only = code.co_kwonlyargcount
        names = list(code.co_varnames[: positional + keyword_only])
        index = positional + keyword_only
        flags = code.co_flags

        # *args and **kwargs come after the positional and keyword-only names in
        # co_varnames, and only when the flags say they exist.
        if flags & inspect.CO_VARARGS and index < len(code.co_varnames):
            names.append(code.co_varnames[index])
            index += 1
        if flags & inspect.CO_VARKEYWORDS and index < len(code.co_varnames):
            names.append(code.co_varnames[index])

        out = {}
        for name in names:
            if name not in local:
                continue
            if self._masked(name):
                out[name] = {"$": "opaque", "cls": "masked", "why": "masked"}
            else:
                out[name] = encoder.encode(local[name])
        return out

    def _masked(self, name):
        # fnmatch gives * and ? like a shell, which is what people expect from a
        # mask list. matching is case sensitive on purpose.
        for pattern in self.masked:
            if fnmatch.fnmatchcase(name, pattern):
                return True
        return False

    def _exc_info(self, exc_type, exc_value, tb):
        # flatten an exception to something json-safe. the string of a custom
        # exception can itself raise, so guard it.
        name = getattr(exc_type, "__name__", None) or str(exc_type)
        try:
            message = str(exc_value)[:1000]
        except Exception:
            message = "<unprintable>"

        frames = []
        try:
            for frame in traceback.extract_tb(tb):
                if len(frames) >= 20:
                    break
                filename = frame.filename
                if len(filename) > 300:
                    filename = filename[-300:]
                frames.append("%s:%d in %s" % (filename, frame.lineno, frame.name))
        except Exception:
            pass

        return {"t": name, "m": message, "s": frames}

    def _is_generator(self, frame):
        # one check covers generators, coroutines and async generators. they all
        # suspend in the middle of a call.
        flags = frame.f_code.co_flags
        return bool(flags & (inspect.CO_GENERATOR | inspect.CO_COROUTINE | inspect.CO_ASYNC_GENERATOR))

    def _is_suspended(self, frame):
        # a return event for a generator may really be a yield. disassemble the
        # code once and look at the instruction that was executing.
        if not self._is_generator(frame):
            return False

        offsets, names = self._instructions(frame.f_code)
        if not offsets:
            return False

        i = bisect.bisect_right(offsets, frame.f_lasti) - 1
        if i < 0:
            return False
        if names[i] in ("YIELD_VALUE", "YIELD_FROM", "SEND"):
            return True
        if i > 0 and names[i - 1] in ("YIELD_VALUE", "YIELD_FROM"):
            return True
        return False

    def _instructions(self, code):
        # disassembly is not cheap, so cache it per code object. a failure here
        # disables yield detection rather than breaking the recording.
        hit = self._ins_cache.get(code)
        if hit is not None:
            return hit

        offsets = []
        names = []
        try:
            for ins in dis.get_instructions(code):
                offsets.append(ins.offset)
                names.append(ins.opname)
        except Exception:
            offsets = []
            names = []

        hit = (offsets, names)
        self._ins_cache[code] = hit
        return hit
