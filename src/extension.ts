import * as vscode from "vscode";

function not_ready(label: string) {
  return () => vscode.window.showInformationMessage(`wakeline: ${label} is not implemented yet`);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("wakeline.recordThisFunction", not_ready("record this function")),
    vscode.commands.registerCommand("wakeline.stopRecording", not_ready("stop recording")),
    vscode.commands.registerCommand("wakeline.openLastRecording", not_ready("open last recording")),
    vscode.commands.registerCommand("wakeline.clearRecordings", not_ready("clear recordings")),
  );
}

export function deactivate() {}
