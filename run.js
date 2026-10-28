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
exports.kill_all = kill_all;
exports.find_executable = find_executable;
exports.start_recording = start_recording;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const fsp = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
// starts the recorder and owns the child process. the recorder is the only
// thing spawned; it runs the user's program itself. cancelling, timing out and
// killing the tree all end up here so there is one place to reason about.
const live = new Set();
const killing = new WeakSet();
// used on deactivate. if the window closes mid-recording the user's program
// should not keep running in the background.
function kill_all() {
    for (const child of live)
        kill_tree(child);
    live.clear();
}
function find_executable(setting, names) {
    // walk PATH by hand, so this does not depend on the shell
    if (setting && path.isAbsolute(setting))
        return fs.existsSync(setting) ? setting : null;
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    for (const name of setting ? [setting] : names) {
        for (const dir of dirs) {
            for (const ext of exts) {
                const full = path.join(dir, name + ext);
                if (fs.existsSync(full))
                    return full;
            }
        }
    }
    return null;
}
// one recording at a time is enforced by the caller, not here. this function
// assumes it is allowed to start and does not clean up a previous child.
function start_recording(opts, on_output) {
    const fallback = opts.language === "python" ? ".py" : ".js";
    let recorder = opts.recorder ??
        path.join(opts.extension_root, "recorders", opts.language, `wakeline_recorder${fallback}`);
    let cmd = opts.command;
    if (!cmd) {
        throw new Error(opts.language === "python" ? "no python interpreter found" : "no node found");
    }
    // use prebuilt go binary if available
    if (opts.language === "go") {
        const gobin = path.join(opts.extension_root, "recorders", "go", "go");
        if (fs.existsSync(gobin)) {
            cmd = gobin;
            recorder = gobin; // not used
        }
    }
    // flags first, then a literal -- so anything the user put in run_args is
    // passed to their program and can never be mistaken for a recorder flag.
    const args = opts.language === "go" && cmd.includes("recorders/go/go") && !cmd.endsWith(".go")
        ? [
            "--file",
            opts.file,
            "--name",
            opts.name,
            "--lines",
            `${opts.line0}:${opts.line1}`,
            "--out",
            opts.out,
            "--max-calls",
            String(opts.caps.max_calls),
            "--max-events",
            String(opts.caps.max_events),
            "--max-bytes",
            String(opts.caps.max_bytes),
            "--mask",
            opts.masked.join(","),
            "--",
            ...split_args(opts.extra_args),
        ]
        : [
            ...(opts.prefix ?? []),
            recorder,
            "--file",
            opts.file,
            "--name",
            opts.name,
            "--lines",
            `${opts.line0}:${opts.line1}`,
            "--out",
            opts.out,
            "--max-calls",
            String(opts.caps.max_calls),
            "--max-events",
            String(opts.caps.max_events),
            "--max-bytes",
            String(opts.caps.max_bytes),
            "--mask",
            opts.masked.join(","),
            "--",
            ...split_args(opts.extra_args),
        ];
    // no shell anywhere. the interpreter and the script are separate argv
    // entries, which keeps spaces and quotes in paths from turning into commands.
    // detached on posix gives the recorder its own process group, so the whole
    // tree can be signalled at once.
    const child = (0, child_process_1.spawn)(cmd, args, {
        cwd: opts.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // tool paths travel as environment variables. it keeps the flag list the
        // same for every recorder and avoids quoting a path twice.
        env: { ...process.env, ...(opts.env ?? {}) },
    });
    live.add(child);
    let cancelled = false;
    let timed_out = false;
    let finished = false;
    let size_timer;
    let timeout_timer;
    const clean = () => {
        if (finished)
            return;
        finished = true;
        if (size_timer)
            clearInterval(size_timer);
        if (timeout_timer)
            clearTimeout(timeout_timer);
        live.delete(child);
    };
    const cancel = () => {
        if (finished)
            return;
        cancelled = true;
        kill_tree(child);
    };
    timeout_timer = setTimeout(() => {
        timed_out = true;
        kill_tree(child);
    }, opts.timeout);
    // the recorder enforces its own cap. this catches a broken recorder or stray writes.
    size_timer = setInterval(() => {
        fsp.stat(opts.out).then((st) => {
            if (finished)
                return;
            if (st.size > opts.caps.max_bytes + 1024 * 1024)
                kill_tree(child);
        }, () => { });
    }, 1000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s) => on_output(s));
    child.stderr?.on("data", (s) => on_output(s));
    // resolve once, on whichever comes first: a spawn error or a normal exit.
    // the cancel and timeout flags are read at that moment, so the caller can tell
    // a crash from a deliberate stop.
    const done = new Promise((resolve) => {
        child.once("error", (err) => {
            on_output(`wakeline: ${err.message}\n`);
            clean();
            resolve({ code: null, signal: null, cancelled, timed_out, out: opts.out });
        });
        child.once("exit", (code, signal) => {
            clean();
            resolve({ code, signal, cancelled, timed_out, out: opts.out });
        });
    });
    return { done, cancel };
}
function kill_tree(child) {
    // posix: the recorder is its own process group, so -pid takes the whole tree
    if (!child.pid || child.killed || killing.has(child))
        return;
    killing.add(child);
    if (process.platform === "win32") {
        const k = (0, child_process_1.spawn)("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
        });
        k.unref();
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    }
    catch {
        try {
            child.kill("SIGTERM");
        }
        catch {
            return;
        }
    }
    // give the recorder a moment to flush and exit, then force it. the pid is
    // captured now because the child object may be gone by the time the timer
    // fires, and a reused pid must not be killed.
    const pid = child.pid;
    const hard = setTimeout(() => {
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch {
            try {
                child.kill("SIGKILL");
            }
            catch {
                // already gone
            }
        }
    }, 1500);
    hard.unref();
    child.once("exit", () => clearTimeout(hard));
}
function split_args(text) {
    // not a full shell parser: quoted chunks stay whole, the rest splits on whitespace
    if (!text.trim())
        return [];
    return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? [];
}
