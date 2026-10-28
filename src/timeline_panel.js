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
exports.set_compare_ignore = set_compare_ignore;
exports.show_timeline = show_timeline;
exports.close_timeline = close_timeline;
exports.is_open = is_open;
exports.step_timeline = step_timeline;
exports.jump_divergence = jump_divergence;
exports.toggle_play = toggle_play;
exports.jump_to_line = jump_to_line;
exports.compare_previous = compare_previous;
exports.compare_with = compare_with;
const vscode = __importStar(require("vscode"));
const compare_1 = require("./compare");
const recording_reader_1 = require("./recording_reader");
let panel;
let current_file = ""; // recording being read, not the source file
let current_index;
let current_call;
let current_events = [];
let current_step = 0;
let current_diff;
let current_stale = "";
let hooks_ref;
let ignore = []; // variable patterns the compare should skip
// bumped on every load. a late read from an old selection checks this and
// quietly drops its result instead of overwriting the newer call.
let load_seq = 0;
function set_compare_ignore(patterns) {
    // pushed in from extension.ts after reading settings, so this module never
    // has to know about the vs code configuration api.
    ignore = patterns;
}
function show_timeline(extension_uri, file, index, call_id, stale, hooks) {
    // this can be called again for a new recording while the panel is open. in
    // that case just swap the data and keep the user's layout.
    load_seq++;
    current_file = file;
    current_index = index;
    current_stale = stale;
    hooks_ref = hooks;
    if (!panel) {
        // scripts are on but everything else stays locked down by the csp in the
        // html below. retainContextWhenHidden keeps the scroll position when the
        // user tabs away and comes back.
        panel = vscode.window.createWebviewPanel("wakeline.timeline", "wakeline timeline", vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extension_uri],
        });
        panel.webview.html = html(extension_uri, panel.webview);
        panel.onDidDispose(() => {
            // dropping the state here matters: a stale compare pointing at a closed
            // panel would keep the old events alive.
            panel = undefined;
            current_call = undefined;
            current_events = [];
            current_diff = undefined;
            load_seq++;
            hooks_ref?.on_close();
        });
        panel.webview.onDidReceiveMessage((msg) => void handle(msg));
    }
    else {
        // the page already exists, so it only needs the new call list. it asks for
        // the selected call's events separately.
        panel.reveal(vscode.ViewColumn.Beside);
        send_index();
    }
    const wanted = call_id ?? index.calls[0]?.id;
    if (wanted)
        void load_call(wanted);
    else
        post({ type: "empty", text: "the function was never called" });
}
function close_timeline() {
    // dispose fires onDidDispose, which is where the real cleanup happens.
    panel?.dispose();
    panel = undefined;
}
function is_open() {
    return !!panel;
}
function step_timeline(delta) {
    // called by the keyboard shortcuts. the page does the same thing when its
    // own buttons are used, so both paths end up in set_step.
    if (!current_call || !current_events.length)
        return;
    set_step(current_step + delta);
}
function jump_divergence() {
    // no compare has run yet, or the two calls matched. say so in the panel's
    // status line instead of doing nothing.
    if (!current_diff?.found) {
        post({ type: "status", text: "nothing to jump to, compare a call first" });
        return;
    }
    set_step(current_diff.step);
}
function toggle_play() {
    // playback lives entirely in the page. this just forwards the command so the
    // keyboard shortcut and the button behave identically.
    post({ type: "play_toggle" });
}
function jump_to_line(line) {
    // cursor moves in the editor are mapped to the nearest step that touched
    // that line. nearest rather than exact because some lines never execute.
    if (!current_events.length)
        return;
    let best = 0;
    let distance = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < current_events.length; i++) {
        const d = Math.abs(current_events[i].line - line);
        if (d < distance) {
            distance = d;
            best = i;
        }
        if (d === 0)
            break;
    }
    set_step(best);
}
async function compare_previous() {
    // "previous" means the call before this one in the file, which is how you
    // normally spot a loop iteration that went wrong.
    if (!current_call) {
        post({ type: "status", text: "open a call first" });
        return;
    }
    const id = previous_id(current_call.id);
    if (!id) {
        post({ type: "status", text: "this is the first call of the function" });
        return;
    }
    await compare_with(id);
}
async function compare_with(id) {
    if (!current_index || !current_call)
        return;
    const other = current_index.calls.find((c) => c.id === id);
    if (!other)
        return;
    // left is always the call currently on screen. comparing a call with itself
    // is pointless but harmless, and it avoids a special case in the page.
    const left = current_call;
    const left_events = current_events;
    const seq = load_seq;
    const right_events = id === current_call.id ? left_events : await (0, recording_reader_1.read_call_events)(current_file, other);
    if (seq !== load_seq)
        return;
    const diff = (0, compare_1.compare_calls)(left, other, left_events, right_events, ignore);
    current_diff = diff;
    hooks_ref?.on_step(left, left_events, current_step, diff);
    // only a slice around the divergence is sent over. a thousand-step loop would
    // otherwise mean a very large postMessage for one row of interest.
    const left_window = diff.found ? window(left_events, diff.step) : { events: [], offset: 0 };
    const right_window = diff.found ? window(right_events, diff.step) : { events: [], offset: 0 };
    post({
        type: "compare",
        diff,
        a: left.id,
        b: other.id,
        left: { name: `${left.id} ${left.name}`, offset: left_window.offset, events: left_window.events },
        right: { name: `${other.id} ${other.name}`, offset: right_window.offset, events: right_window.events },
    });
}
function window(events, center) {
    // show a bit before the divergence and a lot after it, clipped to the end.
    const span = 40;
    let start = Math.max(0, center - 6);
    if (start + span > events.length)
        start = Math.max(0, events.length - span);
    return { events: events.slice(start, start + span), offset: start };
}
async function handle(msg) {
    // "ready" means the page just loaded (or reloaded) and wants the current
    // state back. everything else is a user action from the page.
    if (msg.type === "ready") {
        send_index();
        if (current_call) {
            post({
                type: "load",
                call: current_call,
                events: current_events,
                step: current_step,
                cut: current_events.length >= recording_reader_1.max_events_in_memory,
            });
        }
        return;
    }
    if (msg.type === "select_call" && msg.id) {
        await load_call(msg.id);
        return;
    }
    if (msg.type === "step" && current_call && typeof msg.step === "number") {
        set_step(msg.step);
        return;
    }
    if (msg.type === "compare" && current_index && current_call) {
        const other = msg.id ?? previous_id(current_call.id);
        if (!other) {
            post({ type: "status", text: "there is no previous call of this function" });
            return;
        }
        await compare_with(other);
        return;
    }
    if (msg.type === "open" && typeof msg.line === "number") {
        hooks_ref?.on_open(msg.line);
    }
}
function set_step(n) {
    // clamping here means the page can send step-1 at step 0 without caring.
    if (!current_call || !current_events.length)
        return;
    current_step = Math.max(0, Math.min(current_events.length - 1, n));
    hooks_ref?.on_step(current_call, current_events, current_step, current_diff);
    post({ type: "step", step: current_step });
}
async function load_call(id) {
    if (!current_index)
        return;
    const call = current_index.calls.find((c) => c.id === id);
    if (!call)
        return;
    // picking calls quickly queues several reads. only the newest one is allowed
    // to land; otherwise an old call could show up under a new selection.
    const seq = ++load_seq;
    let events = await (0, recording_reader_1.read_call_events)(current_file, call);
    if (seq !== load_seq)
        return;
    // some recorders (c/go/csharp) only write call_start/call_end with no line events
    if (events.length === 0 && call.outcome !== "running") {
        events = [{
                kind: "line",
                step: 0,
                line: call.line0,
                values: {}
            }];
    }
    current_call = call;
    current_step = 0;
    current_diff = undefined;
    current_events = events;
    hooks_ref?.on_step(call, current_events, current_step);
    post({
        type: "load",
        call,
        events: current_events,
        step: 0,
        cut: current_events.length >= recording_reader_1.max_events_in_memory,
    });
}
function previous_id(id) {
    // call ids are in file order, but findIndex is cheap and clearer than
    // parsing c12 back into a number.
    if (!current_index)
        return undefined;
    const at = current_index.calls.findIndex((c) => c.id === id);
    return at > 0 ? current_index.calls[at - 1].id : undefined;
}
function send_index() {
    if (!current_index)
        return;
    // 5000 is plenty for a dropdown and keeps the message small. the total is
    // sent as well so the page can say it is only showing a slice.
    const calls = current_index.calls.slice(0, 5000).map((c) => ({
        id: c.id,
        name: c.name,
        line0: c.line0,
        line1: c.line1,
        args: c.args,
        outcome: c.outcome,
        result: c.result,
        ms: c.ms,
        cap: c.cap,
    }));
    post({
        type: "index",
        calls,
        total: current_index.calls.length,
        interrupted: current_index.interrupted,
        version: current_index.version,
        stale: current_stale,
    });
}
function post(msg) {
    // fire and forget: the page may have just been closed, and that's fine.
    void panel?.webview.postMessage(msg);
}
function html(extension_uri, webview) {
    // one inline page with an external script and stylesheet, both turned into
    // webview-safe uris. the nonce is per-load and the csp allows nothing else.
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, "out", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, "webview", "timeline.css"));
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    // the virtual list sets inline spacer heights, hence unsafe-inline for styles only
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
<header>
  <input id="search" placeholder="search calls" aria-label="search calls">
  <select id="calls" aria-label="recorded calls"></select>
  <button id="compare">compare with previous</button>
</header>
<div id="status"></div>
<div id="compare-box" hidden></div>
<main id="list" tabindex="0"></main>
<footer>
  <button id="prev" aria-label="previous step">prev</button>
  <button id="play" aria-label="play">play</button>
  <button id="next" aria-label="next step">next</button>
  <input id="scrub" type="range" min="0" max="0" value="0" aria-label="step">
  <span id="counter">0 / 0</span>
</footer>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
