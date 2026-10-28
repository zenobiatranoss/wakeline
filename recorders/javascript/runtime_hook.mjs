import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");

// imported first by every instrumented esm module. it just makes sure the
// global the injected calls use exists and that the writer is open.
core.set_options_from_env();
core.install_global();
