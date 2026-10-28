import * as vscode from "vscode";
import { short_value, value_text, type call_index, type encoded_value, type reader_event } from "./format";
import type { divergence } from "./compare";

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
export function render_call(
  editor: vscode.TextEditor,
  call: call_index,
  events: reader_event[],
  step: number,
  diff?: divergence,
) {
  // first pass: only events up to the current step matter. later ones are
  // deliberately ignored so stepping backwards works without any undo logic.
  const executed = new Set(events.map((e) => e.line));
  const values = new Map<number, Record<string, encoded_value>>();
  let here = call.line0;
  for (const ev of events) {
    if (ev.step > step) break;
    if (ev.kind !== "line") continue;
    values.set(ev.line, ev.values);
    here = ev.line;
  }
  // one ghost line per executed source line, with the locals as they were at
  // that point. long values are clipped by short_value; the hover has the full
  // version.
  const ghosts: vscode.DecorationOptions[] = [];
  for (const line of [...executed].sort((a, b) => a - b)) {
    const vars = values.get(line);
    if (!vars) continue;
    const text = Object.keys(vars)
      .map((k) => `${k} = ${short_value(vars[k])}`)
      .join("   ");
    if (!text) continue;
    const pos = new vscode.Position(line - 1, Number.MAX_SAFE_INTEGER);
    const range = new vscode.Range(pos, pos);
    const full = Object.keys(vars)
      .map((k) => `**${k}**: \`${value_text(vars[k])}\``)
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
          contentText: diff.a === undefined ? diff.summary : `a = ${short_value(diff.a)}   b = ${short_value(diff.b ?? null)}`,
          color: new vscode.ThemeColor("editorWarning.foreground"),
        },
      },
      hoverMessage: new vscode.MarkdownString(diff.summary),
    });
  }

  // collapse adjacent unexecuted lines into one range. setting a decoration
  // for every line would be slower and looks exactly the same.
  const dim_ranges: vscode.Range[] = [];
  let start = -1;
  for (let line = call.line0; line <= call.line1; line++) {
    if (!executed.has(line)) {
      if (start < 0) start = line;
    } else if (start >= 0) {
      dim_ranges.push(new vscode.Range(start - 1, 0, line - 2, 0));
      start = -1;
    }
  }
  if (start >= 0) dim_ranges.push(new vscode.Range(start - 1, 0, call.line1 - 1, 0));

  editor.setDecorations(ghost, ghosts);
  editor.setDecorations(dim, dim_ranges);
  editor.setDecorations(current, [new vscode.Range(here - 1, 0, here - 1, 0)]);
}

// called when the panel closes or the selection moves out of the recorded
// function. passing undefined is fine and just means there is nothing to clear.
export function clear_all(editor: vscode.TextEditor | undefined) {
  if (!editor) return;
  editor.setDecorations(ghost, []);
  editor.setDecorations(dim, []);
  editor.setDecorations(current, []);
}

// the decoration types are global and created once. disposing them on
// deactivate is what stops vs code from keeping the styles around.
export function dispose_decorations() {
  ghost.dispose();
  dim.dispose();
  current.dispose();
}
