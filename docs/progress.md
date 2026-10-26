# progress

## stage 1: design and scaffolding

done:
- `docs/design.md`, `docs/format.md`, `docs/decisions.md`, `docs/roadmap.md`
- git repo, package manifest, tsconfig, esbuild build, eslint config, editor launch config
- folder layout for `src/`, `recorders/python/`, `recorders/javascript/`, `webview/`, `test/`, `docs/`
- extension activates and registers the four commands; each reports that it is not implemented yet
- mit license, readme, changelog

verified here:
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- loaded `out/extension.js` under node with a stub `vscode` module, called `activate`, and saw all four
  command ids registered

not run here: a real vs code extension host window. launching one opens an interactive desktop window, so it
was not started during this stage. the launch is configured in `.vscode/launch.json` (f5, prelaunch task
`build`). real host tests start in stage 4.

not done yet: everything else. recorders are empty directories.

next: stage 2, recording format types and reader, python recorder and its tests.
