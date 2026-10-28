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
`build`).

not done yet: everything else. recorders are empty directories.

next: stage 2, recording format types and reader, python recorder and its tests.

## stage 2: recording format and python recorder

done:
- `src/format.ts`: supported version, line validation with line/byte context, `format_error`, value rendering
- `src/recording_reader.ts`: incremental chunked index with per-call byte offsets, bounded line length, crlf,
  half-written tail, interrupted calls, `meta`, caps, and `failure`
- python recorder split into `wakeline_recorder.py` (cli), `wk_trace.py` (tracing), `wk_encode.py` (bounded
  values), `wk_writer.py` (thread-safe jsonl writer)
- tracing only the selected code object: recursion, generators and coroutines as one call, exceptions, threads,
  caps, masking
- pass-through of argv, exit code, `__main__`, and `-m` module runs
- bounded encoding: depth, items, string, per-value bytes, refs and cycles
- fixtures plus `test/python/test_recorder.py` (22 tests) and `test/format.test.ts` (17 tests)

verified here:
- `npm run build` - esbuild bundles without errors
- stage 2 typecheck - `npx tsc --noEmit --strict` on `src/format.ts` and `src/recording_reader.ts` is clean
- `npm run test:python` - `Ran 22 tests in 1.023s` / `OK`
- `npm run test:ts` - `# tests 17`, `# pass 17`, `# fail 0`

notes:
- repo-wide `npm run check` currently reports errors in later-stage files being written in parallel
  (`src/extension.ts`, `src/timeline_panel.ts`), not in the stage 2 reader or format. `tsconfig.test.json` is
  scoped to the stage 2 files so those tests stay runnable.
- the reader and format are bundled into the extension, but the four commands still report not implemented while
  later stages land.
- `max_bytes` can overshoot by at most one line and may leave the last call without `call_end`; the reader marks
  that call interrupted instead of inventing an outcome.

next: stage 3, the javascript recorder.

## stage 3: javascript recorder

done:
- `recorders/javascript/wakeline_recorder.js` is the cli. it chooses commonjs or esm, then starts node again with
  `preload.cjs` or `loader.mjs` so a crash in the recorder does not take the user's program with it
- `instrument.js` parses with acorn and rewrites only the selected function. declarations, expressions, arrows,
  class methods, async functions, generators, destructuring, loops, `try`/`catch`/`finally` and early returns get
  line events. the original source is used unchanged if the rewrite or recompile fails
- `runtime.js` owns call ids, depth, caps and the hooks the instrumented code calls. `encode.js` handles values
  with the same limits as the python side, including cycles, throwing getters, maps, sets, buffers, bigint,
  symbols and functions
- line numbers stay on original source lines. the unbundled sources are bundled into `core.cjs` so the shipped
  extension does not need a `node_modules` directory
- `test/recorder.test.ts` covers commonjs, esm, function kinds, recursion, thrown errors, async/generator calls,
  safe-integer handling, paths with spaces and non-ascii characters, cycles, bad getters, huge arrays, caps and
  masking. the output is read back with the same `index_file` the extension uses

verified here:
- `npm run build` - the recorder bundle builds
- `npm run test:ts` - the recorder tests pass alongside the stage 2 reader tests

not done here:
- no separate cross-language test that records the same algorithm in python and javascript and compares the two
  recordings step for step. both recorder suites do validate their output with the same reader.
- typescript files are refused rather than transpiled. that is the documented 0.1.0 behavior.

next: stage 4, extension core: commands, running and storage.

## stage 4: extension core

done:
- `src/function_find.ts` asks vs code's document symbol provider first, then falls back to `src/text_find.ts`.
  python is matched by indentation; javascript uses regexes plus a brace matcher that skips strings and comments
- the four commands from stage 1 now do real work: record this function, stop recording, open last recording,
  clear recordings. workspace trust is checked before anything is spawned
- `src/run.ts` resolves the interpreter, spawns with an argument array and no shell, streams output, enforces the
  timeout, kills the process tree on posix and windows, and cleans up on deactivate
- `src/storage.ts` writes recordings under global storage, groups them by language and function for retention,
  and finds the newest recording
- `src/settings.ts` reads every `wakeline.*` setting with defaults that mirror `package.json`
- `starting` and `active` guards stop two record commands from racing. the status bar and output channel show
  what is happening
- `test/text_find.test.ts` and `test/run.test.ts` cover function detection, interpreter lookup, a missing command,
  a normal exit, cancel and timeout

verified here:
- `npm run build` and `npm run check` clean
- `npm run test:ts` passes the function finding and launcher tests, including spawned recorder processes that are
  killed again

not done here:
- no `@vscode/test-electron` suite. the commands, status bar, output channel and trust check have not been driven
  by a real extension host in this version. `docs/manual-test.md` is the checklist for that.
- the context menu is contributed only for python and javascript files, but that gate has not been exercised in a
  real window.

next: stage 5, ghost values and the timeline.

## stage 5: ghost values and the timeline

done:
- `src/decorations.ts` renders ghost values for executed lines, dims lines that did not run, and highlights the
  current line. long values are shortened inline and shown in full in a hover
- `src/timeline_panel.ts` owns the webview lifecycle and the current call, step and compare state. late reads are
  dropped with a load-sequence check when the user picks another call
- `webview/timeline.ts` is plain html, css and typescript with no framework. it has a scrubber, play/pause,
  prev/next, a searchable call picker, loop folding and a virtual list that keeps only visible rows in the dom
