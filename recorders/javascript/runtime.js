const fs = require("fs");
const { value_encoder } = require("./encode");
const { line_writer } = require("./writer");

// the runtime that instrumented code calls into. it owns the recording file,
// the call counter and the caps. above all it must never change what the user's
// program does: every entry point returns something harmless when recording is
// off or broken.

const api_name = "__wakeline_wk";
let options = null;
let writer = null;
let broken = false;
let calls = 0;
let next_id = 1;
let active = 0; // how many instrumented calls are on the stack right now
let stopped = false; // stop starting new calls, let running ones finish
let hard_stop = false; // stop writing anything except forced lines
let hit = null; // first cap that fired, so later ones don't overwrite it
let mask = []; // compiled name patterns to hide

function set_options_from_env() {
  // the recorder process passes everything through env vars. parse once; a
  // second call is a no-op, which matters because several entry points can
  // call it during startup.
  if (options) return options;
  const env = process.env;
  options = {
    file: env.wakeline_file || "",
    out: env.wakeline_out || "",
    name: env.wakeline_name || "",
    line0: Number(env.wakeline_line0 || 1),
    line1: Number(env.wakeline_line1 || 1),
    max_calls: Math.max(1, Number(env.wakeline_max_calls || 100)),
    max_events: Math.max(1, Number(env.wakeline_max_events || 10000)),
    max_bytes: Math.max(0, Number(env.wakeline_max_bytes || 0)),
    mask: env.wakeline_mask || "",
  };
  // compile the mask patterns once. commas separate them and spaces are just
  // trimming noise, since env vars are easier to write that way.
  mask = options.mask
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(glob_regex);
  open_writer();
  return options;
}

function open_writer() {
  // opening the file is also where the ver and meta headers go. if this fails
  // there is nothing useful to record, so mark broken and let the program run
  // untraced rather than crashing it.
  if (writer || broken) return;
  if (!options || !options.out) {
    broken = true;
    return;
  }
  try {
    writer = new line_writer(options.out, options.max_bytes);
    writer.write({ k: "ver", v: 1 }, true);
    writer.write({ k: "meta", src: options.file, sm: source_mtime(options.file) }, true);
  } catch (err) {
    broken = true;
    writer = null;
    process.stderr.write(`wakeline: cannot write recording at ${options.out}: ${err.message}\n`);
  }
}

function source_mtime(file) {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch (err) {
    return 0;
  }
}

function install_global() {
  // the instrumented source calls globalThis.__wakeline_wk. putting it on
  // globalThis means the injected code doesn't need an import or a require.
  globalThis[api_name] = {
    enter,
    at,
    ret,
    thrown,
    err,
    end,
  };
}

function enter(name, line0, line1, args) {
  // called at the top of every instrumented function. returning null switches
  // all the other hooks off for that invocation.
  if (!options) set_options_from_env();
  if (!writer || broken || hard_stop) return null;
  if (stopped || calls >= options.max_calls) {
    cap("max_calls", null);
    return null;
  }

  // args are encoded with their own encoder so reference ids stay scoped to one
  // invocation and don't leak between calls.
  const id = `c${next_id++}`;
  calls++;
  const depth = active;
  active++;
  const encoder = new value_encoder();
  const encoded_args = {};
  for (const key of Object.keys(args || {})) {
    if (is_masked(key)) {
      encoded_args[key] = { $: "opaque", cls: "masked", why: "masked" };
    } else {
      encoded_args[key] = encoder.encode(args[key]);
    }
  }
  // everything the hooks need lives on this object, and the instrumented code
  // holds it for the duration of the call.
  const state = {
    id,
    depth,
    started: Date.now(),
    encoder,
    steps: 0,
    capped: false,
    cap_reason: "none",
    ended: false,
    returned: undefined,
    has_return: false,
    error: null,
    last_exception: null,
  };

  const ok = write(
    {
      k: "call_start",
      i: id,
      f: name || options.name,
      l0: line0 || options.line0,
      l1: line1 || options.line1,
      dp: depth,
      a: encoded_args,
      t: state.started,
    },
    state,
  );
  if (!ok) {
    active--;
    return null;
  }
  return state;
}

function at(state, line, capture) {
  // one line event. the capture closure is built by the instrumenter and reads
  // the locals that are actually in scope; it is called lazily so a capped
  // call costs nothing.
  if (!state || state.ended || state.capped || hard_stop) return;
  if (state.steps >= options.max_events) {
    cap_events(state);
    return;
  }

  let raw = {};
  if (capture) {
    try {
      raw = capture() || {};
    } catch (err) {
      raw = {};
    }
  }
  const values = {};
  for (const key of Object.keys(raw)) {
    if (is_masked(key)) {
      values[key] = { $: "opaque", cls: "masked", why: "masked" };
    } else {
      values[key] = state.encoder.encode(raw[key]);
    }
  }
  if (write({ k: "line", i: state.id, s: state.steps, l: line, v: values }, state)) {
    state.steps++;
  }
}

