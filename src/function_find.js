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
exports.find_function = find_function;
const vscode = __importStar(require("vscode"));
const languages_1 = require("./languages");
const text_find_1 = require("./text_find");
// the friendly front door to function detection. the language server knows the
// real symbol tree when a language extension is installed, but it is not always
// there (or it may not answer for an unsaved file), so the text scanner is the
// safety net. "at" is a zero based line from the editor selection.
async function find_function(document, at) {
    const spec = (0, languages_1.language_by_id)(document.languageId);
    if (!spec)
        return null;
    const lang = spec.id;
    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
    const hit = deepest_symbol(symbols ?? [], at);
    if (hit && (hit.kind === vscode.SymbolKind.Function || hit.kind === vscode.SymbolKind.Method || hit.kind === vscode.SymbolKind.Constructor)) {
        return { name: hit.name, line0: hit.range.start.line + 1, line1: hit.range.end.line + 1 };
    }
    // fall back to text when there is no useful symbol
    return (0, text_find_1.find_function_in_text)(document.getText(), at, lang);
}
// walk down the symbol tree and keep the innermost function that contains the
// cursor. a method inside a class inside a namespace is the interesting one,
// not the outermost symbol.
function deepest_symbol(symbols, at) {
    let best = null;
    for (const s of symbols) {
        const inside = s.range.start.line <= at && s.range.end.line >= at;
        if (!inside)
            continue;
        const child = deepest_symbol(s.children ?? [], at);
        if (child)
            return child;
        if (!best || s.range.start.line >= best.range.start.line)
            best = s;
    }
    return best;
}
