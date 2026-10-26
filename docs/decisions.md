# decisions

each entry: what we picked, why, and what we rejected.

## recording format: json lines with a kind field

picked json lines, one object per line, with `k` naming the line kind and `$` naming encoded value shapes.

why: it streams. a recorder appends as it goes, the reader seeks by byte offset, a killed process leaves a
readable prefix, and no schema migration tool is needed. short field names keep the size down. the format is
versioned by a header line.

rejected: sqlite (adds a dependency, locking, and makes per-call incremental reads awkward), one json array
(cannot append or seek), and a binary format (needs a schema and a decoder in every recorder, no easy eyeballing
of a file).

## nested calls are interleaved, not nested blocks

every line event and end marker carries the call id `i`, and a call start carries depth `dp`.

why: recursion and threads produce overlapping calls. an interleaved stream is what tracing naturally produces
and needs no buffering. the reader reconstructs a tree from ids and depths.

rejected: one nested json object per call (forces buffering until the call ends, loses data if the process is
killed, and makes a recursive call hold its parent open).

## recordings live in global storage

`context.globalStorageUri.fsPath/recordings`, not `~/.wakeline` and not the workspace.

why: vs code owns the lifecycle and cleanup of global storage, it is per profile, and recordings do not end up
in the user's repo. the path is available without platform-specific code.

rejected: home directory (we would own cleanup and dotfile conventions), workspace `.wakeline/` (pollutes repos
and can be committed by accident).

## no sidecar metadata files

the header and `call_start` lines carry the function identity, caps, and timing.

why: one file per recording is simple to move, delete, and reason about. a sidecar can get out of sync and
doubles the retention bookkeeping.

rejected: a `.meta.json` next to each recording.

## function identity is file, qualified name, and line range

the extension sends all three to the recorder and the recorder matches on all three.

why: names alone are ambiguous (same name in two classes, same name in two files). line ranges pin the match to
the code the user actually right-clicked, which matters if the file changed between the click and the run.

rejected: byte offsets (change with any edit), a symbol id (does not exist across languages), name only.

## python: sys.settrace only in v0.1

picked `sys.settrace` with a predicate that only installs a local trace function for the target code object.

why: it works on python 3.8 and newer, one code path, no import hooks, no bytecode rewriting. the predicate
returns `None` for every other frame, so unrelated code pays only the global trace call.

rejected for now: `sys.monitoring` (3.12+, would mean two tracing paths to test and keep aligned), `sys.settrace`
plus bytecode rewriting (much more machinery for a marginal gain).

revisit if benchmarks show the trace predicate itself is the bottleneck; `sys.monitoring` can be added later
behind the same recorder interface.

## javascript: ast instrumentation of the selected function

picked limited ast instrumentation: parse the file, find the function node from the identity, insert same-line
hooks, run the instrumented file in the user's normal node process.

why: overhead outside the target function is zero, which is the promise of the project. line mapping can be
kept exact by inserting hooks without adding newlines. it works for commonjs and esm, for any launch path, and
for child processes, because there is no debugger attachment involved.

rejected: the node inspector protocol. it adds overhead to the whole program, depends on how node was started,
and its source mapping is harder to control exactly. it also fights with programs that already use the
inspector or run under another debugger.

parser choice: `acorn`, bundled into the extension. it is small, fast, handles modern syntax, and is used only
when recording starts, never in the user's normal runs. no code generator is used: hooks are inserted into the
source using node ranges, which avoids reformatting the user's code and keeps line numbers intact.

typescript files: not instrumented in v0.1. the recorder refuses with a clear message and the docs say to
transpile first. a later version can run the file through esbuild and map lines back.

## esbuild, zero runtime dependencies in the extension

the extension bundles to one file with esbuild. the only runtime requirement is the recorder processes, which use
the user's own python and node, with no packages installed.

justified dependencies, all build-time or dev-time:

- `esbuild` - bundler, required by the project brief. no runtime footprint in the vsix beyond the bundle.
- `typescript` - type checking and types.
- `eslint`, `@typescript-eslint/*` - lint.
- `@types/vscode`, `@types/node` - types only.
- `acorn` - later, bundled into the javascript recorder so it runs with plain node.

rejected: a test framework dependency (node's built-in `node:test` is enough), a webview framework (brief says
plain html/css/ts), and any telemetry or analytics package (no network calls).

## webview: plain html, css, typescript

why: the panel has a scrubber, a virtualized list, and a call picker. that does not justify a framework, and a
framework would add a runtime the extension does not need.

rejected: react, svelte, lit.

## workspace trust is a hard gate

no recorder process is spawned unless `vscode.workspace.isTrusted` is true. there is no setting to override it.

why: recording means running the user's program, which is exactly what trust is for. an override would be a
footgun.

rejected: a "record anyway" prompt.

## caps are enforced in the recorder, timeout in the extension

why: the recorder sees every event and can stop tracing cleanly, keeping the user's program running. the
extension cannot count events without reading the file, so its backstop is wall time and file size.

rejected: letting the extension watch file size to stop the recorder (racy and late).
