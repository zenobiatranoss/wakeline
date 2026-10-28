"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.max_events_in_memory = void 0;
exports.index_file = index_file;
exports.read_call_events = read_call_events;
const fsp = __importStar(require("fs/promises"));
const format_1 = require("./format");
// the incremental reader. the file can be much larger than memory, so indexing
// walks it in fixed chunks and remembers byte offsets; reading one call then
// seeks straight to its slice. a half-written last line is normal (the program
// may still be running) and is not treated as corruption.
const chunk_size = 64 * 1024;
const max_line_bytes = 4 * 1024 * 1024;
exports.max_events_in_memory = 50_000;
function text_of(buf) {
    // strip UTF-8 BOM if present
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        buf = buf.subarray(3);
    }
    return buf.toString("utf8").replace(/\r$/, "");
}
// read the whole file once and build the call list. this is the only pass that
// touches every byte; after this the timeline only reads the selected call.
async function index_file(file) {
    const fh = await fsp.open(file, "r");
    const calls = [];
    const by_id = new Map();
    const caps = new Set();
    let version = 0;
    let failure = null;
    let source;
    let source_mtime;
    let unknown_lines = 0;
    let truncated_lines = 0;
    let saw_version = false;
    let line_no = 0;
    let carry = Buffer.alloc(0);
    let carry_at = 0;
    let total = 0;
    // one complete line. start is its byte offset, which is what makes a later
    // read of just this call possible.
    function handle(raw, start) {
        const text = text_of(raw);
        line_no += 1;
        if (!text.trim())
            return;
        const line = (0, format_1.parse_line)(text, line_no, start);
        if (!saw_version) {
            version = (0, format_1.check_version)(line, line_no);
            saw_version = true;
            return;
        }
        (0, format_1.validate_line)(line, line_no, start);
        if (line.k === "call_start") {
            const id = String(line.i);
            if (by_id.has(id)) {
                throw new format_1.format_error("shape", `line ${line_no}: call id ${id} appears twice`, line_no, start);
            }
            const call = {
                id,
                name: String(line.f),
                line0: Number(line.l0),
                line1: Number(line.l1),
                depth: Number(line.dp),
                args: line.a,
                start,
                start_line: line_no,
                end_offset: start,
                end_line: 0,
                outcome: "running",
                steps: -1,
                ms: 0,
                cap: "none",
            };
            calls.push(call);
            by_id.set(id, call);
            return;
        }
        if (line.k === "meta") {
            source = String(line.src);
            if (line.sm !== undefined)
                source_mtime = Number(line.sm);
            return;
        }
        if (line.k === "cap_hit") {
            caps.add(String(line.r));
            return;
        }
        if (line.k === "failure") {
            if (!failure)
                failure = String(line.why);
            return;
        }
        if (line.k === "truncated") {
            truncated_lines += 1;
            return;
        }
        if (line.k === "line" || line.k === "exception" || line.k === "call_end") {
            const call = by_id.get(String(line.i));
            if (!call) {
                throw new format_1.format_error("shape", `line ${line_no}: event for unknown call ${line.i}`, line_no, start);
            }
            if (line.k === "call_end") {
                // +1 for the newline eaten by the splitter
                call.end_offset = start + raw.length + 1;
                call.end_line = line_no;
                call.outcome = String(line.o);
                call.steps = Number(line.s);
                call.result = line.r;
                call.exception = line.x;
                call.ms = Number(line.ms);
                call.cap = line.c === undefined ? "none" : String(line.c);
            }
            return;
        }
        unknown_lines += 1;
    }
    try {
        for (;;) {
            const buf = Buffer.alloc(chunk_size);
            const { bytesRead } = await fh.read(buf, 0, chunk_size, null);
            if (!bytesRead)
                break;
            total += bytesRead;
            const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
            let at = 0;
            for (;;) {
                const nl = data.indexOf(10, at);
                if (nl < 0)
                    break;
                handle(data.subarray(at, nl), carry_at + at);
                at = nl + 1;
            }
            carry = Buffer.from(data.subarray(at));
            carry_at += at;
            if (carry.length > max_line_bytes) {
                throw new format_1.format_error("shape", `line ${line_no + 1}: line is longer than ${max_line_bytes} bytes`, line_no + 1, carry_at);
            }
        }
    }
    finally {
        await fh.close();
    }
    if (!saw_version)
        throw new format_1.format_error("version", "recording is empty");
    // no newline at the end means the recorder was killed mid-line. the bytes
    // before it are still good, so keep the index and flag the file as incomplete.
    const incomplete = carry.length > 0;
    const valid_end = total - carry.length;
    // a call without call_end was cut off; its events stop at the readable end
    const interrupted = [];
    for (const call of calls) {
        if (call.outcome === "running") {
            interrupted.push(call.id);
            call.end_offset = valid_end;
        }
    }
    return {
        path: file,
        version,
        source,
        source_mtime,
        calls,
        bytes: total,
        interrupted,
        caps: [...caps],
        failure,
        unknown_lines,
        truncated_lines,
        incomplete,
    };
}
// read only the byte range owned by one call. nested calls live inside that
// range too, so events are filtered by id.
async function read_call_events(file, call) {
    const events = [];
    const fh = await fsp.open(file, "r");
    const start = call.start;
    const stop = Math.max(call.end_offset, start);
    let pos = start;
    let line_no = Math.max(0, call.start_line - 1);
    let carry = Buffer.alloc(0);
    // same line parsing as the index pass, but only the kinds the timeline can
    // draw. everything else in the range belongs to another call or a marker.
    function add_event(raw, at) {
        const text = text_of(raw);
        line_no += 1;
        if (!text.trim())
            return;
        const line = (0, format_1.parse_line)(text, line_no, at);
        (0, format_1.validate_line)(line, line_no, at);
        if (line.i !== call.id)
            return;
        if (line.k === "line") {
            events.push({
                kind: "line",
                step: Number(line.s),
                line: Number(line.l),
                values: line.v,
            });
            return;
        }
        if (line.k === "exception") {
            // exceptions have no step of their own; attach them to the last line event
            const last = events.length ? events[events.length - 1] : undefined;
            events.push({
                kind: "exception",
                step: last ? last.step : 0,
                line: last ? last.line : call.line0,
                values: {},
                exception: line.x,
            });
        }
    }
    try {
        while (pos < stop) {
            const want = Math.min(chunk_size, stop - pos);
            const buf = Buffer.alloc(want);
            const { bytesRead } = await fh.read(buf, 0, want, pos);
            if (!bytesRead)
                break;
            const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
            let at = 0;
            for (;;) {
                const nl = data.indexOf(10, at);
                if (nl < 0)
                    break;
                add_event(data.subarray(at, nl), pos - carry.length + at);
                at = nl + 1;
                // a hard ceiling even if the file has more. the page can only show so
                // much, and a runaway recording should not exhaust the extension host.
                if (events.length >= exports.max_events_in_memory)
                    return events;
            }
            pos += bytesRead;
            carry = Buffer.from(data.subarray(at));
            if (carry.length > max_line_bytes) {
                throw new format_1.format_error("shape", `line ${line_no + 1}: line is longer than ${max_line_bytes} bytes`, line_no + 1, pos - carry.length);
            }
        }
        if (carry.length)
            add_event(carry, pos - carry.length);
    }
    finally {
        await fh.close();
    }
    return events;
}
