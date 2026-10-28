# changelog

## 0.1.0 (unreleased)

first release candidate.

- python recorder using `sys.settrace`, with recursion, threads, generators, async, exceptions and bounded values
- javascript recorder using acorn instrumentation of the selected function, for commonjs and esm
- commands to record the function under the cursor, stop, reopen, clear, step and compare calls
- timeline webview with call search, loop grouping, play/pause and a scrubber
- ghost values, dimmed lines and the current line in the editor
- divergence view between two calls, with an ignore list
- caps for calls, events and file size, plus a wall-clock timeout
- recordings in global storage with per-function retention and variable masking
