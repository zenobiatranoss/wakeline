import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { check_version, format_error, parse_line, validate_line } from "../src/format";
import { index_file, read_call_events } from "../src/recording_reader";

// tests for the recording format and the incremental reader. most of these
// build a tiny jsonl file in a temp folder and assert what index_file makes of
// it. no recorder involved, which keeps failures pointed at the reader.

type cleaner = { after: (fn: () => void) => void };

const ver = { k: "ver", v: 1 };

function make_file(t: cleaner, lines: unknown[]) {
  return make_text(t, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function make_text(t: cleaner, text: string) {
  // every test gets its own temp folder and the node test runner removes it on
  // the way out, even when an assertion fails.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_"));
  const file = path.join(dir, "rec.jsonl");
  fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

// a complete enough call_start that only the parts a test changes need to be
// written out.
function call_start(id: string, extra: Record<string, unknown> = {}) {
  return {
    k: "call_start",
    i: id,
    f: "sample.add",
    l0: 1,
    l1: 3,
    dp: 0,
    a: { a: 2, b: 3 },
    t: 1700000000000,
    ...extra,
  };
}

function line_event(id: string, step: number, line: number, values: Record<string, unknown> = {}) {
  return { k: "line", i: id, s: step, l: line, v: values };
}

function call_end(id: string, extra: Record<string, unknown> = {}) {
  return { k: "call_end", i: id, s: 1, o: "return", r: 5, ms: 1, c: "none", ...extra };
}

function is_format(reason: string) {
  // assertion helper: the error must be a format_error with this exact reason.
  return (err: unknown) => err instanceof format_error && err.reason === reason;
}

test("parse_line rejects broken and non object lines", () => {
  assert.throws(() => parse_line("not json", 4), is_format("json"));
  assert.throws(() => parse_line("[1,2]", 2), is_format("shape"));
  assert.throws(() => parse_line("{}", 3), is_format("shape"));
  assert.deepEqual(parse_line('{"k":"line"}', 1), { k: "line" });
});

test("version check accepts 1 and refuses newer or older files", () => {
  assert.equal(check_version(ver), 1);
  assert.throws(() => check_version({ k: "ver", v: 2 }), is_format("version"));
  assert.throws(() => check_version({ k: "ver", v: 2 }), /version 2.*version 1/);
  assert.throws(() => check_version({ k: "ver", v: 0 }), is_format("version"));
  assert.throws(() => check_version({ k: "ver", v: "1" }), is_format("version"));
  assert.throws(() => check_version({ k: "line" }), is_format("version"));
});

test("a leading blank line does not skip the version check", async (t) => {
  const ok = make_text(t, "\n" + JSON.stringify(ver) + "\n" + JSON.stringify(call_start("c1")) + "\n");
  const index = await index_file(ok);
  assert.equal(index.version, 1);
  assert.equal(index.calls.length, 1);

  const bad = make_text(t, "\n\n" + JSON.stringify({ k: "ver", v: 9 }) + "\n");
  await assert.rejects(index_file(bad), is_format("version"));
});

test("known line kinds are validated, unknown kinds pass", () => {
  assert.doesNotThrow(() => validate_line(call_start("c1")));
  assert.throws(() => validate_line({ k: "call_start", i: "c1" }, 2), is_format("shape"));
  assert.throws(() => validate_line({ k: "line", i: "c1", s: 0, l: 2, v: [] }, 3), is_format("shape"));
  assert.throws(() => validate_line({ k: "call_end", i: "c1", o: "return" }, 4), is_format("shape"));
  assert.throws(() => validate_line({ k: "failure" }, 5), is_format("shape"));
  assert.doesNotThrow(() => validate_line({ k: "something_new", x: 1 }));
  assert.throws(() => validate_line({ k: "ver", v: 1 }, 6), is_format("version"));
});

test("index reads a simple recording", async (t) => {
  const file = make_file(t, [
    ver,
    call_start("c1"),
    line_event("c1", 0, 2, { a: 2, b: 3 }),
    line_event("c1", 1, 3, { a: 2, b: 3, total: 5 }),
    call_end("c1"),
  ]);

  const index = await index_file(file);
  assert.equal(index.version, 1);
  assert.equal(index.calls.length, 1);
  assert.deepEqual(index.interrupted, []);
  assert.deepEqual(index.caps, []);
  assert.equal(index.failure, null);
  assert.equal(index.incomplete, false);

  const call = index.calls[0];
  assert.equal(call.id, "c1");
  assert.equal(call.name, "sample.add");
  assert.equal(call.args.a, 2);
  assert.equal(call.outcome, "return");
  assert.equal(call.result, 5);
  assert.equal(call.steps, 1);
  assert.equal(call.depth, 0);
  assert.equal(call.start_line, 2);
  assert.equal(call.end_line, 5);

  const events = await read_call_events(file, call);
  assert.deepEqual(events.map((ev) => [ev.kind, ev.step, ev.line]), [
    ["line", 0, 2],
    ["line", 1, 3],
  ]);
  assert.deepEqual(events[1].values, { a: 2, b: 3, total: 5 });
});

test("the meta header is validated and exposed", async (t) => {
  const file = make_file(t, [
    ver,
    { k: "meta", src: "/tmp/sample.py", sm: 1700000000000 },
    call_start("c1"),
    call_end("c1"),
  ]);

  const index = await index_file(file);
  assert.equal(index.source, "/tmp/sample.py");
  assert.equal(index.source_mtime, 1700000000000);
  assert.equal(index.unknown_lines, 0);

  assert.throws(() => validate_line({ k: "meta" }, 2), is_format("shape"));
  assert.throws(() => validate_line({ k: "meta", src: "x", sm: "y" }, 2), is_format("shape"));
  assert.doesNotThrow(() => validate_line({ k: "meta", src: "x" }));
});

test("an interrupted call is kept and readable", async (t) => {
  const file = make_file(t, [ver, call_start("c1"), line_event("c1", 0, 2, { a: 2 })]);
  const index = await index_file(file);
  assert.deepEqual(index.interrupted, ["c1"]);
  assert.equal(index.calls[0].outcome, "running");
  assert.equal(index.calls[0].end_offset, fs.statSync(file).size);

  const events = await read_call_events(file, index.calls[0]);
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 2);
});

test("a half written last line is dropped and flagged", async (t) => {
  const text = JSON.stringify(ver) + "\n" + JSON.stringify(call_start("c1")) + "\n" + '{"k":"line","i":"c1"';
  const file = make_text(t, text);
  const index = await index_file(file);
  assert.equal(index.incomplete, true);
  assert.equal(index.calls.length, 1);
  assert.deepEqual(index.interrupted, ["c1"]);
  assert.equal(index.calls[0].end_offset, Buffer.byteLength(text) - Buffer.byteLength('{"k":"line","i":"c1"'));
});

test("a newer recording is refused with both versions in the message", async (t) => {
  const file = make_file(t, [{ k: "ver", v: 2 }, call_start("c1")]);
  await assert.rejects(index_file(file), (err: unknown) => {
    assert.ok(err instanceof format_error);
    assert.equal(err.reason, "version");
    assert.match(err.message, /version 2/);
    assert.match(err.message, /version 1/);
    return true;
  });
});

test("broken json names the line", async (t) => {
  const file = make_text(t, JSON.stringify(ver) + "\n{\n");
  await assert.rejects(index_file(file), (err: unknown) => {
    assert.ok(err instanceof format_error);
    assert.equal(err.reason, "json");
    assert.equal(err.line, 2);
    return true;
  });
});

test("an empty recording, a bad version line and duplicate ids fail", async (t) => {
  const empty = make_text(t, "");
  await assert.rejects(index_file(empty), is_format("version"));

  const no_version = make_file(t, [call_start("c1")]);
  await assert.rejects(index_file(no_version), is_format("version"));

  const twice = make_file(t, [ver, call_start("c1"), call_start("c1")]);
  await assert.rejects(index_file(twice), /appears twice/);
});

test("events for a call that was never started fail", async (t) => {
  const file = make_file(t, [ver, line_event("c9", 0, 2)]);
  await assert.rejects(index_file(file), /unknown call c9/);
});

test("cap, failure and unknown lines are collected, not fatal", async (t) => {
  const file = make_file(t, [
    ver,
    { k: "future_kind", detail: true },
    { k: "cap_hit", r: "max_calls", s: 0, b: 10 },
    { k: "cap_hit", r: "max_bytes", s: 0, b: 10 },
    { k: "failure", why: "disk is full", where: "write" },
    { k: "truncated", i: "c1", s: 4, why: "bytes" },
    call_start("c1"),
    call_end("c1", { c: "max_events" }),
  ]);

  const index = await index_file(file);
  assert.equal(index.unknown_lines, 1);
  assert.equal(index.truncated_lines, 1);
  assert.deepEqual(index.caps, ["max_calls", "max_bytes"]);
  assert.equal(index.failure, "disk is full");
  assert.equal(index.calls[0].cap, "max_events");
});

test("crlf files parse and read the same", async (t) => {
  const lines = [ver, call_start("c1"), line_event("c1", 0, 2), call_end("c1")];
  const file = make_text(t, lines.map((line) => JSON.stringify(line)).join("\r\n") + "\r\n");
  const index = await index_file(file);
  assert.equal(index.calls.length, 1);
  const events = await read_call_events(file, index.calls[0]);
  assert.equal(events.length, 1);
  assert.equal(events[0].line, 2);
});

test("nested calls do not leak events into their parent", async (t) => {
  const file = make_file(t, [
    ver,
    call_start("c1"),
    line_event("c1", 0, 2),
    call_start("c2", { dp: 1, a: { n: 1 } }),
    line_event("c2", 0, 2),
    call_end("c2", { r: 1 }),
    line_event("c1", 1, 3),
    call_end("c1"),
  ]);
  const index = await index_file(file);
  const parent = index.calls.find((call) => call.id === "c1");
  const child = index.calls.find((call) => call.id === "c2");
  assert.ok(parent && child);

  const parent_events = await read_call_events(file, parent);
  assert.deepEqual(parent_events.map((ev) => ev.step), [0, 1]);
  const child_events = await read_call_events(file, child);
  assert.deepEqual(child_events.map((ev) => ev.step), [0]);
});

// the reader reads in 64k chunks, so this one is specifically about lines that
// straddle a chunk boundary.
test("a recording larger than one read chunk indexes and reads", async (t) => {
  const total = 3000;
  const lines: unknown[] = [ver, call_start("c1", { a: { xs: "x".repeat(40) } })];
  for (let i = 0; i < total; i++) {
    lines.push(line_event("c1", i, 2, { i, note: "payload".repeat(4) }));
  }
  lines.push(call_end("c1", { s: total - 1 }));
  const file = make_file(t, lines);
  assert.ok(fs.statSync(file).size > 64 * 1024);

  const index = await index_file(file);
  assert.equal(index.calls.length, 1);
  const events = await read_call_events(file, index.calls[0]);
  assert.equal(events.length, total);
  assert.equal(events[0].step, 0);
  assert.equal(events[total - 1].step, total - 1);
});

// and one cross-check against the real python recorder, so the two languages
// can't drift apart without a test noticing.
test("a recording from the python recorder validates", async (t) => {
  const python = process.env.wakeline_python ?? "python3";
  const probe = spawnSync(python, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip(`${python} is not available`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "rec.jsonl");
  const fixture = path.resolve(__dirname, "../../test/fixtures/python/simple.py");
  const recorder = path.resolve(__dirname, "../../recorders/python/wakeline_recorder.py");
  const run = spawnSync(
    python,
    [recorder, "--file", fixture, "--name", "add", "--lines", "1:3", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);

  const index = await index_file(out);
  assert.equal(index.calls.length, 1);
  const call = index.calls[0];
  assert.equal(call.name, "add");
  assert.deepEqual(call.args, { a: 2, b: 3 });
  assert.equal(call.result, 5);
  assert.equal(call.outcome, "return");

  const events = await read_call_events(out, call);
  assert.equal(events.length, 2);
  assert.equal(events[1].values.total, 5);
});
