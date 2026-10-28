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
exports.render_call = render_call;
exports.clear_all = clear_all;
exports.dispose_decorations = dispose_decorations;
const vscode = __importStar(require("vscode"));
const format_1 = require("./format");
// the editor half of the timeline. three decoration types: ghost text after a
// line, a dimmed range for lines that never ran, and a whole-line highlight for
// where the recorded call is right now.
const ghost = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), margin: "0 0 0 2em" },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});
const dim = vscode.window.createTextEditorDecorationType({
    opacity: "0.45",
    isWholeLine: true,
});
const current = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.lineHighlightBackground"),
});
// redraw everything for one call at one step. it is cheap enough to run on
// every step because the event list is already in memory.
function render_call(editor, call, events, step, diff) {
    // first pass: only events up to the current step matter. later ones are
    // deliberately ignored so stepping backwards works without any undo logic.
    const executed = new Set(events.map((e) => e.line));
    const values = new Map();
    let here = call.line0;
    for (const ev of events) {
        if (ev.step > step)
            break;
        if (ev.kind !== "line")
            continue;
        values.set(ev.line, ev.values);
        here = ev.line;
    }
    // one ghost line per executed source line, with the locals as they were at
    // that point. long values are clipped by short_value; the hover has the full
    // version.
    const ghosts = [];
    for (const line of [...executed].sort((a, b) => a - b)) {
        const vars = values.get(line);
        if (!vars)
            continue;
        const text = Object.keys(vars)
            .map((k) => `${k} = ${(0, format_1.short_value)(vars[k])}`)
            .join("   ");
        if (!text)
            continue;
        const pos = new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER);
        const range = new vscode.Range(pos, pos);
        const full = Object.keys(vars)
            .map((k) => `**${k}**: \`${(0, format_1.value_text)(vars[k])}\``)
            .join("\n\n");
        ghosts.push({ range, renderOptions: { after: { contentText: text } }, hoverMessage: new vscode.MarkdownString(full) });
    }
    // when a compare is active, mark the line where the two calls split. it only
    // appears when the current step is actually on that line.
    if (diff?.found && diff.line === here) {
        const pos = new vscode.Position(here - 1, Number.MAX_SAFE_INTEGER);
        ghosts.push({
            range: new vscode.Range(pos, pos),
            renderOptions: {
                after: {
                    contentText: diff.a === undefined ? diff.summary : `a = ${(0, format_1.short_value)(diff.a)}   b = ${(0, format_1.short_value)(diff.b ?? null)}`,
                    color: new vscode.ThemeColor("editorWarning.foreground"),
                },
            },
            hoverMessage: new vscode.MarkdownString(diff.summary),
        });
    }
    // collapse adjacent unexecuted lines into one range. setting a decoration
    // for every line would be slower and looks exactly the same.
    const dim_ranges = [];
    let start = -1;
    for (let line = call.line0; line <= call.line1; line++) {
        if (!executed.has(line)) {
            if (start < 0)
                start = line;
        }
        else if (start >= 0) {
            dim_ranges.push(new vscode.Range(start - 1, 0, line - 2, 0));
            start = -1;
        }
    }
    if (start >= 0)
        dim_ranges.push(new vscode.Range(start - 1, 0, call.line1 - 1, 0));
    editor.setDecorations(ghost, ghosts);
    editor.setDecorations(dim, dim_ranges);
    editor.setDecorations(current, [new vscode.Range(here - 1, 0, here - 1, 0)]);
}
// called when the panel closes or the selection moves out of the recorded
// function. passing undefined is fine and just means there is nothing to clear.
function clear_all(editor) {
    if (!editor)
        return;
    editor.setDecorations(ghost, []);
    editor.setDecorations(dim, []);
    editor.setDecorations(current, []);
}
// the decoration types are global and created once. disposing them on
// deactivate is what stops vs code from keeping the styles around.
function dispose_decorations() {
    ghost.dispose();
    dim.dispose();
    current.dispose();
}
