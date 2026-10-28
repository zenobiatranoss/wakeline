import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");
const here = dirname(fileURLToPath(import.meta.url));
// esm has no --require, so the instrumented module imports this hook at the top
// instead. it installs the runtime global before the rest of the module runs.
const runtime_url = pathToFileURL(join(here, "runtime_hook.mjs")).href;

export async function load(url, context, nextLoad) {
  // node's loader hook. let everything that isn't the target through, then
  // rewrite the target's source on the way out.
  const opts = core.set_options_from_env();
  if (!(await is_target(url, opts.file))) return nextLoad(url, context);

  // read the file ourselves rather than trusting result.source, which may be
  // absent in some node versions when the default loader handles it.
  const result = await nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  let code;
  try {
    code = core.instrument(source, opts);
  } catch (err) {
    core.failure("instrument", err);
    return result;
  }
  return {
    format: "module",
    source: add_hook(code, runtime_url),
    shortCircuit: true,
  };
}

async function is_target(url, file) {
  // realpath both sides to survive symlinks and file url encoding.
  if (!file) return false;
  try {
    const a = await realpath(file);
    const b = await realpath(fileURLToPath(url));
    return a === b;
  } catch (err) {
    return url === pathToFileURL(file).href;
  }
}

function add_hook(source, hook) {
  // the import has to come after a shebang or node treats the whole file as a
  // shell script. otherwise it goes at the very top, before any user imports.
  const line = `import ${JSON.stringify(hook)};`;
  if (!source.startsWith("#!")) return line + source;
  const end = source.indexOf("\n");
  if (end < 0) return source + "\n" + line;
  return source.slice(0, end + 1) + line + source.slice(end + 1);
}
