import test from "node:test";
import assert from "node:assert/strict";
import { compare_calls } from "../src/compare";
import type { call_index, encoded_value, reader_event } from "../src/format";

// unit tests for the compare logic. no files and no vscode, just two synthetic
// event lists and a verdict.

function call(id: string, outcome = "return"): call_index {
  return {
    id,
    name: "add",
    line0: 1,
    line1: 3,
    depth: 0,
    args: {},
    start: 0,
    start_line: 1,
    end_offset: 0,
    end_line: 1,
    outcome,
    steps: 0,
    ms: 0,
    cap: "none",
  };
}

// shorthand for one line event. most tests only care about line and values.
function ev(step: number, line: number, values: Record<string, encoded_value> = {}): reader_event {
  return { kind: "line", step, line, values };
}

test("identical calls do not diverge", () => {
  const a = [ev(0, 2, { x: 1 }), ev(1, 3, { x: 1 })];
  const b = [ev(0, 2, { x: 1 }), ev(1, 3, { x: 1 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b);
  assert.equal(diff.found, false);
  assert.match(diff.summary, /no divergence/);
});

test("the first different line wins", () => {
  const a = [ev(0, 2, { x: 1 }), ev(1, 3, { x: 1 })];
  const b = [ev(0, 2, { x: 1 }), ev(1, 4, { x: 1 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b);
  assert.equal(diff.found, true);
  assert.equal(diff.step, 1);
  assert.equal(diff.line, 3);
});

test("a different value on the same line is reported with both sides", () => {
  const a = [ev(0, 2, { x: 1 })];
  const b = [ev(0, 2, { x: 2 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b);
  assert.equal(diff.found, true);
  assert.equal(diff.name, "x");
  assert.equal(diff.a, 1);
  assert.equal(diff.b, 2);
  assert.match(diff.summary, /line 2/);
});

test("ignored names do not count as a difference", () => {
  const a = [ev(0, 2, { x: 1, now: 10 })];
  const b = [ev(0, 2, { x: 1, now: 20 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b, ["now", "tmp*"]);
  assert.equal(diff.found, false);
});

test("different lengths point at the shorter call", () => {
  const a = [ev(0, 2, { x: 1 }), ev(1, 3, { x: 1 })];
  const b = [ev(0, 2, { x: 1 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b);
  assert.equal(diff.found, true);
  assert.equal(diff.step, 1);
  assert.match(diff.summary, /keeps going/);
});

test("same steps but different outcome still diverges", () => {
  const a = [ev(0, 2, { x: 1 })];
  const b = [ev(0, 2, { x: 1 })];
  const diff = compare_calls(call("c1", "return"), call("c2", "throw"), a, b);
  assert.equal(diff.found, true);
  assert.match(diff.summary, /threw/);
});

test("loops with different iteration counts diverge at the extra step", () => {
  const loop = (n: number) => Array.from({ length: n }, (_, i) => ev(i, 3, { i }));
  const diff = compare_calls(call("c1"), call("c2"), loop(4), loop(3));
  assert.equal(diff.found, true);
  assert.equal(diff.step, 3);
  assert.match(diff.summary, /keeps going/);
});

test("recursion with a different base case shows the first different line", () => {
  const a = [ev(0, 2, { n: 3 }), ev(1, 3, { n: 3 }), ev(2, 4, { n: 3 })];
  const b = [ev(0, 2, { n: 3 }), ev(1, 3, { n: 3 }), ev(2, 5, { n: 3 })];
  const diff = compare_calls(call("c1"), call("c2"), a, b);
  assert.equal(diff.found, true);
  assert.equal(diff.step, 2);
  assert.equal(diff.line, 4);
});
