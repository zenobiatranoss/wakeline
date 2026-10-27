const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// typescript entry point. the javascript recorder already knows how to
// instrument .js files, so this just compiles the target with tsc to
// temp output and runs that through the js recorder. keeps one recording
// format for both.

const argv = process.argv.slice(2);
const args = {};
const rest = [];
let extra = false;

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
if (!/\.(ts|mts|cts)$/.test(full)) {
  fail("typescript recorder needs a .ts/.mts/.cts file", 2);
}

// use the ts api that's bundled with the extension. if it's not there for
// some reason, fall back to the globally available tsc.
const ts = try_require("typescript");
const os = require("os");

function try_require(name) {
  try {
    return require(name);
  } catch (e) {
    return null;
  }
}

function compile_to_js(src) {
  if (!ts) {
    // last ditch: try running tsc as a process
    return compile_with_process(src);
  }
  // avoid pulling in node types or strict config that would break user code.
  // just transpile the target file with defaults that don't mangle line numbers.
  const code = fs.readFileSync(src, "utf8");
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      sourceMap: false,
      removeComments: false,
    },
    fileName: src,
  });
  if (result.diagnostics && result.diagnostics.length) {
    // surface the first real error
    const d = result.diagnostics[0];
    const msg = ts.flattenDiagnosticMessageText ? ts.flattenDiagnosticMessageText(d.messageText, "\n") : String(d.messageText);
    throw new Error(msg);
  }
  return result.outputText;
}

function compile_with_process(src) {
  const { execSync } = require("child_process");
  const tmp = path.join(os.tmpdir(), `wakeline_ts_${Date.now()}_${process.pid}.js`);
  try {
    execSync(`npx tsc --outDir ${path.dirname(tmp)} --module commonjs --target es2020 --sourceMap false ${JSON.stringify(src)}`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    // tsc may emit next to source or into outDir; look for the .js next to src first
    const near = src.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js");
    if (fs.existsSync(near)) return fs.readFileSync(near, "utf8");
    if (fs.existsSync(tmp)) return fs.readFileSync(tmp, "utf8");
  } catch (e) {
    if (e.stdout) process.stderr.write(e.stdout.toString());
    if (e.stderr) process.stderr.write(e.stderr.toString());
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
  throw new Error("could not compile typescript");
}

let compiled;
try {
  compiled = compile_to_js(full);
} catch (e) {
  fail(`typescript compile failed: ${e.message}`, 2);
}

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeline_ts_"));
const jsfile = path.join(tmpdir, path.basename(full).replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js"));
fs.writeFileSync(jsfile, compiled, "utf8");

// delegate everything to the js recorder. pass the same flags and user args.
const jsrec = path.join(__dirname, "..", "javascript", "wakeline_recorder.js");
const child_args = [
  jsrec,
  "--file",
  jsfile,
  "--name",
  args.name || "",
  "--lines",
  args.lines || "1:1",
  "--out",
  out,
  "--max-calls",
  args["max-calls"] || "100",
  "--max-events",
  args["max-events"] || "10000",
  "--max-bytes",
  args["max-bytes"] || "0",
  "--mask",
  args.mask || "",
  "--",
  ...rest,
];

// the user's program might import modules relative to the original file's location.
// run from the original directory so relative requires resolve the same way.
const child = spawn(process.execPath, child_args, { cwd: path.dirname(full), env: process.env, stdio: "inherit" });
let leaving = false;

child.on("error", (err) => {
  console.error(`wakeline: cannot start node: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (leaving) return;
  leaving = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(sig, forward);
  // clean up temp file
  try { fs.unlinkSync(jsfile); } catch (_) {}
  try { fs.rmdirSync(tmpdir); } catch (_) {}
  if (code !== null) process.exit(code);
  process.exit(signal ? 1 : 0);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward);

function forward(sig) {
  if (leaving) return;
  try { child.kill(sig); } catch (_) {}
}

function fail(message, code) {
  console.error(`wakeline: ${message}`);
  try {
    const lines = [
      JSON.stringify({ k: "ver", v: 1 }),
      JSON.stringify({ k: "failure", why: message, where: "start" }),
    ];
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, lines.join("\n") + "\n");
  } catch (_) {}
  process.exit(code);
}
