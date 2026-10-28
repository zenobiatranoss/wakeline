"use strict";
// types and validation for the jsonl recording format. the recorders write
// these lines and the reader checks them, so this file is the contract between
// the two sides. keep it boring and explicit.
Object.defineProperty(exports, "__esModule", { value: true });
exports.format_error = void 0;
exports.parse_line = parse_line;
exports.check_version = check_version;
exports.validate_line = validate_line;
exports.short_value = short_value;
exports.value_text = value_text;
const supported_version = 1;
// a malformed or unsupported recording. reason is a short machine readable
// tag; the message has the line number so the reader can say where it gave up.
class format_error extends Error {
    constructor(reason, message, line = 0, byte = 0) {
        super(message);
        this.name = "format_error";
        this.reason = reason;
        this.line = line;
        this.byte = byte;
    }
}
exports.format_error = format_error;
function is_map(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
function need_string(line, key, at) {
    if (typeof line[key] !== "string" || !line[key]) {
        throw new format_error("shape", `line ${at[0]}: ${line.k} needs a ${key} string`, at[0], at[1]);
    }
}
function need_number(line, key, at) {
    if (typeof line[key] !== "number" || !Number.isFinite(line[key])) {
        throw new format_error("shape", `line ${at[0]}: ${line.k} needs a ${key} number`, at[0], at[1]);
    }
}
// one json object per line, no arrays and no scalars. a line without a kind is
// useless, so reject it here rather than at every use site.
function parse_line(text, line_no = 0, byte = 0) {
    let t = text;
    // strip BOM
    if (t.charCodeAt(0) === 0xfeff)
        t = t.slice(1);
    let v;
    try {
        v = JSON.parse(t);
    }
    catch {
        throw new format_error("json", `line ${line_no}: not valid json`, line_no, byte);
    }
    if (!is_map(v)) {
        throw new format_error("shape", `line ${line_no}: expected one json object`, line_no, byte);
    }
    if (typeof v.k !== "string" || !v.k) {
        throw new format_error("shape", `line ${line_no}: missing the k field`, line_no, byte);
    }
    return v;
}
// the first line must be a version. a newer recording is refused instead of
// being half understood. older positive versions are accepted because the
// reader only adds fields over time.
function check_version(line, line_no = 1) {
    if (line.k !== "ver") {
        throw new format_error("version", `line ${line_no}: recording does not start with a version line`, line_no);
    }
    const v = line.v;
    if (typeof v !== "number" || !Number.isInteger(v)) {
        throw new format_error("version", `line ${line_no}: recording version is not an integer`, line_no);
    }
    if (v < 1) {
        throw new format_error("version", `recording version ${v} is not supported`, line_no);
    }
    if (v > supported_version) {
        throw new format_error("version", `recording is version ${v}, this build understands up to version ${supported_version}`, line_no);
    }
    return v;
}
// shape check for every kind the reader knows. unknown kinds are allowed on
// purpose: a newer recorder can add markers without breaking an older reader.
function validate_line(line, line_no = 0, byte = 0) {
    const at = [line_no, byte];
    switch (line.k) {
        case "ver":
            throw new format_error("version", `line ${line_no}: the version line must come first`, line_no, byte);
        case "call_start":
            need_string(line, "i", at);
            need_string(line, "f", at);
            need_number(line, "l0", at);
            need_number(line, "l1", at);
            need_number(line, "dp", at);
            need_number(line, "t", at);
            if (!is_map(line.a)) {
                throw new format_error("shape", `line ${line_no}: call_start needs an a object`, line_no, byte);
            }
            return;
        case "line":
            need_string(line, "i", at);
            need_number(line, "s", at);
            need_number(line, "l", at);
            if (!is_map(line.v)) {
                throw new format_error("shape", `line ${line_no}: line needs a v object`, line_no, byte);
            }
            return;
        case "exception":
            need_string(line, "i", at);
            if (!is_map(line.x)) {
                throw new format_error("shape", `line ${line_no}: exception needs an x object`, line_no, byte);
            }
            return;
        case "call_end":
            need_string(line, "i", at);
            need_string(line, "o", at);
            need_number(line, "s", at);
            need_number(line, "ms", at);
            return;
        case "meta":
            need_string(line, "src", at);
            if (line.sm !== undefined)
                need_number(line, "sm", at);
            return;
        case "cap_hit":
            need_string(line, "r", at);
            if (line.i !== undefined)
                need_string(line, "i", at);
            return;
        case "truncated":
            need_string(line, "why", at);
            return;
        case "failure":
            need_string(line, "why", at);
            return;
        default:
            return;
    }
}
// the one line version for ghost text and summaries. the full value is still
// available for the hover.
function short_value(v, width = 60) {
    const s = value_text(v);
    if (s.length <= width)
        return s;
    return s.slice(0, Math.max(0, width - 3)) + "...";
}
// turn an encoded value back into something readable. this mirrors the tags
// the recorders write; anything unrecognised falls through to a generic form
// instead of throwing.
function value_text(v) {
    if (v === null)
        return "null";
    if (typeof v === "string")
        return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean")
        return String(v);
    if (!v || typeof v !== "object")
        return String(v);
    switch (v.$) {
        case "int":
            return String(v.v);
        case "num":
            return String(v.v);
        case "undefined":
            return "undefined";
        case "str":
            return JSON.stringify(v.v) + (v.cut ? ` ...(${v.n} chars)` : "");
        case "bytes":
            return `<${v.n} bytes>`;
        case "list": {
            const items = Array.isArray(v.v) ? v.v : [];
            const body = items.map((x) => value_text(x)).join(", ");
            return `[${body}${v.cut ? ", ..." : ""}]`;
        }
        case "dict": {
            const items = Array.isArray(v.v) ? v.v : [];
            const body = items
                .map((pair) => {
                const p = pair;
                return `${value_text(p[0])}: ${value_text(p[1])}`;
            })
                .join(", ");
            return `{${body}${v.cut ? ", ..." : ""}}`;
        }
        case "set": {
            const items = Array.isArray(v.v) ? v.v : [];
            return `{${items.map((x) => value_text(x)).join(", ")}${v.cut ? ", ..." : ""}}`;
        }
        case "obj": {
            const fields = is_map(v.v) ? v.v : {};
            const body = Object.keys(fields)
                .map((k) => `${k}: ${value_text(fields[k])}`)
                .join(", ");
            const cls = typeof v.cls === "string" ? v.cls : "object";
            return `${cls}{${body}${v.cut ? ", ..." : ""}}`;
        }
        case "ref":
            return `<ref ${v.id}>`;
        case "opaque":
            return `<${v.cls ?? "value"}>`;
        case "trunc":
            return `<cut: ${v.why ?? "limit"}>`;
        case "fn":
            return v.name ? `<fn ${v.name}>` : "<fn>";
        case "error":
            return `${v.cls ?? "error"}: ${v.m ?? ""}`;
        default:
            return `<${v.$}>`;
    }
}
