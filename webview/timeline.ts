// the page half of the timeline. the extension side sends a call index and the
// events for one call; this file turns that into rows, handles stepping and
// drawing, and asks the extension to open a line or compare two calls.

type encoded = unknown;
type ev = { kind: string; step: number; line: number; values: Record<string, encoded>; exception?: unknown };
type call = {
  id: string;
  name: string;
  line0: number;
  line1: number;
  args: Record<string, encoded>;
  outcome: string;
  result?: encoded;
  ms: number;
  cap: string;
};
type index_msg = {
  type: "index";
  calls: call[];
  total: number;
  interrupted: string[];
  version: number;
  stale?: string;
};
type load_msg = { type: "load"; call: call; events: ev[]; step: number; cut?: boolean };
type step_msg = { type: "step"; step: number };
type compare_msg = {
  type: "compare";
  diff: { found: boolean; summary: string; line: number; step: number };
  a: string;
  b: string;
  left: { name: string; offset: number; events: ev[] };
  right: { name: string; offset: number; events: ev[] };
};
type status_msg = { type: "status"; text: string };
type empty_msg = { type: "empty"; text: string };
type play_msg = { type: "play_toggle" };
type msg = index_msg | load_msg | step_msg | compare_msg | status_msg | empty_msg | play_msg;

declare function acquireVsCodeApi(): { postMessage: (m: unknown) => void };

const vscode = acquireVsCodeApi();
const search = document.getElementById("search") as HTMLInputElement;
const picker = document.getElementById("calls") as HTMLSelectElement;
const list = document.getElementById("list") as HTMLElement;
const scrub = document.getElementById("scrub") as HTMLInputElement;
const counter = document.getElementById("counter") as HTMLElement;
const status_line = document.getElementById("status") as HTMLElement;
const compare_box = document.getElementById("compare-box") as HTMLElement;
const play_button = document.getElementById("play") as HTMLButtonElement;

// what a row in the list is. either one real event, or a folded run of repeated
// lines that the page decided to collapse into a "loop" row.
type row =
  | { kind: "event"; index: number; ev: ev }
  | { kind: "group"; start: number; count: number; period: number; lines: number[] };

let calls: call[] = [];
let call: call | null = null; // the call currently loaded, if any
let events: ev[] = [];
let rows: row[] = []; // events after loop folding, one entry per visible row
let step = 0;
let playing = 0; // interval id while playback runs
let cut = false;
let stale = "";
const row_h = 24; // must match the css, used for virtual scrolling
const expanded = new Set<number>(); // indexes of groups the user opened

// all the wiring happens once, when the page loads. every handler is tiny and
// just forwards to the extension or to a local helper.
search.addEventListener("input", fill_picker);
picker.addEventListener("change", () => {
  if (picker.value) vscode.postMessage({ type: "select_call", id: picker.value });
});
document.getElementById("prev")?.addEventListener("click", () => set_step(step - 1));
document.getElementById("next")?.addEventListener("click", () => set_step(step + 1));
play_button.addEventListener("click", toggle_play);
scrub.addEventListener("input", () => set_step(Number(scrub.value)));
document.getElementById("compare")?.addEventListener("click", () => {
  if (call) vscode.postMessage({ type: "compare", a: call.id });
});
list.addEventListener("scroll", render_list);
// one delegated click handler for the whole list. group rows expand, line
// numbers open the source file, and anything else moves the current step.
list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest("[data-step]") as HTMLElement | null;
  if (!row) return;
  if (row.dataset.group) {
    const at = Number(row.dataset.group);
    if (expanded.has(at)) expanded.delete(at);
    else expanded.add(at);
    build_rows();
    render_list();
    return;
  }
  if (target.classList.contains("line")) {
    vscode.postMessage({ type: "open", line: Number(row.dataset.line) });
    return;
  }
  set_step(Number(row.dataset.step));
});

window.addEventListener("keydown", (e) => {
  // don't steal keys from the search box, the picker or the buttons. that
  // rule alone avoids most of the "my spacebar doesn't type" complaints.
  const target = e.target as HTMLElement;
  if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
  if (e.key === "ArrowLeft") set_step(step - 1);
  else if (e.key === "ArrowRight") set_step(step + 1);
  else if (e.key === "Home") set_step(0);
  else if (e.key === "End") set_step(events.length - 1);
  else if (e.key === " ") toggle_play();
  else return;
  e.preventDefault();
});

