# roadmap

## v0.1

the release candidate this chain builds.

- python recorder: `sys.settrace`, one target function, arguments, locals after each line, return value,
  exceptions, recursion, generators, async, threads, serialization bounds, caps.
- javascript recorder: ast instrumentation of the one target function for `.js`, `.mjs`, `.cjs`, the same
  recording format and the same caps.
- extension core: function detection for python and javascript, "record this function", run control with
  cancel and timeout, workspace trust gate, recordings in global storage with retention, status bar and output
  channel.
- timeline: scrubber, play/pause, step, call picker with search, loop collapse, ghost values, dimming, current
  line highlight, stale/truncated/cap/no-call states, incremental reading, virtualized lists.
- compare: divergence algorithm, side-by-side view, summary line, ignore-variable list.
- packaging: vsce package, marketplace metadata, readme limits section, changelog, ci on linux/macos/windows,
  manual test checklist.

## v0.2

- typescript source support in the javascript recorder via esbuild transpile with line mapping.
- `sys.monitoring` fast path on python 3.12+, behind the existing recorder interface.
- better loop alignment in compare for different iteration counts.

## v1.0

- multiple recorded functions per run.
- stable compare summaries across async and generator calls.
- configurable follow-up: record until the program ends or until a chosen call count, without re-running.
- more languages, each one a new recorder only: go and java are the intended candidates.
- deeper windows path and long-path handling.
- recording compression for very large runs.

## not in 0.1.0 yet

these have recorders in the repo but are behind `wakeline.experimental_languages`, or left out of the package.

- typescript: the recorder needs the `typescript` package at run time, and the recording points at the
  transpiled temp file instead of the `.ts` source. v0.2 replaces it with a transpile step that keeps a line map.
- c# and c++: the drivers rewrite the source by name match and record call boundaries only. no line events,
  no return values.
- go: the recorder records calls and arguments only (no line events, no return values) and ran only as a
  prebuilt binary next to its sources. it is not in the package. it needs line ticks and an embedded runtime
  plus a build step before it comes back.

## out of scope

- languages beyond python and javascript in v0.1 and v0.2.
- recording an entire program or every function at once.
- pausing the program at breakpoints. wakeline records without stopping it.
- sharing recordings over a network or a service. files stay local.
- an embedded profiler or test runner.
- editors other than vs code.
- a plugin system for ui extensions.
