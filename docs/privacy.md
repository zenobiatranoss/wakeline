# privacy

wakeline is local software. there is no account, no telemetry, no crash reporting and no network client in the
extension or in either recorder.

## what is stored

- recordings are written under `context.globalStorageUri.fsPath/recordings`, which is inside vs code's per-profile
  storage. they are not written into the workspace.
- one file per run, named `<language>_<function>_<epoch ms>.jsonl`.
- a recording contains arguments, locals, return values, exceptions and timing for the selected function. it can
  contain secrets if those values reach the function.
- recordings are kept per function according to `wakeline.retention` (default 10). older files are deleted.
- `wakeline: clear recordings` removes the recordings directory and recreates it.

## what leaves the machine

nothing. the extension spawns the configured python or node interpreter and reads the resulting file. there is no
http client, socket, upload or remote logging path in `src/`, `recorders/` or `webview/`.

the webview loads two local files from the extension: `out/webview.js` and `webview/timeline.css`. its content
security policy allows no remote scripts, styles, frames or connections.

## when a program runs

recording executes the file that contains the selected function. that is why `vscode.workspace.isTrusted` is a
hard gate: in an untrusted workspace no process is started and the user gets a warning. there is no override
setting.

the recorder child is spawned with an argv array, not a shell string, in its own process group on posix. cancel,
timeout and extension shutdown kill the group.

## masking

`wakeline.variable_masking` takes names or glob patterns. matching is case-sensitive and applies to parameter and
local names at serialization time, so the value is replaced before it is written:

```
["password", "token", "*secret*", "api_*"]
```

the key remains in the recording, with `{"$":"opaque","cls":"masked","why":"masked"}` as its value. the ui shows
`<masked>`. masking only affects recorded values; the program still sees the real data.

comparison has a separate list, `wakeline.compare_ignore`, for names that differ on purpose and should not count as
a divergence. it does not hide anything already written.

## deleting data

recording files are ordinary files. removing the folder, running `wakeline: clear recordings`, or uninstalling the
extension with its storage is enough. no copy is kept elsewhere.
