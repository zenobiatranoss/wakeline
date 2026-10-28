"use strict";
(() => {
  // webview/timeline.ts
  var vscode = acquireVsCodeApi();
  var search = document.getElementById("search");
  var picker = document.getElementById("calls");
  var list = document.getElementById("list");
  var scrub = document.getElementById("scrub");
  var counter = document.getElementById("counter");
  var status_line = document.getElementById("status");
  var compare_box = document.getElementById("compare-box");
  var play_button = document.getElementById("play");
  var calls = [];
  var call = null;
  var events = [];
  var rows = [];
  var step = 0;
  var playing = 0;
  var cut = false;
  var stale = "";
  var row_h = 24;
  var expanded = /* @__PURE__ */ new Set();
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
  list.addEventListener("click", (e) => {
    const target = e.target;
    const row = target.closest("[data-step]");
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
    const target = e.target;
    if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
    if (e.key === "ArrowLeft") set_step(step - 1);
    else if (e.key === "ArrowRight") set_step(step + 1);
    else if (e.key === "Home") set_step(0);
    else if (e.key === "End") set_step(events.length - 1);
    else if (e.key === " ") toggle_play();
    else return;
    e.preventDefault();
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "index") {
      calls = m.calls;
      stale = m.stale || "";
      fill_picker();
      const notes = [];
      if (stale) notes.push(stale);
      if (m.total > m.calls.length) notes.push(`showing the first ${m.calls.length} of ${m.total} calls`);
      if (m.interrupted.length) notes.push(`${m.interrupted.length} call(s) were interrupted`);
      if (notes.length) status_line.textContent = notes.join(". ");
      return;
    }
    if (m.type === "load") {
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
    scrub.value = String(step);
    counter.textContent = `${events.length ? step + 1 : 0} / ${events.length}`;
    render_list();
  }
  function build_rows() {
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
  function find_group(start) {
    for (let period = 1; period <= 8; period++) {
      if (start + period * 3 > events.length) break;
      let ok = true;
      for (let k = 0; k < period * 3; k++) {
        if (events[start + k].line !== events[start + k % period].line) {
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
        lines: events.slice(start, start + period).map((ev) => ev.line)
      };
    }
    return null;
  }
  function render_list() {
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
          `<div class="row group${on}" data-step="${r.start}" data-group="${r.start}" data-line="${r.lines[0]}"><span class="step">${r.start + 1}</span><span class="vars">${escape(text)}</span><span class="hint">click to expand</span></div>`
        );
        continue;
      }
      const e = r.ev;
      const current2 = r.index === step ? " current" : "";
      const body = Object.keys(e.values).map((k) => `${escape(k)} = ${escape(short(e.values[k]))}`).join("   ");
      const exception = e.kind === "exception" ? `<span class="bad">${escape(short(e.exception))}</span>` : "";
      parts.push(
        `<div class="row${current2}" data-step="${r.index}" data-line="${e.line}"><span class="step">${r.index + 1}</span><span class="line">${e.line}</span><span class="vars">${body}${exception}</span></div>`
      );
    }
    parts.push(`<div style="height:${(rows.length - last) * row_h}px"></div>`);
    list.innerHTML = parts.join("");
    const current = list.querySelector(".row.current");
    if (current) {
      const top = current.offsetTop;
      if (top < list.scrollTop || top + row_h > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 2);
      }
    }
  }
  function render_compare(m) {
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
      `<div class="compare-grid">`
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
  function compare_cell(e, n) {
    if (!e) return `<div class="compare-cell empty"></div>`;
    const body = Object.keys(e.values).map((k) => `${escape(k)} = ${escape(short(e.values[k]))}`).join(", ");
    return `<div class="compare-cell"><span class="step">${n}</span><span class="line">${e.line}</span><span class="vars">${body}</span></div>`;
  }
  function set_step(n) {
    if (!events.length) return;
    step = Math.max(0, Math.min(events.length - 1, n));
    update_step();
    vscode.postMessage({ type: "step", step });
  }
  function toggle_play() {
    if (playing) stop_play();
    else start_play();
  }
  function start_play() {
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
  function short(v) {
    if (v === null || v === void 0) return String(v);
    if (typeof v === "string") return JSON.stringify(v.length > 60 ? v.slice(0, 57) + "..." : v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v !== "object") return String(v);
    const obj = v;
    switch (obj.$) {
      case "int":
      case "num":
        return String(obj.v);
      case "undefined":
        return "undefined";
      case "list":
        return `[${(obj.v || []).map(short).join(", ")}${obj.cut ? ", ..." : ""}]`;
      case "dict":
        return `{${(obj.v || []).map((p) => `${short(p[0])}: ${short(p[1])}`).join(", ")}${obj.cut ? ", ..." : ""}}`;
      case "set":
        return `{${(obj.v || []).map(short).join(", ")}${obj.cut ? ", ..." : ""}}`;
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
  function escape(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  }
  vscode.postMessage({ type: "ready" });
})();
