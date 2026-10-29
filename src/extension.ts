import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { clear_all, dispose_decorations, render_call } from "./decorations";
import { format_error, type index_result } from "./format";
import { find_function } from "./function_find";
import { language_by_id, language_names } from "./languages";
import { index_file } from "./recording_reader";
import { find_executable, kill_all, start_recording, type running, type run_options } from "./run";
import { read_settings, type settings } from "./settings";
import {
  clear_recordings,
  ensure_dir,
  latest_any,
  latest_recording,
  new_recording_path,
  prune,
  recordings_dir,
} from "./storage";
import {
  close_timeline,
  compare_previous,
  compare_with,
  is_open,
  jump_divergence,
  jump_to_line,
  set_compare_ignore,
  show_timeline,
  step_timeline,
  toggle_play,
} from "./timeline_panel";

// the extension's front door. commands, the run flow, and the glue between the
// recorder, the timeline panel and the editor decorations all meet here.
// anything that needs a vs code api belongs in this file or the modules below.

let active: running | undefined;
let starting = false; // true between "record" being pressed and the child starting
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let root = ""; // where this extension is installed, used to find the recorders
let extension_uri: vscode.Uri;
let store = ""; // global storage folder; recordings live under it
let source: vscode.Uri | undefined; // file the open timeline is showing

export function activate(context: vscode.ExtensionContext) {
  // push every disposable into subscriptions and let vs code clean up on its
  // own. i don't want to keep a parallel list of things to unhook.
  root = context.extensionUri.fsPath;
  extension_uri = context.extensionUri;
  store = recordings_dir(context.globalStorageUri.fsPath);
  output = vscode.window.createOutputChannel("wakeline");
  // the status bar entry is the only always-visible sign that a recording is
  // happening, so it sits on the left where it is hard to miss.
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.name = "wakeline";

  // tiny wrapper so the block below reads like a list of commands instead of
  // a wall of registerCommand(...) calls.
  const register = (id: string, fn: any) =>
    vscode.commands.registerCommand(id, fn as any);

  context.subscriptions.push(
    output,
    status,
    register("wakeline.record_at_name", async (name?: string, uri?: vscode.Uri) => {
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc2 = editor.document;
      const found = await find_function(doc2, editor.selection.active.line);
      if (found) {
        await record_now();
        return;
      }
      // try to find by name
      const text = doc2.getText();
      const idx = text.indexOf(name || "");
      if (idx >= 0) {
        const pos = doc2.positionAt(idx);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
        await record_now();
      }
    }),
    register("wakeline.record_this_function", record_this_function),
    register("wakeline.stop_recording", stop_recording),
    register("wakeline.open_last_recording", open_last_recording),
    register("wakeline.clear_recordings", clear_all_recordings),
    register("wakeline.step_back", () => step_timeline(-1)),
    register("wakeline.step_forward", () => step_timeline(1)),
    register("wakeline.jump_to_divergence", jump_divergence),
    register("wakeline.play_pause", toggle_play),
    register("wakeline.compare_previous", compare_previous),
    register("wakeline.compare_with_call", async () => {
      const id = await vscode.window.showInputBox({
        prompt: "call id to compare with",
        placeHolder: "c1",
      });
      if (id) await compare_with(id.trim());
    }),
    // moving the cursor in the source file jumps the timeline to the closest
    // step, but only when the panel is open and the file is the one being shown.
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!is_open() || !source) return;
      if (e.textEditor.document.uri.toString() !== source.toString()) return;
      jump_to_line(e.selections[0].active.line + 1);
    }),
  );

  void ensure_dir(store);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./codelens");
    const sel = vscode.languages.registerCodeLensProvider(["python", "javascript", "typescript", "go", "csharp", "cpp"], new mod.WakelineCodeLensProvider());
    context.subscriptions.push(sel);
  } catch {
    // ignore
  }
  try {
    context.subscriptions.push(vscode.commands.registerCommand("wakeline.record_at_cursor", async () => { await record_this_function(); }));
    context.subscriptions.push(vscode.commands.registerCommand("wakeline.record_at_line", async (line?: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || line === undefined || line === null) return;
      editor.selection = new vscode.Selection(line, 0, line, 0);
      await record_this_function();
    }));
  } catch {
    // ignore
  }
}



export function deactivate() {
  // closing the window mid-recording should not leave the user's program
  // running in the background. cancel first, then take down the ui.
  active?.cancel();
  active = undefined;
  kill_all();
  close_timeline();
  dispose_decorations();
}

async function record_this_function() {
  // untrusted workspaces can contain code that does nasty things on import, and
  // we are about to run it. refuse outright instead of asking every time.
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("wakeline does not run programs in an untrusted workspace");
    return;
  }
  if (active || starting) {
    void vscode.window.showInformationMessage("wakeline is already recording");
    return;
  }
  // "starting" covers the little gap before `active` is set. without it two
  // quick clicks would both get past the check above.
  starting = true;
  try {
    await record_now();
  } finally {
    starting = false;
  }
}

