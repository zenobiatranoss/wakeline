import { short_value, value_text, type call_index, type encoded_value, type reader_event } from "./format";

// compares two calls step by step and returns the first place they disagree.
// the interesting answers are "different line", "same line, different value"
// and "same steps, different outcome". everything else is "no divergence".

export type divergence = {
  found: boolean;
  step: number;
  line: number;
  name: string;
  a?: encoded_value;
  b?: encoded_value;
  summary: string;
};

// ignore is a list of name patterns. a variable that changes on every run
// (a timestamp, a random id) can be filtered out so the real difference shows.
export function compare_calls(
  a: call_index,
  b: call_index,
  a_events: reader_event[],
  b_events: reader_event[],
  ignore: string[] = [],
): divergence {
  // only the common prefix can be compared position by position. after that
  // the only meaningful difference is that one call kept going.
  const n = Math.min(a_events.length, b_events.length);
  for (let i = 0; i < n; i++) {
    const x = a_events[i];
    const y = b_events[i];
    if (x.line !== y.line) {
      return {
        found: true,
        step: i,
        line: x.line,
        name: "",
        summary: `step ${i + 1}: left runs line ${x.line}, right runs line ${y.line}`,
      };
    }
    const keys = new Set([...Object.keys(x.values), ...Object.keys(y.values)]);
    for (const k of keys) {
      if (ignore.some((p) => matches(p, k))) continue;
      const xv = x.values[k];
      const yv = y.values[k];
      if (value_text(xv) === value_text(yv)) continue;
      return {
        found: true,
        step: i,
        line: x.line,
        name: k,
        a: xv,
        b: yv,
        summary: `same until line ${x.line}, then ${k} is ${short_value(xv, 30)} on the left and ${short_value(yv, 30)} on the right`,
      };
    }
  }
  // one side ended earlier. report the step where the other side continued.
  if (a_events.length !== b_events.length) {
    const longer = a_events.length > b_events.length ? a : b;
    const side = a_events.length > b_events.length ? "left" : "right";
    return {
      found: true,
      step: n,
      line: n < a_events.length ? a_events[n].line : b_events[n].line,
      name: "",
      summary: `the ${side} call keeps going after step ${n + 1}; the other one is ${longer === a ? b.outcome : a.outcome}`,
    };
  }
  // same line count and same values, but one returned and one threw. that is
  // still a divergence and worth pointing at.
  if (a.outcome !== b.outcome) {
    return {
      found: true,
      step: n,
      line: n ? a_events[n - 1].line : a.line0,
      name: "",
      summary: `the calls take the same steps, but one ${a.outcome === "throw" ? "threw" : "returned"} and the other ${b.outcome === "throw" ? "threw" : "returned"}`,
    };
  }
  return {
    found: false,
    step: -1,
    line: 0,
    name: "",
    summary: `no divergence in ${a_events.length} steps`,
  };
}

function matches(pattern: string, name: string) {
  // globs only, not full regex. a typo should not match half the variables.
  if (!pattern) return false;
  if (pattern.includes("*") || pattern.includes("?")) {
    const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return re.test(name);
  }
  return pattern === name;
}
