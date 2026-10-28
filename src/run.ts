import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { caps } from "./settings";

export type run_options = {
  language: string;
  file: string;
  name: string;
  line0: number;
  line1: number;
  out: string;
  cwd: string;
  caps: caps;
  timeout: number;
  command: string;
  extra_args: string;
  extension_root: string;
  masked: string[];
  // the language table decides these. old callers can leave them out and get
  // the javascript recorder under extension_root, which is what the launcher
  // did before the table existed.
  recorder?: string;
  prefix?: string[];
  env?: Record<string, string>;
};

type run_result = {
  code: number | null;
  signal: string | null;
  cancelled: boolean;
  timed_out: boolean;
  out: string;
};

export type running = {
  done: Promise<run_result>;
  cancel: () => void;
};

// starts the recorder and owns the child process. the recorder is the only
// thing spawned; it runs the user's program itself. cancelling, timing out and
// killing the tree all end up here so there is one place to reason about.
const live = new Set<ChildProcess>();
const killing = new WeakSet<ChildProcess>();

// used on deactivate. if the window closes mid-recording the user's program
// should not keep running in the background.
export function kill_all() {
  for (const child of live) kill_tree(child);
  live.clear();
}

export function find_executable(setting: string, names: string[]): string | null {
  // walk PATH by hand, so this does not depend on the shell
  if (setting && path.isAbsolute(setting)) return fs.existsSync(setting) ? setting : null;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const name of setting ? [setting] : names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

// one recording at a time is enforced by the caller, not here. this function
// assumes it is allowed to start and does not clean up a previous child.
export function start_recording(opts: run_options, on_output: (text: string) => void): running {
  const fallback = opts.language === "python" ? ".py" : ".js";
  let recorder =
    opts.recorder ??
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
  const child = spawn(cmd, args, {
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
  let size_timer: NodeJS.Timeout | undefined;
  let timeout_timer: NodeJS.Timeout | undefined;

  const clean = () => {
    if (finished) return;
    finished = true;
    if (size_timer) clearInterval(size_timer);
    if (timeout_timer) clearTimeout(timeout_timer);
    live.delete(child);
  };

  const cancel = () => {
    if (finished) return;
    cancelled = true;
    kill_tree(child);
  };

  timeout_timer = setTimeout(() => {
    timed_out = true;
    kill_tree(child);
  }, opts.timeout);
  // the recorder enforces its own cap. this catches a broken recorder or stray writes.
  size_timer = setInterval(() => {
    fsp.stat(opts.out).then(
      (st) => {
        if (finished) return;
        if (st.size > opts.caps.max_bytes + 1024 * 1024) kill_tree(child);
      },
      () => {},
    );
  }, 1000);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (s: string) => on_output(s));
  child.stderr?.on("data", (s: string) => on_output(s));

  // resolve once, on whichever comes first: a spawn error or a normal exit.
  // the cancel and timeout flags are read at that moment, so the caller can tell
  // a crash from a deliberate stop.
  const done = new Promise<run_result>((resolve) => {
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

function kill_tree(child: ChildProcess) {
  // posix: the recorder is its own process group, so -pid takes the whole tree
  if (!child.pid || child.killed || killing.has(child)) return;
  killing.add(child);
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    k.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
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
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 1500);
  hard.unref();
  child.once("exit", () => clearTimeout(hard));
}

function split_args(text: string) {
  // not a full shell parser: quoted chunks stay whole, the rest splits on whitespace
  if (!text.trim()) return [];
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? [];
}
