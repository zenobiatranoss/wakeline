import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { index_file, read_call_events } from "../src/recording_reader";
import { find_function_in_text } from "../src/text_find";

// end-to-end tests for the javascript recorder: write a fixture, run the cli,
// then read the recording back with the same reader the extension uses.

const root = path.resolve(__dirname, "../..");
const recorder = path.join(root, "recorders", "javascript", "wakeline_recorder.js");
const fixtures = path.join(root, "test", "fixtures", "javascript");

function lines_of(fixture: string) {
  return fs.readFileSync(path.join(fixtures, fixture), "utf8").split(/\r?\n/);
}

function run_named(t: { after: (fn: () => void) => void }, fixture: string, name: string, line: number, extra: string[] = []) {
  // the test picks fixtures by line number, so first ask the text scanner where
  // the function is, exactly like the extension would.
  const found = find_function_in_text(lines_of(fixture).join("\n"), line - 1, "javascript");
  assert.ok(found, `no function at ${fixture}:${line}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_js_"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "rec.jsonl");
  const run = spawnSync(
    process.execPath,
    [
      recorder,
      "--file",
      path.join(fixtures, fixture),
      "--name",
      name,
      "--lines",
      `${found.line0}:${found.line1}`,
      "--out",
      out,
      ...extra,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return { out };
}

test("simple commonjs function records arguments, locals and result", async (t) => {
  const rec = run_named(t, "simple.js", "add", 2);
  const index = await index_file(rec.out);
  assert.equal(index.calls.length, 1);
  const call = index.calls[0];
  assert.equal(call.name, "add");
  assert.deepEqual(call.args, { a: 2, b: 3 });
  assert.equal(call.outcome, "return");
  assert.equal(call.result, 5);

  const events = await read_call_events(rec.out, call);
  assert.deepEqual(events.map((ev) => ev.line), [2, 3]);
  assert.deepEqual(events[1].values, { a: 2, b: 3, total: 5 });
});

test("function expression, arrow and method all record", async (t) => {
  const twice = run_named(t, "kinds.js", "twice", 2);
  const twice_index = await index_file(twice.out);
  assert.equal(twice_index.calls[0].name, "twice");
  assert.deepEqual(twice_index.calls[0].args, { n: 3 });
  assert.equal(twice_index.calls[0].result, 6);

  const square = run_named(t, "kinds.js", "square", 5);
  const square_index = await index_file(square.out);
  assert.equal(square_index.calls[0].result, 16);

  const add = run_named(t, "kinds.js", "counter.add", 12);
  const add_index = await index_file(add.out);
  assert.equal(add_index.calls[0].name, "counter.add");
  assert.deepEqual(add_index.calls[0].args, { n: 2 });
  assert.equal(add_index.calls[0].result, 3);
});

test("recursion gets separate call ids and depths", async (t) => {
  const rec = run_named(t, "kinds.js", "fact", 27);
  const index = await index_file(rec.out);
  assert.deepEqual(index.calls.map((c) => c.depth), [0, 1, 2]);
  assert.deepEqual(index.calls.map((c) => c.args.n), [3, 2, 1]);
  assert.deepEqual(index.calls.map((c) => c.result), [6, 2, 1]);
});

test("a thrown error does not escape the recording", async (t) => {
  const rec = run_named(t, "throw.js", "divide", 2);
  const index = await index_file(rec.out);
  const call = index.calls[0];
  assert.equal(call.outcome, "throw");
  assert.equal(call.result, undefined);
  const exc = call.exception as { t: string; m: string };
  assert.equal(exc.t, "Error");
  assert.equal(exc.m, "no zero");
});

// a resume must not start a second call. there should be exactly one call id
// even though the function suspends in the middle.
test("async and generator calls finish under one id", async (t) => {
  const wait = run_named(t, "kinds.js", "wait", 34);
  const wait_index = await index_file(wait.out);
  assert.equal(wait_index.calls.length, 1);
  assert.equal(wait_index.calls[0].outcome, "return");
  assert.equal(wait_index.calls[0].result, 3);

  const count = run_named(t, "kinds.js", "count", 39);
  const count_index = await index_file(count.out);
  assert.equal(count_index.calls.length, 1);
  assert.equal(count_index.calls[0].result && (count_index.calls[0].result as { $?: string }).$, "undefined");
  const events = await read_call_events(count.out, count_index.calls[0]);
  assert.ok(events.length >= 4);
});

test("integers past the safe range keep the int shape", async (t) => {
  const rec = run_named(t, "big.js", "big", 1);
  const index = await index_file(rec.out);
  assert.deepEqual(index.calls[0].result, { $: "int", v: "9007199254740992" });
});

test("a path with spaces and non-ascii characters records", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline spaced "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "são paulo.js");
  fs.copyFileSync(path.join(fixtures, "simple.js"), file);
  const out = path.join(dir, "rec with space.jsonl");
  const run = spawnSync(
    process.execPath,
    [recorder, "--file", file, "--name", "add", "--lines", "1:4", "--out", out],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const index = await index_file(out);
  assert.equal(index.calls[0].result, 5);
});

test("esm modules are instrumented through the loader", async (t) => {
  const rec = run_named(t, "esm.mjs", "add", 2);
  const index = await index_file(rec.out);
  assert.equal(index.calls.length, 1);
  assert.equal(index.calls[0].result, 5);
  assert.deepEqual(index.calls[0].args, { a: 2, b: 3 });
});

// three nasty values in one test because they all exercise the same promise:
// the encoder survives whatever the program hands it.
test("cycles, bad getters and huge arrays are bounded", async (t) => {
  const cycle = run_named(t, "cycle.js", "cycle", 1);
  const cycle_index = await index_file(cycle.out);
  const cycle_events = await read_call_events(cycle.out, cycle_index.calls[0]);
  const refs = cycle_events.flatMap((ev) => Object.values(ev.values)).filter((v) => {
    return !!v && typeof v === "object" && "$" in v && (v as { $: string }).$ === "ref";
  });
  assert.ok(refs.length > 0);

  const getter = run_named(t, "getter.js", "take", 8);
  const getter_index = await index_file(getter.out);
  const getter_events = await read_call_events(getter.out, getter_index.calls[0]);
  const getter_values = [
    ...Object.values(getter_index.calls[0].args),
    ...getter_events.flatMap((ev) => Object.values(ev.values)),
  ];
  const masked = getter_values.filter((v) => {
    return !!v && typeof v === "object" && "$" in v && (v as { $: string }).$ === "obj";
  });
  assert.ok(masked.length > 0);

  const huge = run_named(t, "huge.js", "size", 1);
  const huge_index = await index_file(huge.out);
  const xs = huge_index.calls[0].args.xs as { $: string; n: number; cut: boolean; v: unknown[] };
  assert.equal(xs.$, "list");
  assert.equal(xs.n, 100000);
  assert.equal(xs.cut, true);
  assert.equal(xs.v.length, 100);
});

test("max calls stops after the limit and flags it", async (t) => {
  const rec = run_named(t, "cap.js", "spin", 1, ["--max-calls", "2"]);
  const index = await index_file(rec.out);
  assert.equal(index.calls.length, 2);
  assert.ok(index.caps.includes("max_calls"));
  assert.ok(index.calls.every((c) => c.outcome === "return"));
});

test("masked names keep the key but hide the value", async (t) => {
  const rec = run_named(t, "simple.js", "add", 2, ["--mask", "a"]);
  const index = await index_file(rec.out);
  const a = index.calls[0].args.a as { $: string; cls: string };
  assert.equal(a.$, "opaque");
  assert.equal(a.cls, "masked");
  assert.equal(index.calls[0].args.b, 3);
});

// the recorder must never change what the program prints, and statements
// without braces are where a rewrite is easiest to get wrong.
function same_output(t: { after: (fn: () => void) => void }, fixture: string, name: string, lines: string) {
  const file = path.join(fixtures, fixture);
  const plain = spawnSync(process.execPath, [file], { encoding: "utf8" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_js_"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "rec.jsonl");
  const rec = spawnSync(
    process.execPath,
    [recorder, "--file", file, "--name", name, "--lines", lines, "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(rec.stdout, plain.stdout, `${name} changed the program output`);
  return out;
}

test("braceless if, else if, loops and labels keep the program's behavior", async (t) => {
  for (const [name, lines] of [
    ["classify", "1:5"],
    ["chain", "7:17"],
    ["nested", "19:22"],
    ["labeled", "24:34"],
  ]) {
    const out = same_output(t, "braceless.js", name, lines);
    const index = await index_file(out);
    assert.equal(index.failure, null, `${name}: ${index.failure}`);
    assert.ok(index.calls.length > 0, `${name} recorded no calls`);
  }
});

test("a mix of statement shapes records without a failure", async (t) => {
  const out = same_output(t, "shapes.js", "shapes", "1:21");
  const index = await index_file(out);
  assert.equal(index.failure, null, String(index.failure));
  assert.equal(index.calls.length, 5);
});
