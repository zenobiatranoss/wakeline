import * as vscode from "vscode";
import { languages } from "./languages";

export class WakelineCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lang = document.languageId;
    if (!languages.find(l => l.id === lang)) {
      return lenses;
    }
    let regex: RegExp | null = null;
    if (lang === "python") {
      regex = /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    } else if (lang === "javascript" || lang === "typescript") {
      regex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    } else if (lang === "go") {
      regex = /^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    } else if (lang === "csharp") {
      regex = /^\s*(?:public|private|protected|internal|static|async|override|virtual|sealed|new|\s)+[^\n{;]+\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;{]*\)\s*\{/gm;
    } else if (lang === "cpp") {
      regex = /^\s*(?:[^\n;{=]*\b)([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm;
    }
    if (!regex) return lenses;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const name = m[1];
      if (!name) continue;
      if (["if","for","while","switch","catch","try","else"].includes(name)) continue;
      const pos = document.positionAt(m.index);
      const range = new vscode.Range(pos, pos);
      const lens = new vscode.CodeLens(range, {
        title: "$(play) wakeline: record",
        tooltip: "record this function with wakeline",
        command: "wakeline.record_at_line",
        arguments: [pos.line]
      });
      lenses.push(lens);
    }
    return lenses;
  }
}
