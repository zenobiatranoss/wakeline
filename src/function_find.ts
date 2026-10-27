import * as vscode from "vscode";
import { language_by_id } from "./languages";
import { find_function_in_text, type found_function } from "./text_find";

// the friendly front door to function detection. the language server knows the
// real symbol tree when a language extension is installed, but it is not always
// there (or it may not answer for an unsaved file), so the text scanner is the
// safety net. "at" is a zero based line from the editor selection.
export async function find_function(document: vscode.TextDocument, at: number): Promise<found_function | null> {
  const spec = language_by_id(document.languageId);
  if (!spec) return null;
  const lang = spec.id;
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    document.uri,
  );
  const hit = deepest_symbol(symbols ?? [], at);
  if (hit && (hit.kind === vscode.SymbolKind.Function || hit.kind === vscode.SymbolKind.Method || hit.kind === vscode.SymbolKind.Constructor)) {
    return { name: hit.name, line0: hit.range.start.line + 1, line1: hit.range.end.line + 1 };
  }
  // fall back to text when there is no useful symbol
  return find_function_in_text(document.getText(), at, lang);
}

// walk down the symbol tree and keep the innermost function that contains the
// cursor. a method inside a class inside a namespace is the interesting one,
// not the outermost symbol.
function deepest_symbol(symbols: vscode.DocumentSymbol[], at: number): vscode.DocumentSymbol | null {
  let best: vscode.DocumentSymbol | null = null;
  for (const s of symbols) {
    const inside = s.range.start.line <= at && s.range.end.line >= at;
    if (!inside) continue;
    const child = deepest_symbol(s.children ?? [], at);
    if (child) return child;
    if (!best || s.range.start.line >= best.range.start.line) best = s;
  }
  return best;
}