async function record_now() {
  // the actual work. record_this_function only handles the "can i start at
  // all" questions; everything about the current document is decided here.
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("open a python or javascript file first");
    return;
  }
  const doc = editor.document;
  const spec = language_by_id(doc.languageId);
  // an unknown language would fail much later with a confusing recorder error,
  // so name the ones that are actually wired up and stop here.
  if (!spec) {
    void vscode.window.showInformationMessage(`wakeline records ${language_names()} only`);
    return;
  }
  const language = spec.id;
  if (doc.uri.scheme !== "file") {
    void vscode.window.showInformationMessage("save the file to disk before recording");
    return;
  }

  // the symbol provider gets the first shot; the text scanner is the fallback.
  const found = await find_function(doc, editor.selection.active.line);
  if (!found) {
    void vscode.window.showWarningMessage("put the cursor inside a function and try again");
    return;
  }

  // settings are read fresh for every run so edits take effect immediately.
  const conf = read_settings();
  set_compare_ignore(conf.compare_ignore);
  const command = await interpreter(language, conf);
  if (!command) {
    void vscode.window.showErrorMessage(missing_tool(spec.command));
    return;
  }

  const file = doc.uri.fsPath;
  // run from the workspace root when there is one, because imports and relative
  // paths in the user's program expect that. otherwise sit next to the file.
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const cwd = folder ? folder.uri.fsPath : path.dirname(file);
  const opts: run_options = {
    language,
    file,
    name: found.name,
    line0: found.line0,
    line1: found.line1,
    out: new_recording_path(store, language, found.name),
    cwd,
    caps: conf.caps,
    timeout: conf.timeout,
    command,
    extra_args: conf.run_args,
    extension_root: root,
    masked: conf.masked,
    recorder: path.join(root, spec.recorder),
    prefix: spec.prefix,
    // the c++ and c# drivers read their tool paths from here. an empty setting
    // means "let the driver use whatever is on path".
    env: tool_env(conf),
  };

  await ensure_dir(store);
  // the output channel gets the recorder's own stderr, so "why did nothing
  // happen" has an answer somewhere.
  output.appendLine(`recording ${found.name} in ${path.basename(file)}`);
  status.text = `wakeline: recording ${found.name}`;
  status.tooltip = "click stop recording to end it early";
  status.show();
  let run: running;
  try {
    run = start_recording(opts, (text) => output.append(text));
  } catch (err) {
    status.hide();
    void vscode.window.showErrorMessage(`wakeline could not start the recorder: ${String(err)}`);
    return;
  }
  active = run;

  // the notification is cancellable and is the main way to stop a long run.
  // stopping via the command palette hits the same cancel path.
  let cancelled = false;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `wakeline: recording ${found.name}`,
        cancellable: true,
      },
      (_progress, token) => {
        const sub = token.onCancellationRequested(() => {
          cancelled = true;
          run.cancel();
        });
        return run.done.finally(() => sub.dispose());
      },
    );
  } finally {
    active = undefined;
    status.hide();
  }

  // build one short reason for anything other than a clean exit. it is shown
  // after the timeline opens so the user still gets whatever was recorded.
  const result = await run.done;
  const note = result.timed_out
    ? "the program ran too long and was stopped"
    : result.cancelled || cancelled
      ? "recording stopped early"
      : result.code === 0
        ? ""
        : `the program exited with code ${result.code ?? result.signal}`;
  if (note) output.appendLine(note);

  // indexing reads the file once and tells us what calls made it in. a bad
  // recording is reported but never takes the extension down.
  let index: index_result;
  try {
    index = await index_file(opts.out);
  } catch (err) {
    if (err instanceof format_error) {
      void vscode.window.showErrorMessage(`wakeline could not read the recording: ${err.message}`);
    } else {
      void vscode.window.showErrorMessage(`wakeline could not read the recording: ${String(err)}`);
    }
    return;
  }

  if (!index.calls.length) {
    // no calls usually means the function never ran. don't keep an empty file.
    const why = index.failure ? `recorder failed: ${index.failure}` : "the function was never called";
    void vscode.window.showInformationMessage(`wakeline: ${why}`);
    await fsp.rm(opts.out, { force: true });
    return;
  }

  // retention is applied after a successful run, not before, so a crash never
  // costs the user their previous recordings.
  await prune(store, conf.retention);
  const changed = await stale_note(index);
  await open_timeline(opts.out, index, changed);
  if (note) {
    void vscode.window.showWarningMessage(`wakeline: ${note}; kept ${index.calls.length} call(s)`);
  }
}

function stop_recording() {
  // just asks the child to die. record_now is still waiting on run.done and
  // will do the indexing once that resolves.
  if (!active) {
    void vscode.window.showInformationMessage("wakeline is not recording");
    return;
  }
  active.cancel();
}