// everything from the extension lands here. the message type is enough to know
// what to do; unknown types are ignored so a newer extension can talk to an
// older page without breaking it.
window.addEventListener("message", (e) => {
  const m = e.data as msg;
  if (m.type === "index") {
    calls = m.calls;
    stale = m.stale || "";
    fill_picker();
    // these notes share one status line, so collect them first and join once.
    const notes = [];
    if (stale) notes.push(stale);
    if (m.total > m.calls.length) notes.push(`showing the first ${m.calls.length} of ${m.total} calls`);
    if (m.interrupted.length) notes.push(`${m.interrupted.length} call(s) were interrupted`);
    if (notes.length) status_line.textContent = notes.join(". ");
    return;
  }
  if (m.type === "load") {
    // a fresh call resets the view completely: scroll, folding and compare are
    // all about the previous call and would be confusing to keep.
    call = m.call;
    events = m.events;
    step = m.step;
    cut = !!m.cut;
    expanded.clear();
    picker.value = call.id;
    scrub.max = String(Math.max(0, events.length - 1));
    compare_box.hidden = true;
    build_rows();
    render();
    return;
  }
  if (m.type === "step") {
    step = m.step;
    update_step();
    return;
  }
  if (m.type === "compare") {
    render_compare(m);
    return;
  }
  if (m.type === "status") {
    status_line.textContent = m.text;
    return;
  }
  if (m.type === "empty") {
    call = null;
    events = [];
    rows = [];
    status_line.textContent = m.text;
    list.innerHTML = "";
    counter.textContent = "0 / 0";
    compare_box.hidden = true;
    return;
  }
  if (m.type === "play_toggle") toggle_play();
});

function fill_picker() {
  // simple substring search over name, args and outcome. fuzzy matching would
  // be nicer but this is fast and predictable.
  const q = search.value.trim().toLowerCase();
  const keep = picker.value || call?.id;
  picker.innerHTML = "";
  for (const c of calls) {
    if (q && !`${c.name} ${short(c.args)} ${c.outcome}`.toLowerCase().includes(q)) continue;
    const option = document.createElement("option");
    option.value = c.id;
    option.textContent = `${c.id} ${short(c.args)} -> ${c.outcome === "throw" ? "throw" : short(c.result)} (${c.ms} ms)`;
    picker.append(option);
  }
  if (keep && calls.some((c) => c.id === keep)) picker.value = keep;
}

function render() {
  // status line for the things that make a recording less than perfect: stale
  // source, a cut call, a cap, an exception.
  update_step();
  const notes = [];
  if (stale) notes.push(stale);
  if (cut) notes.push(`showing the first ${events.length} steps of this call`);
  if (call?.cap && call.cap !== "none") notes.push(`recording stopped at cap ${call.cap}`);
  if (call?.outcome === "throw") notes.push("this call threw");
  if (call?.outcome === "running") notes.push("this call did not finish");
  status_line.textContent = notes.join(". ");
}

function update_step() {
  // the scrubber and the counter are the two cheap bits that change on every
  // step. the list redraws itself below.
  scrub.value = String(step);
  counter.textContent = `${events.length ? step + 1 : 0} / ${events.length}`;
  render_list();
}

function build_rows() {
  // turn the flat event list into rows, folding repetitive stretches. a loop
  // that runs 500 times should not push everything else off the screen.
  rows = [];
  let i = 0;
  while (i < events.length) {
    if (!expanded.has(i)) {
      const group = find_group(i);
      if (group) {
        rows.push(group);
        i += group.count * group.period;
        continue;
      }
    }
    rows.push({ kind: "event", index: i, ev: events[i] });
    i++;
  }
}

function find_group(start: number): row | null {
  // look for a short cycle of line numbers repeating at least three times.
  // period is how many lines one iteration covers; longer than 8 stops being
  // readable and usually isn't a loop anyway.
  for (let period = 1; period <= 8; period++) {
    if (start + period * 3 > events.length) break;
    let ok = true;
    for (let k = 0; k < period * 3; k++) {
      if (events[start + k].line !== events[start + (k % period)].line) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let count = 3;
    while (start + (count + 1) * period <= events.length) {
      let same = true;
      for (let k = 0; k < period; k++) {
        if (events[start + count * period + k].line !== events[start + k].line) {
          same = false;
          break;
        }
      }
      if (!same) break;
      count++;
    }
    return {
      kind: "group",
      start,
      count,
      period,
      lines: events.slice(start, start + period).map((ev) => ev.line),
    };
  }
  return null;
}

function render_list() {
  // virtual list. only the rows near the viewport exist in the dom, and spacer
  // divs keep the scrollbar the right size. a 50k step call stays smooth.
  if (!rows.length) {
    list.innerHTML = "";
    return;
  }
  const first = Math.max(0, Math.floor(list.scrollTop / row_h) - 3);
  const room = Math.ceil(list.clientHeight / row_h) + 6;
  const last = Math.min(rows.length, first + room);
  const parts = [`<div style="height:${first * row_h}px"></div>`];
  for (let i = first; i < last; i++) {
    const r = rows[i];
    if (r.kind === "group") {
      const on = step >= r.start && step < r.start + r.count * r.period ? " current" : "";
      const text = `lines ${r.lines.join(", ")} x ${r.count}`;
      parts.push(
        `<div class="row group${on}" data-step="${r.start}" data-group="${r.start}" data-line="${r.lines[0]}"><span class="step">${r.start + 1}</span><span class="vars">${escape(text)}</span><span class="hint">click to expand</span></div>`,
      );
      continue;
    }
    const e = r.ev;
    const current = r.index === step ? " current" : "";
    const body = Object.keys(e.values)
      .map((k) => `${escape(k)} = ${escape(short(e.values[k]))}`)
      .join("   ");
    const exception = e.kind === "exception" ? `<span class="bad">${escape(short(e.exception))}</span>` : "";
    parts.push(
      `<div class="row${current}" data-step="${r.index}" data-line="${e.line}"><span class="step">${r.index + 1}</span><span class="line">${e.line}</span><span class="vars">${body}${exception}</span></div>`,
    );
  }
  parts.push(`<div style="height:${(rows.length - last) * row_h}px"></div>`);
  list.innerHTML = parts.join("");
  const current = list.querySelector(".row.current") as HTMLElement | null;
  if (current) {
    const top = current.offsetTop;
    if (top < list.scrollTop || top + row_h > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2);
    }
  }
}

