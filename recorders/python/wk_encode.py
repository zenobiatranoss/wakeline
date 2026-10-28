import base64
import inspect
import itertools
import math


# turns live python values into the json that goes in a recording. every
# attribute access and iteration is wrapped, because __getattr__, __iter__ and
# __repr__ are user code and can throw, recurse or take forever.

safe_int = 9007199254740991  # largest integer json can carry exactly in js
bytes_prefix = 256


class value_encoder:
    # one encoder per recorded call. the seen map is why: ids must be stable
    # within a call and mean nothing outside it.
    def __init__(self, max_depth=4, max_items=100, max_string=4096, max_value_bytes=65536, max_seen=10000):
        self.max_depth = max(0, max_depth)
        self.max_items = max(1, max_items)
        self.max_string = max(0, max_string)
        self.max_value_bytes = max(0, max_value_bytes)
        self.max_seen = max(1, max_seen)
        self._seen = {}
        self._next_id = 1
        self._budget = 0

    def encode(self, v):
        # the budget is per value, not per recording. resetting it here means a
        # big object can't starve the values after it.
        self._budget = self.max_value_bytes
        try:
            return self._encode(v, 0)
        except Exception:
            return {"$": "trunc", "why": "error"}

    def _spend(self, n):
        self._budget -= n

    def _remember(self, v):
        # ids are reused after garbage collection, so hold a strong reference to
        # the value as well and compare identity before trusting a hit.
        key = id(v)
        hit = self._seen.get(key)
        if hit is not None and hit[1] is v:
            return hit[0], True
        if len(self._seen) >= self.max_seen:
            return None, False
        oid = self._next_id
        self._next_id += 1
        self._seen[key] = (oid, v)
        return oid, False

    def _encode(self, v, depth):
        # the order matters. bool before int because bool is an int subclass, and
        # all the primitive cases before the containers.
        if self._budget <= 0:
            return {"$": "trunc", "why": "bytes"}

        if v is None:
            return None
        # identity checks, not isinstance, to keep bools out of the int branch.
        if v is True:
            return True
        if v is False:
            return False

        if isinstance(v, int):
            # js numbers lose precision past 2^53, so anything bigger travels as
            # a decimal string and the ui prints it as is.
            if -safe_int <= v <= safe_int:
                return v
            return {"$": "int", "v": str(v)}

        if isinstance(v, float):
            # json has no nan or infinity. tagged strings keep them readable.
            if math.isnan(v):
                return {"$": "num", "v": "nan"}
            if math.isinf(v):
                return {"$": "num", "v": "inf" if v > 0 else "-inf"}
            return v

        if isinstance(v, str):
            # clip long strings but remember how long they really were.
            size = len(v)
            if size > self.max_string:
                part = v[:self.max_string]
                self._spend(len(part))
                return {"$": "str", "v": part, "n": size, "cut": True}
            self._spend(size)
            return v

        # keep a small base64 prefix. enough to recognise a header, not enough to
        # blow up the recording.
        if isinstance(v, (bytes, bytearray, memoryview)):
            data = bytes(v)
            size = len(data)
            part = data[:bytes_prefix]
            self._spend(len(part))
            return {
                "$": "bytes",
                "v": base64.b64encode(part).decode("ascii"),
                "n": size,
                "cut": size > len(part),
            }

        # check depth before anything that could recurse. cycles are handled by
        # the seen map, depth is the belt to that braces.
        if depth >= self.max_depth:
            return {"$": "trunc", "why": "depth"}

        # things that are not data. showing the name or type is more useful than
        # pretending to expand them.
        if inspect.ismodule(v):
            return {"$": "opaque", "cls": "module", "why": "module"}

        if inspect.isclass(v):
            return {"$": "fn", "name": getattr(v, "__name__", "?")}

        if inspect.isfunction(v) or inspect.ismethod(v) or inspect.isbuiltin(v):
            return {"$": "fn", "name": getattr(v, "__name__", "?")}

        # never iterate a generator just to record it: that would consume it and
        # change what the user's program sees.
        if inspect.isgenerator(v) or inspect.iscoroutine(v) or inspect.isasyncgen(v):
            return {"$": "opaque", "cls": type(v).__name__, "why": "runtime object"}

        if isinstance(v, BaseException):
            # str(exception) can raise if the exception class overrides it.
            message = ""
            try:
                message = str(v)[:1000]
            except Exception:
                message = "<unprintable>"
            return {"$": "error", "cls": type(v).__name__, "m": message}

        # numpy arrays are everywhere and showing "array([...])" clipped to 100
        # items is useless. type, length and shape say far more.
        module = getattr(type(v), "__module__", "") or ""
        if module.startswith("numpy"):
            out = {"$": "opaque", "cls": type(v).__name__}
            try:
                out["n"] = len(v)
            except Exception:
                pass
            shape = getattr(v, "shape", None)
            if shape is not None:
                try:
                    out["shape"] = [int(x) for x in shape]
                except Exception:
                    pass
            return out

        # containers next. each one records how many items it really has plus
        # whether the list in the file was cut.
        if isinstance(v, (list, tuple, range)):
            return self._encode_sequence(v, depth)

        if isinstance(v, dict):
            return self._encode_dict(v, depth)

        if isinstance(v, (set, frozenset)):
            return self._encode_set(v, depth)

        return self._encode_object(v, depth)

    def _encode_sequence(self, v, depth):
        # islice stops after max_items, which also means an infinite generator
        # passed as a "sequence" can't hang us. (generators are caught above, but
        # custom sequence types are not.)
        oid, seen = self._remember(v)
        if seen:
            return {"$": "ref", "id": oid}
        try:
            n = len(v)
        except Exception:
            n = None

        items = []
        try:
            for item in itertools.islice(v, self.max_items):
                items.append(self._encode(item, depth + 1))
                self._spend(8)
        except Exception:
            return {"$": "trunc", "why": "error"}

        out = {
            "$": "list",
            "v": items,
            "n": n if n is not None else len(items),
            "cut": n is not None and n > len(items),
        }
        if oid is not None:
            out["id"] = oid
        return out

    def _encode_dict(self, v, depth):
        # pairs, not an object, because python keys are not always strings.
        oid, seen = self._remember(v)
        if seen:
            return {"$": "ref", "id": oid}
        try:
            n = len(v)
        except Exception:
            n = None

        pairs = []
        try:
            for key, val in itertools.islice(v.items(), self.max_items):
                pairs.append([self._encode(key, depth + 1), self._encode(val, depth + 1)])
                self._spend(16)
        except Exception:
            return {"$": "trunc", "why": "error"}

        out = {
            "$": "dict",
            "v": pairs,
            "n": n if n is not None else len(pairs),
            "cut": n is not None and n > len(pairs),
        }
        if oid is not None:
            out["id"] = oid
        return out

    def _encode_set(self, v, depth):
        # sets are unordered, so two recordings of the same set may list items
        # differently. that is expected, not a divergence.
        oid, seen = self._remember(v)
        if seen:
            return {"$": "ref", "id": oid}
        try:
            n = len(v)
        except Exception:
            n = None

        items = []
        try:
            for item in itertools.islice(v, self.max_items):
                items.append(self._encode(item, depth + 1))
                self._spend(8)
        except Exception:
            return {"$": "trunc", "why": "error"}

        out = {
            "$": "set",
            "v": items,
            "n": n if n is not None else len(items),
            "cut": n is not None and n > len(items),
        }
        if oid is not None:
            out["id"] = oid
        return out

    def _encode_object(self, v, depth):
        # last resort for arbitrary instances: __dict__ first, then slots. this
        # covers most plain classes without invoking properties.
        oid, seen = self._remember(v)
        if seen:
            return {"$": "ref", "id": oid}

        attrs = {}
        total = 0

        # vars() fails for objects with __slots__ and no __dict__, which is why
        # the slot pass below exists.
        try:
            raw = vars(v)
        except Exception:
            raw = None

        if isinstance(raw, dict):
            total += len(raw)
            try:
                for name, val in itertools.islice(raw.items(), self.max_items):
                    attrs[str(name)] = self._encode(val, depth + 1)
                    self._spend(16)
            except Exception:
                pass

        if len(attrs) < self.max_items:
            for slot in self._slots(type(v)):
                if slot in attrs:
                    continue
                if len(attrs) >= self.max_items:
                    break
                total += 1
                try:
                    val = getattr(v, slot)
                except AttributeError:
                    continue
                except Exception:
                    attrs[slot] = {"$": "opaque", "cls": "slot", "why": "access failed"}
                    continue
                attrs[slot] = self._encode(val, depth + 1)
                self._spend(16)

        out = {
            "$": "obj",
            "cls": type(v).__name__,
            "v": attrs,
            "n": total,
            "cut": total > len(attrs),
        }
        if oid is not None:
            out["id"] = oid
        return out

    def _slots(self, cls):
        # walk the mro so inherited slots are included. skip the two names every
        # slotted class gets for dict and weakref support.
        names = []
        for klass in getattr(cls, "__mro__", (cls,)):
            raw = getattr(klass, "__slots__", ())
            if isinstance(raw, str):
                raw = (raw,)
            try:
                for name in raw:
                    if name in ("__dict__", "__weakref__"):
                        continue
                    if name not in names:
                        names.append(name)
            except Exception:
                continue
        return names
