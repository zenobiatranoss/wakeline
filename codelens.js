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
exports.WakelineCodeLensProvider = void 0;
const vscode = __importStar(require("vscode"));
const languages_1 = require("./languages");
class WakelineCodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }
    provideCodeLenses(document) {
        const lenses = [];
        const text = document.getText();
        const lang = document.languageId;
        if (!languages_1.languages.find(l => l.id === lang)) {
            return lenses;
        }
        let regex = null;
        if (lang === 'python') {
            regex = /^\s*def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
        }
        else if (lang === 'javascript' || lang === 'typescript') {
            regex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
        }
        else if (lang === 'go') {
            regex = /^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
        }
        else if (lang === 'csharp') {
            regex = /^\s*(?:public|private|protected|internal|static|async|override|virtual|sealed|new|\s)+[^\n{;]+\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;{]*\)\s*\{/gm;
        }
        else if (lang === 'cpp') {
            regex = /^\s*(?:[^\n;{=]*\b)([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm;
        }
        if (!regex)
            return lenses;
        let m;
        while ((m = regex.exec(text)) !== null) {
            const name = m[1];
            if (!name)
                continue;
            if (['if', 'for', 'while', 'switch', 'catch', 'try', 'else'].includes(name))
                continue;
            const pos = document.positionAt(m.index);
            const range = new vscode.Range(pos, pos);
            const lens = new vscode.CodeLens(range, {
                title: '$(play) wakeline: record',
                tooltip: 'record this function with wakeline',
                command: 'wakeline.record_at_line',
                arguments: [pos.line]
            });
            lenses.push(lens);
        }
        return lenses;
    }
}
exports.WakelineCodeLensProvider = WakelineCodeLensProvider;
