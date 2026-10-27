// one table for every language the extension knows about. the commands, the
// context menu and the recorder launcher all read from here, so adding a
// language later means one entry and a recorder folder, not a scavenger hunt.
//
// "command" is the program that starts the recorder, not the language runtime.
// go needs `go run`, everything else is a script passed to an interpreter.
// c# and c++ use python only as the driver; the driver finds its own compiler.

export type language_spec = {
  id: string;
  label: string;
  extensions: string[];
  recorder: string;
  prefix: string[];
  command: "python" | "node" | "go";
};

export const languages: language_spec[] = [
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

export function language_by_id(id: string): language_spec | undefined {
  return languages.find((l) => l.id === id);
}

export function language_by_file(file: string): language_spec | undefined {
  const lower = file.toLowerCase();
  // longest extension first so .cc does not win over something longer that
  // happens to end with it.
  const all = languages.flatMap((l) => l.extensions.map((ext) => ({ l, ext })));
  all.sort((a, b) => b.ext.length - a.ext.length);
  return all.find(({ ext }) => lower.endsWith(ext))?.l;
}

// the `when` clause for the editor menu. keeping it generated means a new
// language cannot be forgotten in package.json.
export function context_clause(): string {
  return languages.map((l) => `editorLangId == ${l.id}`).join(" || ");
}

// short list for the "unsupported file" message.
export function language_names(): string {
  const names = languages.map((l) => l.label);
  const last = names.pop();
  return `${names.join(", ")} and ${last}`;
}
