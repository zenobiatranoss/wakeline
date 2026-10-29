# wakeline

time travel for a single function inside vs code.

this project is still under active development.

## idea

pick one function and record it
wakeline runs your code and traces only that function
it shows every line that ran with the values at that moment
then you can step back and forth through a timeline to see how it really works
supports python javascript typescript go c# c++

## full breakdown

### package.json
this is the vscode extension manifest
it lists all commands like wakeline.record_this_function and timeline ones
sets activation events so the extension wakes up on startup and on those languages
declares settings for python/node/go/csharp/cpp paths and caps
points main to extension.js

### tsconfig.json
compiles src/*.ts to out/ with commonjs
keeps source maps
esmoduleinterop on

### src/extension.ts
main entry point
activates and sets up status bar output channel and storage
registers all commands
adds codelens provider so you can click record next to functions
handles starting recording finding the function and opening the timeline
when recording ends it finds the newest jsonl and shows timeline

### src/languages.ts
central registry of all supported languages
each has id extensions recorder path command args and any prefix needed
used by run.ts extension.ts and codelens

### src/run.ts
builds the command to run the recorder for a language
resolves interpreter/compiler paths from settings or env
passes file name lines out caps masked args and env
spawns the process and tracks it so it can be killed on stop
handles timeouts and file size limits

### src/function_find.ts
finds which function contains the cursor
tries vscode document symbol provider first if available
falls back to text_find.ts regex scanner if symbols not there

### src/text_find.ts
pure regex based scanner for all languages
knows how to find function/method boundaries for python go c# c++ js ts
uses brace matching and skips comments/strings
handles go receivers method shorthand in js/ts and c# modifiers

### src/codelens.ts
vscode codelens provider
scans for functions in supported languages with regex
adds "wakeline: record" codelens above each found function
clicking it uses wakeline.record_at_line to set cursor and record

### src/recording_reader.ts
reads jsonl files incrementally
builds index of all calls with line ranges and outcomes
reads events for a single call range
strips bom handles partial last line
enforces max events in memory

### src/format.ts
defines all jsonl line types ver meta call_start line exception call_end cap_hit failure etc
validates shape and types
strips bom from parsed lines
encodes/decodes values

### src/storage.ts
figures out recordings dir under global storage
makes safe filenames from language and function name with timestamp
prunes old recordings per function group by retention
finds latest recording

### src/settings.ts
reads all wakeline settings from vscode config with defaults

### src/compare.ts
compares two calls step by step
finds first divergence by line or by differing values
skips ignored variables

### src/timeline_panel.ts
creates and manages the webview panel
sends call index and events to webview
handles stepping compare and jumping to editor lines
adds a fake step for recorders that only produce call_start/call_end so ui still shows result

### src/decorations.ts
manages inline decorations in the source file for timeline

### out/
compiled js versions of all src/ files

### recorders/python/wakeline_recorder.py
entry for python
finds target function and traces with sys.settrace
writes ver meta call_start line events call_end to jsonl
respects caps and masks

### recorders/python/wk_trace.py
trace function that captures locals per line and tracks calls

### recorders/python/wk_writer.py
thread safe writer for jsonl

### recorders/python/wk_encode.py
safe value encoding for primitives containers and objects

### recorders/javascript/wakeline_recorder.js
node entry for js
instruments code with instrument.js or uses runtime hook

### recorders/javascript/instrument.js
injects tracing code into js functions

### recorders/javascript/runtime.js
runtime helpers called by instrumented code

### recorders/javascript/writer.js
jsonl writer for js

### recorders/javascript/encode.js
value encoding for js

### recorders/javascript/loader.mjs preload.cjs runtime_hook.mjs core.js core.cjs
module loading and hooking support

### recorders/typescript/wakeline_recorder.js
transpiles ts to js via typescript api then delegates to javascript recorder

### recorders/go/wakeline_recorder.go
go recorder
copies package to temp dir inits go.mod if needed adds dummy main for lib packages
instruments target function
builds and runs it writing jsonl via runtime

### recorders/go/go
compiled binary of the go recorder

### recorders/go/instrument.go encode.go runtime.go writer.go state_extra.go go.mod
go recorder implementation files

### recorders/csharp/wakeline_recorder.py
python driver for c#
instruments the target method adds Wakeline tracing calls
copies all .cs files from project dir
compiles with mcs together with wk_csharp_runner.cs
runs with mono passing env vars for output and caps
forces a:{} to be object for format compatibility

### recorders/csharp/wk_csharp_runner.cs
c# runtime linked in during compile
writes jsonl to wakeline_out
tracks call stack timing caps
encodes values and handles exceptions

### recorders/cpp/wakeline_recorder.py
python driver for c++
adds credit line "// c++ work by sora - https://github.com/q2hp0"
includes wk_cpp_runtime.hpp
copies all .cpp .cc .cxx .hpp .h files from project dir
instruments target function with wk_enter/wk_end and guard
compiles with g++ together with wk_cpp_runtime.cpp
runs binary passing env vars

### recorders/cpp/wk_cpp_runtime.hpp
c++ runtime header for tracing
defines WkState and extern functions wk_enter wk_exc wk_end wk_close
credit line "// c++ work by sora - https://github.com/q2hp0"

### recorders/cpp/wk_cpp_runtime.cpp
c++ runtime implementation
writes jsonl in thread safe way
tracks calls and ensures call_end is written
credit line "// c++ work by sora - https://github.com/q2hp0"

### webview/timeline.ts
webview ui for the timeline
shows call list and steps
handles stepping compare and selection
sends messages back to extension

### webview/timeline.css
styles for timeline ui

### media/
icons used by the extension

### test/
tests for format run recorder text_find and fixtures

note: all c++ runtime files must keep the sora credit line intact
