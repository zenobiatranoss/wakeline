"use strict";
// one table for every language the extension knows about. the commands, the
// context menu and the recorder launcher all read from here, so adding a
// language later means one entry and a recorder folder, not a scavenger hunt.
//
// "command" is the program that starts the recorder, not the language runtime.
// go needs `go run`, everything else is a script passed to an interpreter.
// c# and c++ use python only as the driver; the driver finds its own compiler.
Object.defineProperty(exports, "__esModule", { value: true });
exports.languages = void 0;
exports.language_by_id = language_by_id;
exports.language_by_file = language_by_file;
exports.context_clause = context_clause;
exports.language_names = language_names;
exports.languages = [
    {
        id: "python",
        label: "python",
        extensions: [".py"],
        recorder: "recorders/python/wakeline_recorder.py",
        prefix: [],
        command: "python",
    },
    {
        id: "javascript",
        label: "javascript",
        extensions: [".js", ".mjs", ".cjs"],
        recorder: "recorders/javascript/wakeline_recorder.js",
        prefix: [],
        command: "node",
    },
    {
        id: "typescript",
        label: "typescript",
        extensions: [".ts", ".mts", ".cts"],
        recorder: "recorders/typescript/wakeline_recorder.js",
        prefix: [],
        command: "node",
    },
    {
        id: "go",
        label: "go",
        extensions: [".go"],
        recorder: "recorders/go/wakeline_recorder.go",
        // go run wants the source file after the subcommand and before the flags
        // that belong to the recorder.
        prefix: ["run"],
        command: "go",
    },
    {
        id: "csharp",
        label: "c#",
        extensions: [".cs"],
        recorder: "recorders/csharp/wakeline_recorder.py",
        prefix: [],
        command: "python",
    },
    {
        id: "cpp",
        label: "c++",
        extensions: [".cpp", ".cc", ".cxx"],
        recorder: "recorders/cpp/wakeline_recorder.py",
        prefix: [],
        command: "python",
    },
];
function language_by_id(id) {
    return exports.languages.find((l) => l.id === id);
}
function language_by_file(file) {
    const lower = file.toLowerCase();
    // longest extension first so .cc does not win over something longer that
    // happens to end with it.
    const all = exports.languages.flatMap((l) => l.extensions.map((ext) => ({ l, ext })));
    all.sort((a, b) => b.ext.length - a.ext.length);
    return all.find(({ ext }) => lower.endsWith(ext))?.l;
}
// the `when` clause for the editor menu. keeping it generated means a new
// language cannot be forgotten in package.json.
function context_clause() {
    return exports.languages.map((l) => `editorLangId == ${l.id}`).join(" || ");
}
// short list for the "unsupported file" message.
function language_names() {
    const names = exports.languages.map((l) => l.label);
    const last = names.pop();
    return `${names.join(", ")} and ${last}`;
}
