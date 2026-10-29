import * as vscode from "vscode";

// one place where the extension reads its configuration. everything is pulled
// fresh on each run, so changing a setting takes effect without a reload. the
// defaults here mirror package.json; keep the two in step.

export type caps = {
  max_calls: number;
  max_events: number;
  max_bytes: number;
};

export type settings = {
  caps: caps;
  timeout: number;
  retention: number;
  python_path: string;
  node_path: string;
  go_path: string;
  // the c++ and c# drivers take these from the environment instead of flags,
  // because the compiler path is a tool detail the recorder only needs once.
  cpp_compiler: string;
  cpp_gdb: string;
  csharp_compiler: string;
  csharp_runtime: string;
  experimental_languages: boolean;
  run_args: string;
  masked: string[];
  compare_ignore: string[];
};

// the two shapes are split on purpose: caps go straight to the recorder, the
// rest is extension policy. defaults are duplicated in package.json because
// that is what the settings ui shows before anything is overridden.
export function read_settings(): settings {
  const c = vscode.workspace.getConfiguration("wakeline");
  return {
    caps: {
      max_calls: c.get<number>("max_calls", 100),
      max_events: c.get<number>("max_events", 10000),
      max_bytes: c.get<number>("max_bytes", 10485760),
    },
    timeout: c.get<number>("timeout", 300000),
    retention: c.get<number>("retention", 10),
    python_path: c.get<string>("python_path", ""),
    node_path: c.get<string>("node_path", ""),
    go_path: c.get<string>("go_path", ""),
    cpp_compiler: c.get<string>("cpp_compiler", ""),
    cpp_gdb: c.get<string>("cpp_gdb", ""),
    csharp_compiler: c.get<string>("csharp_compiler", ""),
    csharp_runtime: c.get<string>("csharp_runtime", ""),
    experimental_languages: c.get<boolean>("experimental_languages", false),
    run_args: c.get<string>("run_args", ""),
    masked: c.get<string[]>("variable_masking", []),
    compare_ignore: c.get<string[]>("compare_ignore", []),
  };
}
