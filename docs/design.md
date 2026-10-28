# wakeline design

## what it does

the user right-clicks a function, picks "record this function", and runs their program normally. wakeline
records every call to that function while the program keeps running. afterwards the user scrubs a timeline in
the editor and sees what each local variable held after every executed line.

recording one function, not the whole program, is the point. the overhead stays local and the recording stays
small enough to read.

## architecture

two layers, one contract between them.

```
+----------------------------- vs code extension host -----------------------------+
|                                                                                  |
|  commands ---> function find ---> run controller ---> recording store            |
|                                      |                      |                    |
|                                      | spawn                | read               |
|                                      v                      v                    |
|                              +----------------+      +------------------+        |
|                              | recorder child |      | recording reader |        |
|                              +----------------+      +------------------+        |
|                                                             |                    |
|  editor decorations <--- timeline panel <-------------------+                    |
|                                                                                  |
+----------------------------------------------------------------------------------+
         | spawn (python or node)                 ^ json lines on disk
         v                                        |
+----------------------------- recorder process ----------------------------------+
|  entry point -> install tracer -> run user program -> serialize -> write jsonl  |
|                        |                                                         |
|                        v                                                         |
|                  user's program                                                  |
+----------------------------------------------------------------------------------+
```

the extension owns: commands, finding the target function, spawning and killing the recorder, reading the
recording, the webview, and the editor decorations. it never inspects the user's language runtime.

a recorder owns: running the user's program, tracing or instrumenting exactly one function, serializing values,
enforcing caps, and writing json lines. it knows nothing about vs code.

recorders ship inside the extension as source files and are launched with the user's own interpreter. nothing is
installed into the user's environment.

## data flow, right-click to ghost values

1. the user puts the cursor in a function and picks "record this function" from the editor context menu.
2. the extension checks workspace trust and refuses in an untrusted workspace.
3. function find locates the enclosing function: file path, qualified name, start and end line.
4. the extension resolves an interpreter (python or node) and a working directory.
5. it asks the run controller to start. only one recording runs at a time.
6. the run controller spawns `recorders/python/wakeline_recorder.py` or `recorders/javascript/wakeline_recorder.js`
   with the target identity, output path, caps, and the passthrough argv.
7. the recorder starts the user's program, installs its tracer or instruments the one function, and appends json
   lines to the output file as calls happen.
8. stdout and stderr from the user's program stream to a wakeline output channel. the program is never paused.
9. caps or the user's cancel/timeout stop the recorder cleanly. the recorder writes a final marker and exits with
   the user's program's exit code.
10. the run controller sees the exit, keeps the recording if it has at least a header and one call, and offers
    "open timeline".
11. the recording reader opens the file, validates the version and header, and builds an index of call offsets.
    it reads one call at a time instead of loading the file.
12. the timeline panel posts the selected call and step to the extension. decorations render ghost values, dim
    lines that did not run, and highlight the current line.

## extension modules

- `src/extension.ts` - activation, commands, run wiring, status bar and output channel.
- `src/function_find.ts` - document symbols first, text scan second.
- `src/text_find.ts` - pure python and javascript function detection, used when symbols are missing.
- `src/settings.ts` - typed reads of `wakeline.*` configuration with defaults.
- `src/run.ts` - spawn, cancel, timeout, file size backstop, process tree cleanup.
- `src/storage.ts` - recordings folder, file names, retention, latest lookup.
- `src/recording_reader.ts` - incremental json lines reader, version check, call index.
- `src/format.ts` - types and validation for recording lines and encoded values.
- `src/timeline_panel.ts` - webview lifecycle and message passing.
- `src/decorations.ts` - ghost values, dimming, current line, compare decorations.
- `src/compare.ts` - divergence between two calls.
- `webview/timeline.css`, `webview/timeline.ts` - the panel, no framework.
- `recorders/python/wakeline_recorder.py` plus a few modules - trace and serialize.
- `recorders/javascript/wakeline_recorder.js` plus a few modules - instrument and serialize.

the javascript recorder source is split for readability and bundled into `core.cjs` with esbuild so the
recorder process does not need a `node_modules` directory of its own.

## function identity

python:
- use the document symbol provider to find the function containing the cursor. if it returns nothing, fall back
  to scanning upward for a `def`/`async def` whose indentation block contains the cursor.
