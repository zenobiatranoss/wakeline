import test from "node:test";
import assert from "node:assert/strict";
import { find_function_in_text } from "../src/text_find";

// tests for the regex based function finder. the fixtures here are strings
// instead of files so each case can be as small and weird as it needs to be.

const py = [
  "class store:", // 0
  "    def total(self, xs):", // 1
  "        return sum(xs)", // 2
  "", // 3
  "    async def load(self):", // 4
  "        return 1", // 5
  "", // 6
  "def top(n):", // 7
  "    def inner(x):", // 8
  "        return x + n", // 9
  "    return inner(2)", // 10
].join("\n");

const js = [
  "function plain(a) {", // 0
  "  return a;", // 1
  "}", // 2
  "", // 3
  "const twice = function (n) {", // 4
  "  return n * 2;", // 5
  "};", // 6
  "", // 7
  "const square = (n) => {", // 8
  "  return n * n;", // 9
  "};", // 10
  "", // 11
  "class cart {", // 12
  "  total(x) {", // 13
  "    return x;", // 14
  "  }", // 15
  "}", // 16
].join("\n");

test("python finds a method inside a class", () => {
  const hit = find_function_in_text(py, 2, "python");
  assert.ok(hit);
  assert.equal(hit.name, "store.total");
  assert.equal(hit.line0, 2);
});

test("python finds async methods and nested functions", () => {
  const load = find_function_in_text(py, 5, "python");
  assert.equal(load?.name, "store.load");
  const inner = find_function_in_text(py, 9, "python");
  assert.equal(inner?.name, "top.inner");
});

test("python returns null outside a function", () => {
  assert.equal(find_function_in_text(py, 6, "python"), null);
});

test("javascript finds declarations, expressions, arrows and methods", () => {
  assert.equal(find_function_in_text(js, 1, "javascript")?.name, "plain");
  assert.equal(find_function_in_text(js, 5, "javascript")?.name, "twice");
  assert.equal(find_function_in_text(js, 9, "javascript")?.name, "square");
  assert.equal(find_function_in_text(js, 14, "javascript")?.name, "cart.total");
});

test("javascript returns null outside a function", () => {
  assert.equal(find_function_in_text(js, 3, "javascript"), null);
});
