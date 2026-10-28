# v0.1.0 audit

a pass over the release candidate before it goes out. this is not a third-party
security review. it is the list of what was checked, what came back clean, and
what is still unproven.

## scope

- the extension side: commands, function finding, spawning, storage, reader,
  timeline and compare.
- both recorders: python tracing and javascript instrumentation, including the
  caps and the value encoders.
- the packaged layout: what goes into the vsix and what stays out.

## automated checks

run on linux 6.12 x86_64 with node 22.23.3 and python 3.13.5.

```
npm run build       extension, webview and bundled recorder all build
npm run typecheck   tsc --noEmit, no output
npm run lint        eslint src, no output
npm run test:python Ran 22 tests in 0.993s / OK
npm run test:ts     # tests 46 / # pass 46 / # fail 0
npx @vscode/vsce package
                    packaged wakeline-0.1.0.vsix (19 files, 94.7 KB)
```

the tests cover the format reader (including chunk boundaries, crlf and a
half-written tail), both recorders end to end, function detection, the compare
logic, and the process launcher. they do not open a vs code window.

the packaged file was listed with `unzip -l`: no `__pycache__`, no `.pyc`, no
`src/`, `test/` or `docs/`, and only the bundled `core.cjs` from the javascript
recorder sources.

## what changed in this pass

- comments: removed narration that repeated the code, cut the per-function
  comment blocks in `recorders/javascript/instrument.js`, and removed repeated
  explanations that had been added twice in the recorders, extension and
  webview. remaining comments are the ones that explain a constraint.
- names: grepped every source, test and recorder file for capital letters in
  identifiers we created. the only hits were external api names and node/vs code
  spellings. no non-english text or emoji anywhere.
- docs: added the compare algorithm to `docs/design.md` and a decision entry for
  it. removed a false claim that a recorder writes a final marker on sigterm,
  and fixed the description of how a per-call event cap differs from a global
  cap. corrected the number and truncation claims in `docs/format.md` and the
  stage numbering in `docs/progress.md`.
- race fixes: a late `stat` callback can no longer kill a child after it exited;
  the hard kill in `kill_tree` is cancelled when the child exits; repeated
  `kill_tree` calls on the same child are ignored so the pid is not signalled
  twice; opening another recording invalidates any in-flight call read.
- webview: the virtual list sets spacer heights inline, so the style policy now
  allows inline styles. script execution is still nonce-only and `default-src`
  is still `none`.
- values: a javascript integer outside the safe range is now written with the
  `int` shape instead of a lossy json number. added a recorder test for it.

## what was reviewed by hand

- **never break the user's program.** every recorder entry point turns a
  recording failure into a marker line and carries on. javascript falls back to
  the original source when instrumentation or compilation fails. python removes
  its trace in a `finally`.
- **caps stop recording, not execution.** `max_events` is per call; `max_calls`
  and `max_bytes` are global. only the first global cap is reported. a forced
  `call_end` is still written unless the byte cap stopped tracing mid-call.
- **process handling.** the child is spawned with an argument array, never a
  shell. cancel and timeout kill the process tree, and closing the window kills
  anything still running. the delayed hard kill is cancelled on exit.
- **workspace trust.** recording refuses to start in an untrusted workspace,
  before an interpreter is resolved or a process is spawned.
- **webview.** scripts are nonce-gated, `default-src` is `none`, local resources
  are limited to the extension folder, and values from the user's program are
  html-escaped before they reach the list.
- **privacy.** recordings are written under global storage. nothing is uploaded.
  `wakeline.variable_masking` hides matching names at serialization time, so the
  values never reach the file.
- **packaging.** `.vscodeignore` keeps source, tests, docs and config out of the
  vsix. the bundled `core.cjs` ships; its unbundled sources do not.

## what could not be verified

- no extension-host test suite. the commands, webview lifecycle and editor
  decorations have not been driven by `@vscode/test-electron` or by hand in a
  real window for this version. `docs/manual-test.md` is the checklist for that.
- no test records the same algorithm in python and javascript and compares the
  two recordings step for step. each recorder is checked against the shared
  reader and its own fixtures.
- the timeline's step model, loop folding and decoration ranges have no
  automated tests. they are covered by the manual checklist only.
- only linux was run here. windows and macos branches exist in the process code
  and the ci matrix names all three, but the workflow has not run on github.
- a synthetic 500k-event timeline was not timed. `docs/performance.md` reports
  recorder overhead only and says plainly which performance areas were skipped.
- the vsix was built and inspected, not installed into a second vs code profile.
- masking is a convenience, not a hard guarantee. a secret can arrive under a
  name that does not match the configured patterns, or inside a container value
  whose key is not masked.

## known limits

- the reader indexes the whole file before opening the timeline. a very large
  recording costs a linear pass, and a single call holds at most 50,000 events
  in memory.
- the editor redraws decorations from the selected call's events on every step.
  a call with tens of thousands of steps can feel slow while scrubbing.
- the call picker carries up to 5,000 calls and their encoded arguments in one
  message. the default `max_calls` is 100, so this only matters with a raised
  setting.
- compare zips steps positionally. loops with different iteration counts
  diverge at the first extra step instead of aligning iterations. better loop
  alignment is on the 0.2 list.
- typescript is refused rather than transpiled. that is deliberate for 0.1.0 and
  is the first item on the 0.2 list.
- python tracing costs real time in a hot function. `docs/performance.md` has
  the measurements and the shape of the overhead.
- a javascript generator reports the body steps and a final undefined result,
  not the yielded values. documented in the readme limits section.
- there is no per-event total size cap beyond value budgets and the reader's
  4 MiB line limit.

## verdict

the automated suite passes and the failure paths that matter were checked in
code and in the recorder tests. this is good enough to try on real code, with the
understanding that the editor-side manual checklist has not been run on any
platform yet.
