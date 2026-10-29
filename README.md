# wakeline

time travel for a single function inside vs code.

right-click a function, run your program, then scrub back through every call to that function. each line shows
the value of your variables at that moment as faint grey text next to the code. no breakpoints, the program is
never paused.

## what you get

- every call to the function: arguments, the locals after each executed line, the return value or the exception
- lines that did not run in the selected call are dimmed
- a timeline panel with a scrubber, play and pause, step back and forward, and a searchable list of calls
- compare two calls: wakeline finds the first line where they went different ways and says what changed
- recordings stay on your machine, in vs code's storage folder for the extension

## languages

| language | status |
| --- | --- |
| python | supported, python 3.8 or newer |
| javascript (`.js`, `.mjs`, `.cjs`) | supported, node 18 or newer |
| typescript, c#, c++, go | experimental, off by default (see below) |

## install

install the extension from the marketplace, or from a `.vsix`:

```
code --install-extension wakeline-0.1.0.vsix
```

wakeline needs `python3` or `node` on your path for the language you record. nothing else to install.

## use

1. open a python or javascript file inside a folder you trust
2. put the cursor inside a function and run `record this function` from the right-click menu or the command
   palette (there is also a `wakeline: record` link above each function)
3. your program runs from the start of the file. when it ends, the timeline opens
4. drag the scrubber, or use the step commands, and read the values next to your code

keys while the timeline is open: `alt+left` and `alt+right` to step, `alt+p` to play or pause, `alt+c` to compare
with the previous call, `alt+d` to jump to where two compared calls diverge. all of them are normal commands, so
you can rebind them.

to pass arguments to your program, set `wakeline.run_args`.

## settings

| setting | default | what it does |
| --- | --- | --- |
| `wakeline.max_calls` | 100 | calls recorded per run |
| `wakeline.max_events` | 10000 | line events recorded per call |
| `wakeline.max_bytes` | 10485760 | size cap for one recording |
| `wakeline.timeout` | 300000 | stop the program after this many milliseconds |
| `wakeline.retention` | 10 | recordings kept per function |
| `wakeline.python_path` | empty | python interpreter, empty means look on path |
| `wakeline.node_path` | empty | node executable, empty means look on path |
| `wakeline.go_path` | empty | go executable, empty means look on path |
| `wakeline.run_args` | empty | arguments passed to your program |
| `wakeline.variable_masking` | empty | names or globs (like `*token*`) whose values are never written to a recording |
| `wakeline.compare_ignore` | empty | names or globs ignored when comparing calls |
| `wakeline.experimental_languages` | off | turns on typescript, c#, c++ and go |

when a cap is hit, recording of that function stops and the timeline says so. your program keeps running.

## privacy

wakeline makes no network calls. recordings are plain json lines files under the extension's storage folder and
are never uploaded. values from your program are written to those files, so use `wakeline.variable_masking` for
names that hold secrets. masking matches variable names, so a secret stored under another name, or inside a larger
value, is not hidden. wakeline refuses to run in an untrusted workspace, because recording means running your
program.

## limits

- one function per run
- python recording slows a hot function down. the call and event caps exist for this reason
- a javascript generator records its body steps and a final result, not each yielded value
- compare lines steps up by position. loops with different iteration counts diverge at the first extra step
- the timeline loads one whole recording at a time. very large recordings take a while to open
- experimental languages: c# and c++ record call boundaries only (no line values), typescript needs the
  `typescript` package to be available and may point at the wrong file. go is experimental.

## build from source

```
npm ci
npm run build
npm test
npx @vscode/vsce package
```

licensed under mit.
