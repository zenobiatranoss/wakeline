const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// the javascript cli. it doesn't instrument anything itself: it figures out
// whether the target is commonjs or esm, then starts node again with the right
// preload or loader. keeping the recorder in a child process means a crash in
// our code can't take the user's program with it.

const argv = process.argv.slice(2);
const args = {};
const rest = [];
let extra = false; // once -- is seen, stop treating things as our flags

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (extra) {
    rest.push(arg);
    continue;
  }
  if (arg === "--") {
    extra = true;
    continue;
  }
  // everything before -- is ours, everything after belongs to the user program.
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined) {
      console.error(`wakeline: ${arg} needs a value`);
      process.exit(2);
    }
    args[key] = value;
    i++;
    continue;
  }
  rest.push(arg);
}

const file = args.file;
const out = args.out;
if (!file || !out) {
  console.error("wakeline: --file and --out are required");
  process.exit(2);
}

const full = path.resolve(file);
if (!fs.existsSync(full)) {
  fail(`program not found: ${full}`, 2);
}
if (/\.(ts|tsx|mts|cts)$/.test(full)) {
  fail("typescript source is not instrumented in this version, transpile it first", 2);
}

// the child reads all of this from env. lowercase names because they are ours
// and won't collide with anything the program might look for.
const env = {
  ...process.env,
  wakeline_file: full,
  wakeline_out: path.resolve(out),
  wakeline_name: args.name || "",
  wakeline_line0: args.lines ? args.lines.split(":")[0] : "1",
  wakeline_line1: args.lines ? args.lines.split(":")[1] : "1",
  wakeline_max_calls: args["max-calls"] || "100",
  wakeline_max_events: args["max-events"] || "10000",
  wakeline_max_bytes: args["max-bytes"] || "0",
  wakeline_mask: args.mask || "",
};

// the only real decision: esm gets the loader because there is no --require
// for it, commonjs gets a preload.
const dir = __dirname;
const node_args = module_type(full) === "module"
  ? ["--experimental-loader", path.join(dir, "loader.mjs"), "--", full, ...rest]
  : ["--require", path.join(dir, "preload.cjs"), "--", full, ...rest];

const child = spawn(process.execPath, node_args, { cwd: process.cwd(), env, stdio: "inherit" });
let leaving = false; // stops the exit handler forwarding signals twice

child.on("error", (err) => {
  console.error(`wakeline: cannot start node: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (leaving) return;
  leaving = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(sig, forward);
  if (code !== null) process.exit(code);
  process.exit(signal ? 1 : 0);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward);

function forward(sig) {
  // the user pressing ctrl-c hits this process first. pass it down instead of
  // dying straight away so the recorder still gets to flush.
  if (leaving) return;
  try {
    child.kill(sig);
  } catch (err) {
    // child is already gone
  }
}

function module_type(target) {
  // .mjs and .cjs are explicit. a bare .js has to look at the nearest
  // package.json, walking up until the filesystem root.
  if (target.endsWith(".mjs")) return "module";
  if (target.endsWith(".cjs")) return "commonjs";
  let dir = path.dirname(target);
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        return parsed.type === "module" ? "module" : "commonjs";
      } catch (err) {
        return "commonjs";
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return "commonjs";
    dir = up;
  }
}

function fail(message, code) {
  // even a start failure writes a minimal recording. the extension shows a
  // proper message instead of "no such file" from its own reader.
  console.error(`wakeline: ${message}`);
  try {
    const lines = [
      JSON.stringify({ k: "ver", v: 1 }),
      JSON.stringify({ k: "failure", why: message, where: "start" }),
    ];
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, lines.join("\n") + "\n");
  } catch (err) {
    // nothing to add
  }
  process.exit(code);
}