function render_compare(m: compare_msg) {
  // a two-column diff of the steps around the divergence. the row where they
  // split gets highlighted so the eye lands on it immediately.
  compare_box.hidden = false;
  if (!m.diff.found) {
    compare_box.innerHTML = `<div class="compare-title">${escape(m.diff.summary)}</div>`;
    status_line.textContent = "compare: no divergence";
    return;
  }
  const n = Math.max(m.left.events.length, m.right.events.length);
  const parts = [
    `<div class="compare-title">${escape(m.diff.summary)}</div>`,
    `<div class="compare-head"><span>${escape(m.left.name)}</span><span>${escape(m.right.name)}</span></div>`,
    `<div class="compare-grid">`,
  ];
  for (let i = 0; i < n; i++) {
    const left = m.left.events[i];
    const right = m.right.events[i];
    const hit = i === m.diff.step ? " hit" : "";
    parts.push(`<div class="compare-row${hit}">`);
    parts.push(compare_cell(left, m.left.offset + i + 1));
    parts.push(compare_cell(right, m.right.offset + i + 1));
    parts.push(`</div>`);
  }
  parts.push(`</div>`);
  compare_box.innerHTML = parts.join("");
  status_line.textContent = "compare: divergence found";
}

function compare_cell(e: ev | undefined, n: number) {
  // one side may be shorter than the other, which is exactly the interesting
  // case, so an empty cell is normal rather than an error.
  if (!e) return `<div class="compare-cell empty"></div>`;
  const body = Object.keys(e.values)
    .map((k) => `${escape(k)} = ${escape(short(e.values[k]))}`)
    .join(", ");
  return `<div class="compare-cell"><span class="step">${n}</span><span class="line">${e.line}</span><span class="vars">${body}</span></div>`;
}

function set_step(n: number) {
  if (!events.length) return;
  // clamp locally so the buttons feel instant, then tell the extension so the
  // editor decorations can follow.
  step = Math.max(0, Math.min(events.length - 1, n));
  update_step();
  vscode.postMessage({ type: "step", step });
}

function toggle_play() {
  if (playing) stop_play();
  else start_play();
}

function start_play() {
  // 250ms per step is slow enough to read but fast enough to feel like motion.
  if (!events.length) return;
  playing = window.setInterval(() => {
    if (step >= events.length - 1) {
      stop_play();
      return;
    }
    set_step(step + 1);
  }, 250);
  play_button.textContent = "pause";
}

function stop_play() {
  if (playing) window.clearInterval(playing);
  playing = 0;
  play_button.textContent = "play";
}

function short(v: unknown): string {
  // a deliberately compact printer for encoded values. it mirrors the tags the
  // recorders write, and anything it doesn't recognise falls back to json.
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return JSON.stringify(v.length > 60 ? v.slice(0, 57) + "..." : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  switch (obj.$) {
    case "int":
    case "num":
      return String(obj.v);
    case "undefined":
      return "undefined";
    case "list":
      return `[${((obj.v as unknown[]) || []).map(short).join(", ")}${obj.cut ? ", ..." : ""}]`;
    case "dict":
      return `{${((obj.v as unknown[][]) || []).map((p) => `${short(p[0])}: ${short(p[1])}`).join(", ")}${obj.cut ? ", ..." : ""}}`;
    case "set":
      return `{${((obj.v as unknown[]) || []).map(short).join(", ")}${obj.cut ? ", ..." : ""}}`;
    case "str":
      return `${JSON.stringify(obj.v)}${obj.cut ? ` ...(${obj.n} chars)` : ""}`;
    case "bytes":
      return `<${obj.n} bytes>`;
    case "trunc":
      return `<cut: ${obj.why || "limit"}>`;
    case "ref":
      return `<ref ${obj.id}>`;
    case "obj":
      return `${obj.cls || "object"}{...}`;
    case "fn":
      return `<fn ${obj.name || ""}>`.replace(" >", ">");
    case "opaque":
      return `<${obj.cls || "value"}>`;
    case "error":
      return `${obj.cls}: ${obj.m}`;
    default:
      return JSON.stringify(obj).slice(0, 100);
  }
}

// everything in the list is built as html strings, so values from the user's
// program have to be escaped. four characters cover the usual injections.
function escape(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// tell the extension we are alive and ready for the call index. this also runs
// after a webview reload, which is why the extension keeps the current state.
vscode.postMessage({ type: "ready" });