- qualified name is built by walking enclosing classes and functions, e.g. `store.item.total`.
- identity is `(language, absolute file path, qualified name, start line, end line)`.
- the recorder locates the function by matching file, `__qualname__`, and `co_firstlineno` inside the line range.

javascript:
- use the document symbol provider first, then an ast scan of the file. accept function declarations,
  expressions, arrow functions, and class methods.
- qualified name is built from enclosing class and function names, e.g. `cart.total`.
- identity is `(language, absolute file path, qualified name, start line, end line)`.
- the recorder parses the file and picks the function node whose start line matches the identity, then instruments
  only that node.

the python recorder takes the identity as argv. the javascript recorder takes it as argv too, then passes it
to the instrumented child through lowercase environment variables so the preload hook can read it without
another config file. the command line still shows up in logs and reproductions:

```
python wakeline_recorder.py --file /abs/target.py --name store.item.total --lines 12:40 --out /abs/rec.jsonl \
  --max-calls 100 --max-events 10000 --max-bytes 10485760 -- python_target.py --flag value
```

## run lifecycle

start:
- refuse if the workspace is untrusted, no editor is open, no function is found, or a recording is already running.
- create the output path under global storage before spawning, so a crash leaves a findable partial file.
- spawn with an argv array and no shell. cwd is the workspace folder root when the file belongs to one, otherwise
  the file's directory.

observe:
- pipe stdout and stderr to a shared output channel, prefixing nothing. users want their program's output as is.
- a status bar item shows "recording". a progress notification has a cancel button.
- the recorder owns caps. the controller additionally enforces the timeout and a hard output size backstop.

cancel:
- posix: send sigterm, wait a short grace period, then sigkill the process group.
- windows: `taskkill /pid <pid> /t /f`.
- after either, close the pipes and keep whatever the recorder wrote. a process killed mid-write may lose its
  last line; the reader drops an incomplete tail and treats a missing call_end as an interrupted call.

cleanup:
- all live children live in one set owned by the run controller.
- `deactivate` kills every child synchronously where the platform allows and removes listeners.
- no child survives the extension host if it can be avoided; a killed child may leave its own grandchildren, so
  spawn detached groups on posix to make group kill possible.

## recording storage

- root: `context.globalStorageUri.fsPath/recordings`. vs code creates and owns it per profile.
- name: `<language>_<sanitized qualified name>_<epoch ms>.jsonl`. sanitizing keeps `[a-z0-9_.-]`, replaces the
  rest with `_`.
- no sidecar files. the header and `call_start` lines carry everything needed.
- retention: keep the newest `wakeline.retention` recordings per qualified name, delete older ones after a
  successful run. "clear recordings" removes the whole recordings folder and recreates it.
- a recording is never written into the workspace by default, so it does not pollute the user's repo.

reading incrementally:
- a first pass reads fixed-size chunks and splits lines by hand, validating the header and recording byte offsets
  for each `call_start` and `call_end`.
- the reader keeps only the index (call id, function, start/end offsets, outcome, duration). the current call's
  events are read on demand, capped at 50,000 in memory, so a huge file does not become one giant array.
- the webview asks for a call by id; the extension reads that byte range and posts only what the view needs.
  step detail is read again if the user switches calls.

## ui

editor decorations:
- ghost values use `TextEditorDecorationType` with `after` content at the end of the line where the value
  belongs. color comes from a theme color so light, dark, and high contrast all stay readable.
- short values inline. values over a width budget are shortened and get the truncation marker. the full encoded
  value is available on hover as a formatted string.
- dimming uses opacity on lines that have no line event in the selected call. the current line is never dimmed.
- the current step's line gets a subtle background highlight.
- in compare mode the ghost text shows `a = x   b = y` on the divergence line, and only while the selected step is
  that line.

timeline webview (plain html, css, typescript):
- top bar: call picker with search and filter, recording status, cap warnings.
- middle: the source steps for the selected call as a virtualized list, each row showing line number and values.
- bottom: scrubber, play/pause, step back/forward, and a step counter.
- loop collapse groups consecutive repeated line patterns into one row with an iteration count, so a 5000 loop
  is one row until expanded. there is no on/off switch; clicking a group expands it.