function ret(state, value) {
  // remember the return value but hand it straight back, so `return x` behaves
  // exactly as it did before instrumentation.
  if (state) {
    state.returned = value;
    state.has_return = true;
  }
  return value;
}

function thrown(state, err) {
  // same idea for throw: record and give the same value back.
  record_exception(state, err);
  return err;
}

function err(state, thrown_value) {
  if (!state) return;
  state.error = thrown_value;
  record_exception(state, thrown_value);
}

function end(state) {
  // the finally hook. exactly one call_end per call, even if end is somehow
  // reached twice: the guard makes it harmless.
  if (!state || state.ended) return;
  state.ended = true;

  let event;
  if (state.error) {
    event = {
      k: "call_end",
      i: state.id,
      s: state.steps ? state.steps - 1 : 0,
      o: "throw",
      x: exception_info(state.error),
      ms: Date.now() - state.started,
      c: state.cap_reason,
    };
  } else {
    event = {
      k: "call_end",
      i: state.id,
      s: state.steps ? state.steps - 1 : 0,
      o: "return",
      r: state.encoder.encode(state.has_return ? state.returned : undefined),
      ms: Date.now() - state.started,
      c: state.cap_reason,
    };
  }

  try {
    // forced, because the byte cap may already have refused normal writes and
    // a call without its end line would look interrupted forever.
    write(event, state, true);
    if (writer) writer.flush();
  } finally {
    active = Math.max(0, active - 1);
  }
}

function cap_events(state) {
  // this cap is per call: stop recording its lines but let the program keep
  // running to the end. other calls still get recorded normally.
  if (state.capped) return;
  state.capped = true;
  state.cap_reason = "max_events";
  write(
    { k: "cap_hit", i: state.id, r: "max_events", s: state.steps, b: writer ? writer.bytes : 0 },
    state,
    true,
  );
}

function cap(reason, state) {
  // global caps. only the first one is reported, otherwise a byte cap on top of
  // a call cap would make the recording confusing to read.
  if (hit) return;
  hit = reason;
  if (reason === "max_calls" || reason === "max_bytes") stopped = true;
  if (reason === "max_bytes") hard_stop = true;

  const event = {
    k: "cap_hit",
    r: reason,
    s: state ? state.steps : 0,
    b: writer ? writer.bytes : 0,
  };
  if (state) event.i = state.id;
  try {
    write(event, state, true);
    if (writer) writer.flush();
  } catch (err) {
    hard_stop = true;
  }
}

function write(event, state, force = false) {
  // one place where bytes are counted, so the cap cannot be bypassed. a negative
  // length from the writer means "this line would go over the limit".
  if (!writer || broken) return false;
  if (hard_stop && !force) return false;
  let n;
  try {
    n = writer.write(event, force);
  } catch (err) {
    failure("write", err);
    return false;
  }
  if (n < 0) {
    cap("max_bytes", state);
    return false;
  }
  return true;
}

function record_exception(state, value) {
  // thrown() and err() can both see the same exception as it unwinds. only the
  // first sighting gets its own event.
  if (!state || state.last_exception === value) return;
  state.last_exception = value;
  write({ k: "exception", i: state.id, x: exception_info(value) }, state);
}

function exception_info(value) {
  // never trust an exception to print cleanly. every read here is guarded and
  // the output is clipped so a hostile getter can't blow up the recorder.
  let name = "Error";
  let message = "";
  let stack = "";
  try {
    name = (value && value.name) || (value && value.constructor && value.constructor.name) || typeof value;
    message = String(value && value.message !== undefined ? value.message : value).slice(0, 1000);
    stack = String((value && value.stack) || "");
  } catch (err) {
    message = "<unprintable>";
  }
  const frames = [];
  if (stack) {
    for (const line of stack.split("\n")) {
      if (frames.length >= 20) break;
      if (/^\s*at /.test(line)) frames.push(line.trim());
    }
  }
  return { t: String(name), m: message, s: frames };
}

function failure(where, err) {
  // called when instrumentation or writing fails. write one last line so the
  // extension can explain why there is no timeline, then stop touching
  // anything.
  if (!options) set_options_from_env();
  hard_stop = true;
  stopped = true;
  let message = "";
  try {
    message = String((err && err.message) || err).slice(0, 500);
  } catch (e) {
    message = "<unprintable>";
  }
  try {
    open_writer();
    if (!writer) return;
    write({ k: "failure", why: message, where }, null, true);
    writer.flush();
  } catch (e) {
    broken = true;
  }
}

function is_masked(name) {
  for (const re of mask) if (re.test(name)) return true;
  return false;
}

// turn a mask like `*token*` into an anchored regex. everything else is
// escaped, so a pattern is never accidentally a regex.
function glob_regex(pattern) {
  const text = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${text}$`);
}

// last chance to flush. this is not guaranteed on a hard kill, but it covers
// normal exits and uncaught exceptions.
process.on("exit", () => {
  if (!writer) return;
  try {
    writer.close();
  } catch (err) {
    // nothing useful left to do
  }
});

module.exports = {
  set_options_from_env,
  install_global,
  failure,
  get options() {
    return options;
  },
};
