const bytes_prefix = 256;

// turns live javascript values into the json that goes in a recording. the
// whole thing is defensive: getters, proxies and huge structures are common in
// real code and none of them may throw or hang the recorder.
// note: function arguments themselves are collected by the instrumenter, not
// here, and it deliberately leaves out `arguments`.

class value_encoder {
  // defaults are also enforced by the recorder cli, but having them here makes
  // the encoder usable on its own.
  constructor(max_depth = 4, max_items = 100, max_string = 4096, max_value_bytes = 65536, max_seen = 10000) {
    this.max_depth = Math.max(0, max_depth);
    this.max_items = Math.max(1, max_items);
    this.max_string = Math.max(0, max_string);
    this.max_value_bytes = Math.max(0, max_value_bytes);
    this.max_seen = Math.max(1, max_seen);
    this.seen = new Map();
    this.next_id = 1;
    this.budget = 0;
  }

  encode(value) {
    // the byte budget is per value, not per recording, so one huge object can't
    // starve the ones after it. reset it every time.
    this.budget = this.max_value_bytes;
    try {
      return this.walk(value, 0);
    } catch (err) {
      return { $: "trunc", why: "error" };
    }
  }

  spend(n) {
    this.budget -= n;
  }

  remember(value) {
    // reference identity, not equality. that is what lets a shared node show up
    // as a ref instead of being printed twice.
    const hit = this.seen.get(value);
    if (hit) return [hit, true];
    if (this.seen.size >= this.max_seen) return [null, false];
    const id = this.next_id++;
    this.seen.set(value, id);
    return [id, false];
  }

  walk(value, depth) {
    // the switchboard. primitives first because they are cheap, then the
    // special built-ins, then containers, then plain objects as a catch-all.
    if (this.budget <= 0) return { $: "trunc", why: "bytes" };

    if (value === null) return null;
    if (value === true || value === false) return value;
    if (typeof value === "undefined") return { $: "undefined" };
    if (typeof value === "string") {
      this.spend(value.length);
      if (value.length > this.max_string) {
        return { $: "str", v: value.slice(0, this.max_string), n: value.length, cut: true };
      }
      return value;
    }
    if (typeof value === "number") {
      // json has no nan or infinity, so they get tagged strings.
      if (Number.isNaN(value)) return { $: "num", v: "nan" };
      if (!Number.isFinite(value)) return { $: "num", v: value > 0 ? "inf" : "-inf" };
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return { $: "int", v: String(value) };
      return value;
    }
    if (typeof value === "bigint") return { $: "int", v: String(value) };
    if (typeof value === "symbol") {
      return { $: "opaque", cls: "symbol", why: value.description || "symbol" };
    }
    if (typeof value === "function") {
      return { $: "fn", name: safe_name(value) };
    }

    // depth is checked after the primitives so a deeply nested scalar still
    // prints, and before any container so cycles can't run away.
    if (depth >= this.max_depth) return { $: "trunc", why: "depth" };

    // binary and runtime objects get their own small representations. none of
    // them are worth showing in full, but "this is a promise" is useful.
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return this.bytes(value);
    if (value instanceof ArrayBuffer) return this.bytes(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return this.bytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value instanceof Date) {
      let text = "invalid date";
      try {
        text = value.toISOString();
      } catch (err) {
        text = "invalid date";
      }
      return { $: "opaque", cls: "Date", why: text };
    }
    if (value instanceof Error) {
      return { $: "error", cls: safe_name(value.constructor), m: safe_message(value) };
    }
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
      return { $: "opaque", cls: safe_name(value.constructor), why: "runtime object" };
    }
    if (value instanceof RegExp) {
      return { $: "opaque", cls: "RegExp", why: "regular expression" };
    }

