const fs = require("fs");
const path = require("path");
const Module = require("module");
const core = require("./core.cjs");

// commonjs entry point, loaded with node --require. it hooks the module loader
// so the target file is instrumented as it is compiled. everything else goes
// through untouched.

const opts = core.set_options_from_env();
core.install_global();
const target = real(opts.file);

// patching _extensions is the oldest trick in the book, but it is stable and
// works on every node version we care about. only the exact target path is
// touched; same-named files elsewhere are left alone.
for (const ext of [".js", ".cjs"]) {
  const old = Module._extensions[ext];
  Module._extensions[ext] = function (mod, filename) {
    if (real(filename) !== target) return old(mod, filename);
    const source = fs.readFileSync(filename, "utf8");
    let code;
    try {
      code = core.instrument(source, opts);
    } catch (err) {
      // instrumentation failed. record why, then run the original code: a
      // broken recording is much better than a broken program.
      core.failure("instrument", err);
      return old(mod, filename);
    }
    try {
      mod._compile(code, filename);
    } catch (err) {
      // a syntax error here means our rewrite broke the source, not the user.
      // fall back to the real thing. other errors are the program's own.
      if (!(err instanceof SyntaxError)) throw err;
      core.failure("instrument", err);
      old(mod, filename);
    }
  };
}

function real(file) {
  // compare real paths so a symlinked entry point still matches the file the
  // extension asked us to instrument.
  try {
    return fs.realpathSync(path.resolve(file));
  } catch (err) {
    return path.resolve(file);
  }
}