- editor cursor moves jump the timeline to the nearest step, and stepping in the panel moves the editor
  highlight. keyboard shortcuts are registered commands so they can be rebound
- stale source, cap hits, truncated values, interrupted calls and an empty recording all get a plain status line
- the webview csp allows inline styles only because the virtual list sets spacer heights. scripts remain
  nonce-gated and `default-src` is still `none`

verified here:
- `npm run build` builds the extension, webview and recorder bundles
- `npm run check` clean
- `npm run test:ts` covers the reader and recorder paths the timeline depends on

not done here:
- no automated tests for the step model, loop folding or decoration ranges. those are checked by hand only.
- a synthetic 500k-event recording was not timed. `docs/performance.md` says which performance areas were
  skipped.
- no extension-host test has driven the panel or the editor decorations.

next: stage 6, compare two calls.

## stage 6: compare two calls

done:
- `src/compare.ts` compares two calls position by position. it reports the first different line, the first
  different value on a shared line, a call that keeps going after the other ends, and the same steps ending in a
  different outcome
- ignored names are filtered with the same glob style as masking. the algorithm and the positional choice are
  written up in `docs/design.md` and `docs/decisions.md`
- the panel shows two columns around the divergence, with the split row highlighted. the editor shows `a` and `b`
  values together when compare is active
- commands: compare with previous call, compare with call id, jump to divergence
- calls that never diverge, calls of different lengths, and one call throwing while the other returns all have
  tests

verified here:
- `npm run test:ts` - the compare suite passes, including identical calls, early and late divergence, ignored
  names, different lengths, different outcomes, loops with different iteration counts and recursion

notes:
- steps are zipped positionally. loops with different iteration counts diverge at the first extra step instead of
  aligning iterations. this is deliberate for 0.1.0 and is on the 0.2 list.

next: stage 7, hardening, packaging and release prep.

## stage 7: hardening and packaging

done:
- robustness fixes: a late `stat` callback no longer kills a finished child; `kill_tree` dedupes per child and
  cancels the delayed `SIGKILL` on exit; a missing command is refused before spawn; paths with spaces and
  non-ascii characters have a recorder test; corrupt and interrupted recordings are handled by the reader
- `docs/performance.md` records real recorder overhead. on this machine a 10m-call hot loop went from
  0.457-0.481 s to 0.481-0.503 s under python, and from 0.031-0.037 s to 0.438-0.482 s under node. the default
  100-call recording wrote 303 lines and about 21 KiB before `max_calls`
- `docs/privacy.md` documents local-only storage and the masking setting. recording refuses to start in an
  untrusted workspace
- readme, changelog, license, icon, marketplace fields and an honest limits section are in place
- `.vscodeignore` keeps source, tests, docs and ci config out of the vsix. only `core.cjs` and the entry scripts
  ship from the javascript recorder
- `.github/workflows/ci.yml` builds, lints and runs both test suites on ubuntu, macos and windows, and packages
  the vsix on ubuntu
- `docs/manual-test.md` lists the checks that need a real window

verified here:
- `npm run build` - all three bundles build
- `npm run check` - `tsc --noEmit` and `eslint src` both clean
- `npm run test:python` - 22 tests pass
- `npm run test:ts` - the full suite passes
- `npx @vscode/vsce package` produced a vsix

not run here:
- the ci workflow has not run on github. macos and windows are unverified.
- the manual checklist has not been filled in for any platform.
- the vsix was built and inspected, not installed into a second vs code profile.
- extension host cpu while indexing very large recordings, webview rendering on a slow machine, and a 500k-event
  timeline were not measured.

next: stage 8, final audit.

## stage 8: final audit

done:
- removed repeated comment blocks, narration that restated the code, and the duplicated explanations that had
  crept into the recorders, extension and webview
- searched source, tests and recorders for capital letters in identifiers created for this project. the only hits
  are external api names (`ChildProcess`, `acquireVsCodeApi`, `Module`) and fixed-name files
- checked for emoji and non-english text. the only non-ascii character is in a test path that is deliberately
  non-ascii
- reviewed race conditions in process handling, late reads in the timeline, the `kill_tree` retry path, and the
  clear/record and record/record guards
- corrected the compare algorithm description, the sigterm claim, the numeric and truncation docs, and the stage
  numbering in this file
- wrote `docs/audit.md` with what was checked, changed, left unverified and still limited

final verification on linux 6.12 x86_64, node 22.23.3, python 3.13.5:

```
npm run build       extension, webview and recorder bundles built
npm run typecheck   tsc --noEmit, no output
npm run lint        eslint src, no output
npm run test:python Ran 22 tests in 0.993s / OK
npm run test:ts     # tests 46 / # pass 46 / # fail 0
npx @vscode/vsce package
                    packaged wakeline-0.1.0.vsix (19 files, 94.7 KB)
```

`unzip -l` shows 19 files. there is no `__pycache__`, no `.pyc`, no `src/`, `test/` or `docs/`, and only the
bundled `core.cjs` from the javascript recorder sources.

not verified:
- no real vs code window run, no extension-host tests, and no platform other than linux.
- the ci workflow has still not run on github.
- the 500k-event timeline and editor scrub timings are not measured.
- the vsix was not installed into a second profile.

next: run `docs/manual-test.md` in a real window on each platform, then tag 0.1.0 if it holds up.
