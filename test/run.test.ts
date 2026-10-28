import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { find_executable, kill_all, start_recording, type run_options } from "../src/run";

// tests for the process launcher. these actually spawn the recorder, so they
// are slower than the pure unit tests but cover the thing most likely to break
// on another machine: finding an interpreter and killing it again.

const root = path.resolve(__dirname, "../..");

// every test gets its own output file in a temp folder.
function opts(t: { after: (fn: () => void) => void }, extra: Partial<run_options> = {}): run_options {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_run_"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    language: "javascript",
    file: path.join(root, "test", "fixtures", "javascript", "simple.js"),
    name: "add",
    line0: 1,
    line1: 3,
    out: path.join(dir, "rec.jsonl"),
    cwd: root,
    caps: { max_calls: 10, max_events: 100, max_bytes: 1024 * 1024 },
    timeout: 5000,
    command: process.execPath,
    extra_args: "",
    extension_root: path.join(root, "test", "fixtures", "run_root"),
    masked: [],
    ...extra,
  };
}

// tiny poll helper. node has no built in sleep, and waiting on real process
// events is more code than this test needs.
async function wait_for(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out waiting for output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("find_executable accepts an absolute path and a bare name", () => {
  assert.equal(find_executable(process.execPath, []), process.execPath);
  assert.ok(find_executable("node", []));
  assert.equal(find_executable(path.join(os.tmpdir(), "no-such-binary-here"), []), null);
});

test("a missing command is refused before spawn", (t) => {
  assert.throws(() => start_recording(opts(t, { command: "" }), () => {}), /no node found/);
});

test("a finished run keeps the program's exit code and output", async (t) => {
  const o = opts(t, { extra_args: '"a b" c' });
  let text = "";
  const run = start_recording(o, (chunk) => (text += chunk));
  const result = await run.done;
  assert.equal(result.code, 3);
  assert.equal(result.cancelled, false);
  assert.equal(result.timed_out, false);
  assert.match(text, /hello from fake/);
  assert.deepEqual(JSON.parse(fs.readFileSync(o.out + ".args", "utf8")), ["a b", "c"]);
});

test("cancel kills the recorder and reports it", async (t) => {
  const o = opts(t, { extra_args: "slow" });
  let text = "";
  const run = start_recording(o, (chunk) => (text += chunk));
  await wait_for(() => text.includes("hello from fake"));
  run.cancel();
  const result = await run.done;
  assert.equal(result.cancelled, true);
  assert.equal(result.timed_out, false);
});

test("the timeout kills a program that never exits", async (t) => {
  const o = opts(t, { extra_args: "slow", timeout: 100 });
  const run = start_recording(o, () => {});
  const result = await run.done;
  assert.equal(result.timed_out, true);
  assert.equal(result.cancelled, false);
});

test.after(() => kill_all());
