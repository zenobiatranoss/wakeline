const { instrument } = require("./instrument");
const runtime = require("./runtime");

// the single module the three entry points (preload, loader, runtime hook)
// require. esbuild bundles this file into core.cjs, which is what actually
// ships. don't edit the bundle by hand.
module.exports = {
  instrument,
  failure: runtime.failure,
  set_options_from_env: runtime.set_options_from_env,
  install_global: runtime.install_global,
  get options() {
    return runtime.options;
  },
};