- long lists are virtualized: only visible rows are in the dom.
- plain text labels, no icons that need a font, no emoji.

compare view:
- pick a call from the call picker, or use "compare with previous call".
- "compare with call id" accepts an id from the picker and compares it with the selected call.
- the panel splits into two columns aligned at the first divergence, with the divergence row marked in both.
- a one-line summary is generated from the data, e.g. `same until line 42, then total is 7 on the left and 9 on
  the right`. when one call threw, the summary says that plainly.

compare algorithm:
- both calls are read as their ordered line events. the two sequences are zipped by step index; they are not
  aligned by loop iteration.
- at each index, a different source line is the first divergence. when the lines match, every variable name in
  either snapshot is compared by its encoded value. `wakeline.compare_ignore` globs drop names before comparing.
- if one sequence runs out first, the extra steps are the divergence. if the lengths match but the outcomes
  differ, that is reported at the last step.
- the panel renders only a 40-event window around the divergence, not both full calls.

empty and error states:
- no recording open: a short line saying no recording is loaded.
- recording with no calls: "the function was never called", or the recorder failure message when one was written.
- newer format: a clear refusal naming the recording version and the extension's supported version.
- stale recording (file changed since the run): a note in the panel status line; decorations still render by line
  number.
- cap hit: the panel status line names the cap and the step where recording stopped.
- truncated value: the truncation marker inline and the reason on hover.

## caps and performance

three caps, all configurable, all enforced inside the recorder:
- max calls: stop tracing the target function after this many calls. the program continues.
- max events per call: stop recording events for that call, write a `cap_hit` carrying that call id, and let the
  call finish untraced.
- max bytes: stop recording entirely when the file passes this size, write a `cap_hit`, and let the program finish.
  the file can overshoot by at most the line being written, so the last call may have no `call_end`.

when a global cap hits, the recorder never throws into the user's code and never stops the program. it stops
tracing or writing new events and leaves the marker. a per-call event cap only silences that call; other calls
are still recorded.

serialization is bounded separately: max depth, max items per collection, max string length, max bytes per value.
cycles become reference markers. objects whose `repr`/getters throw become opaque values. nothing imports numpy
or any other heavy library.

the reader is incremental as described above. the webview virtualizes long lists. all parsing happens off the
main decoration path with small chunks, and the extension host never reads a whole recording into one string.

## security and workspace trust

- `vscode.workspace.isTrusted` is a hard gate for every run. an untrusted workspace gets an explanation and no
  process is spawned.
- the extension makes no network calls. recordings stay on disk in global storage.
- child processes are spawned with argv arrays, never a shell string.
- interpreter paths from settings are used as-is; if they do not exist the run fails before spawning.
- recordings contain user program data. they are not scanned, uploaded, or shared. variable masking by name pattern
  is applied at serialization time in both recorders, before a value reaches the file.

## platform notes

- paths go through node's `path`; recorders receive absolute paths.
- line endings do not matter to the format (json lines are read by content), but the javascript recorder maps
  inserted hooks without adding newlines so line numbers stay exact on both lf and crlf files.
- python discovery order: the python extension's configured interpreter if it is available, then
  `wakeline.python_path`, then `python3`/`python` on path.
- node discovery order: `wakeline.node_path`, then `node` on path.
- process tree kill differs: process groups on posix, `taskkill /t` on windows.

## known limits

- python tracing uses `sys.settrace`, so tight loops pay a real cost. caps and recording only one function keep
  it usable but this is not a profiler.
- python 3.8+ only. `sys.monitoring` is not used in v0.1; one code path is easier to keep correct.
- javascript supports `.js`, `.mjs`, `.cjs`. typescript source is not instrumented in v0.1; transpile first.
  a later version can run it through esbuild and map back.
- code produced by `eval` or `new Function` is not instrumented.
- one target function per recording. recording several at once is out of scope.
- async javascript functions record the synchronous steps of each invocation. steps on opposite sides of an
  `await` belong to the same call id, but the program may interleave other calls in between.
- python generators and coroutines are one call from first resume to final completion; a generator that is created
  but never iterated produces no call.
- values are bounded, so very large structures are shown truncated by design, not in full.
- deeply recursive calls can exhaust the interpreter's own stack; wakeline does not change recursion limits.
