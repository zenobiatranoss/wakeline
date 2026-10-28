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
exports.read_settings = read_settings;
const vscode = __importStar(require("vscode"));
// the two shapes are split on purpose: caps go straight to the recorder, the
// rest is extension policy. defaults are duplicated in package.json because
// that is what the settings ui shows before anything is overridden.
function read_settings() {
    const c = vscode.workspace.getConfiguration("wakeline");
    return {
        caps: {
            max_calls: c.get("max_calls", 100),
            max_events: c.get("max_events", 10000),
            max_bytes: c.get("max_bytes", 10485760),
        },
        timeout: c.get("timeout", 300000),
        retention: c.get("retention", 10),
        python_path: c.get("python_path", ""),
        node_path: c.get("node_path", ""),
        go_path: c.get("go_path", ""),
        cpp_compiler: c.get("cpp_compiler", ""),
        cpp_gdb: c.get("cpp_gdb", ""),
        csharp_compiler: c.get("csharp_compiler", ""),
        csharp_runtime: c.get("csharp_runtime", ""),
        run_args: c.get("run_args", ""),
        masked: c.get("variable_masking", []),
        compare_ignore: c.get("compare_ignore", []),
    };
}
