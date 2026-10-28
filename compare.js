"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compare_calls = compare_calls;
const format_1 = require("./format");
// ignore is a list of name patterns. a variable that changes on every run
// (a timestamp, a random id) can be filtered out so the real difference shows.
function compare_calls(a, b, a_events, b_events, ignore = []) {
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
            if (ignore.some((p) => matches(p, k)))
                continue;
            const xv = x.values[k];
            const yv = y.values[k];
            if ((0, format_1.value_text)(xv) === (0, format_1.value_text)(yv))
                continue;
            return {
                found: true,
                step: i,
                line: x.line,
                name: k,
                a: xv,
                b: yv,
                summary: `same until line ${x.line}, then ${k} is ${(0, format_1.short_value)(xv, 30)} on the left and ${(0, format_1.short_value)(yv, 30)} on the right`,
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
function matches(pattern, name) {
    // globs only, not full regex. a typo should not match half the variables.
    if (!pattern)
        return false;
    if (pattern.includes("*") || pattern.includes("?")) {
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        return re.test(name);
    }
    return pattern === name;
}
