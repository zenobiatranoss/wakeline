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
exports.recordings_dir = recordings_dir;
exports.ensure_dir = ensure_dir;
exports.new_recording_path = new_recording_path;
exports.prune = prune;
exports.latest_recording = latest_recording;
exports.latest_any = latest_any;
exports.clear_recordings = clear_recordings;
const fsp = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
// recordings live under the extension's global storage, never in the workspace.
// file names carry the language, the function name and a timestamp, which is
// enough to group them for retention without a database.
function recordings_dir(root) {
    return path.join(root, "recordings");
}
async function ensure_dir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}
// squish a qualified function name into something safe on every filesystem.
// the fallback matters for names that are all punctuation.
function safe_part(text) {
    return text.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "function";
}
// the timestamp is part of the name, so sorting by name is sorting by age and
// two runs can never collide.
function new_recording_path(dir, language, name) {
    return path.join(dir, `${language}_${safe_part(name)}_${Date.now()}.jsonl`);
}
async function prune(dir, retention) {
    // retention is per function, so one noisy function cannot delete another one's history
    let names;
    try {
        names = await fsp.readdir(dir);
    }
    catch {
        return;
    }
    const groups = new Map();
    for (const file of names) {
        const m = /^([a-z]+)_(.+)_(\d+)\.jsonl$/.exec(file);
        if (!m)
            continue;
        const key = `${m[1]}_${m[2]}`;
        const list = groups.get(key) ?? [];
        list.push({ file, ms: Number(m[3]) });
        groups.set(key, list);
    }
    for (const list of groups.values()) {
        list.sort((a, b) => b.ms - a.ms);
        for (const old of list.slice(Math.max(1, retention))) {
            await fsp.rm(path.join(dir, old.file), { force: true });
        }
    }
}
// newest recording for one exact function, used by "open last recording" when
// the cursor is inside a function.
async function latest_recording(dir, language, name) {
    const prefix = `${language}_${safe_part(name)}_`;
    let names;
    try {
        names = await fsp.readdir(dir);
    }
    catch {
        return null;
    }
    const hits = names
        .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
        .map((f) => ({ f, ms: Number(/_(\d+)\.jsonl$/.exec(f)?.[1] ?? 0) }))
        .sort((a, b) => b.ms - a.ms);
    return hits.length ? path.join(dir, hits[0].f) : null;
}
// fallback for "open last recording" when there is no function under the
// cursor. any recording in the folder wins.
async function latest_any(dir) {
    let entries;
    try {
        entries = await fsp.readdir(dir);
    }
    catch {
        return null;
    }
    let best = null;
    for (const file of entries) {
        if (!file.endsWith(".jsonl"))
            continue;
        const ms = Number(/_(\d+)\.jsonl$/.exec(file)?.[1] ?? 0);
        if (!best || ms > best.ms)
            best = { file, ms };
    }
    return best ? path.join(dir, best.file) : null;
}
// delete and recreate in one go, so the folder is still there for the next
// run even if someone clears while the panel is open.
async function clear_recordings(dir) {
    await fsp.rm(dir, { recursive: true, force: true });
    await ensure_dir(dir);
}