async function open_last_recording() {
  // if the cursor is in a function, prefer that function's newest recording.
  // otherwise fall back to whatever is newest in the folder.
  const editor = vscode.window.activeTextEditor;
  let file: string | null = null;
  if (editor && language_by_id(editor.document.languageId)) {
    const found = await find_function(editor.document, editor.selection.active.line);
    if (found) file = await latest_recording(store, editor.document.languageId, found.name);
  }
  if (!file) file = await latest_any(store);
  if (!file) {
    void vscode.window.showInformationMessage("there are no recordings yet");
    return;
  }

  let index: index_result;
  try {
    index = await index_file(file);
  } catch (err) {
    void vscode.window.showErrorMessage(
      err instanceof format_error ? `wakeline: ${err.message}` : `wakeline: ${String(err)}`,
    );
    return;
  }
  if (!index.calls.length) {
    void vscode.window.showInformationMessage(
      index.failure ? `wakeline: recorder failed: ${index.failure}` : "that recording has no calls",
    );
    return;
  }
  const conf = read_settings();
  set_compare_ignore(conf.compare_ignore);
  await open_timeline(file, index, await stale_note(index));
}

async function open_timeline(file: string, index: index_result, stale: string) {
  // the panel calls back into these hooks for every step, so this is where the
  // editor side of the timeline is wired up.
  const uri = index.source ? vscode.Uri.file(index.source) : undefined;
  source = uri;
  const source_uri = uri;
  await show_timeline(extension_uri, file, index, index.calls[0]?.id, stale, {
    on_step: (call, events, step, diff) => {
      const editor = source_uri ? editor_for(source_uri) : undefined;
      if (editor) render_call(editor, call, events, step, diff);
    },
    on_open: (line) => {
      if (source_uri) void open_source(source_uri, line);
    },
    on_close: () => {
      source = undefined;
      const editor = source_uri ? editor_for(source_uri) : undefined;
      clear_all(editor);
      void vscode.commands.executeCommand("setContext", "wakeline.timeline_open", false);
    },
  });
  // drives the `when` clauses in package.json: step buttons are useless until
  // a timeline exists, so hide them until now.
  void vscode.commands.executeCommand("setContext", "wakeline.timeline_open", true);
}

async function open_source(uri: vscode.Uri, line: number) {
  // reuse the preview tab when possible so clicking around the timeline does
  // not fill the tab bar with copies of the same file.
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    void vscode.window.showErrorMessage(`wakeline: cannot open ${uri.fsPath}`);
  }
}

async function stale_note(index: index_result) {
  // a recording of a file that has changed since is still useful, but the line
  // numbers might be lies now. the panel shows this note when that happens.
  if (!index.source) return "";
  try {
    const stat = await fsp.stat(index.source);
    if (index.source_mtime && stat.mtimeMs > index.source_mtime + 5) {
      return "the source file changed after this recording was made";
    }
    return "";
  } catch {
    return "the source file is gone";
  }
}

// this is destructive and there is no undo, so it always asks first. it also
// refuses while a run is active, because wiping the folder under a live
// recorder would pull the file out from under it.
async function clear_all_recordings() {
  if (active || starting) {
    void vscode.window.showInformationMessage("stop the recording before clearing recordings");
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    "delete every wakeline recording?",
    { modal: true },
    "delete",
  );
  if (pick !== "delete") return;
  await clear_recordings(store);
  close_timeline();
  void vscode.window.showInformationMessage("wakeline recordings cleared");
}

function editor_for(uri: vscode.Uri) {
  // decorations can only be applied to an editor that is actually visible.
  // that's why this is a lookup and not a "get or open".
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
}

function missing_tool(kind: "python" | "node" | "go") {
  if (kind === "python") return "no python interpreter found";
  if (kind === "go") return "no go found in path";
  return "no node found in path";
}

function tool_env(conf: settings): Record<string, string> {
  const env: Record<string, string> = {};
  if (conf.go_path) env.WAKELINE_GO = conf.go_path;
  if (conf.cpp_compiler) env.WAKELINE_CXX = conf.cpp_compiler;
  if (conf.cpp_gdb) env.WAKELINE_GDB = conf.cpp_gdb;
  if (conf.csharp_compiler) env.WAKELINE_CSC = conf.csharp_compiler;
  if (conf.csharp_runtime) env.WAKELINE_MONO = conf.csharp_runtime;
  // also pass the user's chosen interpreters so the drivers can reuse them.
  if (conf.python_path) env.WAKELINE_PYTHON = conf.python_path;
  if (conf.node_path) env.WAKELINE_NODE = conf.node_path;
  return env;
}

async function interpreter(language: string, conf: settings) {
  // javascript is easy: node is node. python has more places to look, and the
  // python extension's selected interpreter should win over anything on path.
  // go is used for `go run` in prefix form, so look for the go binary.
  if (language === "javascript") return find_executable(conf.node_path, ["node"]);
  if (language === "typescript") return find_executable(conf.node_path, ["node"]);
  if (language === "go") return find_executable(conf.go_path, ["go"]);
  if (language === "csharp" || language === "cpp") {
    // the driver is python. prefer the python extension's interpreter, same
    // as plain python recordings.
    const from_python_extension = vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath", "");
    return (
      find_executable(from_python_extension, []) ??
      find_executable(conf.python_path, ["python3", "python"])
    );
  }
  const from_python_extension = vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath", "");
  return (
    find_executable(from_python_extension, []) ??
    find_executable(conf.python_path, ["python3", "python"])
  );
}