    if (Array.isArray(value)) return this.sequence(value, depth, "list");
    if (value instanceof Map) return this.map(value, depth);
    if (value instanceof Set) return this.set(value, depth);
    return this.object(value, depth);
  }

  bytes(value) {
    // keep a small prefix as base64 and report the real length. enough to see
    // a header, not enough to bloat the recording.
    const size = value.length;
    const part = value.subarray(0, bytes_prefix);
    this.spend(part.length);
    return {
      $: "bytes",
      v: Buffer.from(part).toString("base64"),
      n: size,
      cut: size > part.length,
    };
  }

  sequence(value, depth, kind) {
    // arrays and typed arrays. each element is guarded because a getter on an
    // index can throw.
    const [id, seen] = this.remember(value);
    if (seen) return { $: "ref", id };
    const n = safe_length(value);
    const items = [];
    for (let i = 0; i < value.length && i < this.max_items; i++) {
      if (this.budget <= 0) break;
      try {
        items.push(this.walk(value[i], depth + 1));
      } catch (err) {
        items.push({ $: "opaque", cls: "element", why: "access failed" });
      }
      this.spend(8);
    }
    const out = { $: kind, v: items, n: n === null ? items.length : n, cut: n !== null && n > items.length };
    if (id !== null) out.id = id;
    return out;
  }

  map(value, depth) {
    // encoded as a list of pairs so non-string keys survive.
    const [id, seen] = this.remember(value);
    if (seen) return { $: "ref", id };
    const pairs = [];
    let n = null;
    try {
      n = value.size;
    } catch (err) {
      n = null;
    }
    try {
      for (const [key, val] of value) {
        if (pairs.length >= this.max_items || this.budget <= 0) break;
        pairs.push([this.walk(key, depth + 1), this.walk(val, depth + 1)]);
        this.spend(16);
      }
    } catch (err) {
      return { $: "trunc", why: "error" };
    }
    const out = { $: "dict", v: pairs, n: n === null ? pairs.length : n, cut: n !== null && n > pairs.length };
    if (id !== null) out.id = id;
    return out;
  }

  set(value, depth) {
    // sets have no order, so what you see is whatever iteration gives us.
    const [id, seen] = this.remember(value);
    if (seen) return { $: "ref", id };
    const items = [];
    let n = null;
    try {
      n = value.size;
    } catch (err) {
      n = null;
    }
    try {
      for (const item of value) {
        if (items.length >= this.max_items || this.budget <= 0) break;
        items.push(this.walk(item, depth + 1));
        this.spend(8);
      }
    } catch (err) {
      return { $: "trunc", why: "error" };
    }
    const out = { $: "set", v: items, n: n === null ? items.length : n, cut: n !== null && n > items.length };
    if (id !== null) out.id = id;
    return out;
  }

  object(value, depth) {
    // plain objects and class instances. own enumerable keys only: inherited
    // properties would make every instance look enormous.
    const [id, seen] = this.remember(value);
    if (seen) return { $: "ref", id };

    let keys = [];
    let own = null;
    try {
      keys = Object.keys(value);
      own = keys.length;
    } catch (err) {
      return { $: "opaque", cls: safe_name(value.constructor), why: "keys failed" };
    }

    const attrs = {};
    let kept = 0;
    for (const key of keys) {
      if (kept >= this.max_items || this.budget <= 0) break;
      try {
        attrs[key] = this.walk(value[key], depth + 1);
      } catch (err) {
        attrs[key] = { $: "opaque", cls: "property", why: "access failed" };
      }
      kept++;
      this.spend(16);
    }

    const out = {
      $: "obj",
      cls: safe_name(value.constructor),
      v: attrs,
      n: own,
      cut: own > kept,
    };
    if (id !== null) out.id = id;
    return out;
  }
}

// the helpers below are wrapped in try/catch because they are called on values
// that came from the user's program, and those can do anything.
function safe_name(value) {
  try {
    return (value && value.name) || "anonymous";
  } catch (err) {
    return "anonymous";
  }
}

function safe_message(value) {
  try {
    return String(value.message).slice(0, 1000);
  } catch (err) {
    return "<unprintable>";
  }
}

function safe_length(value) {
  try {
    return value.length;
  } catch (err) {
    return null;
  }
}

module.exports = { value_encoder };
