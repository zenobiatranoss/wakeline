# manual test checklist

things the unit tests cannot cover. run these in a real vs code window with the extension development host.
check the box only after doing it on the platform named at the top.

platform: ______  vs code: ______  python: ______  node: ______

## start and trust

- [ ] open a trusted folder with a python file. put the cursor in a function and use the editor context menu.
      the run starts and the status bar says `wakeline: recording <name>`.
- [ ] open an untrusted folder and try the same. a warning appears and no process starts.
- [ ] try recording with the cursor outside any function. the warning says to put the cursor inside one.
- [ ] try recording while one run is active. the second command is refused instead of starting twice.
- [ ] press the cancel button on the progress notification. the program stops and the partial recording opens if
      it has a call.
- [ ] run `wakeline: stop recording` from the command palette during a run. same result.
- [ ] close vs code during a run. no python or node child is left behind (`ps` or task manager).

## python

- [ ] record a function called once. arguments, locals, return value and every executed line match the code.
- [ ] record a recursive function. the call picker lists each depth with its own arguments and values.
- [ ] record a function that throws. the call is marked as thrown and the exception text appears.
- [ ] record a generator and a coroutine. each gets one call id and the steps are not duplicated per resume.
- [ ] record a function called from several threads. calls are separate and no recorder crash appears.
- [ ] set `wakeline.python_path` to a missing file. the error names python and no process starts.

## javascript

- [ ] record a commonjs function. values look right in the timeline.
- [ ] record an esm function from a `.mjs` file. same.
- [ ] record a class method. the call name and ghost values are attached to the right method.
- [ ] record an async function with an await. values before and after the await are in the same call.
- [ ] record a generator. the call finishes and does not leave a stuck `running` state.
- [ ] record a function that calls `process.exit()`. the extension keeps whatever was written.
- [ ] try a `.ts` file. the recorder refuses with the transpile message instead of running it.

## timeline and editor

- [ ] the timeline opens beside the source file and the first call is selected.
- [ ] the source file gets ghost values on the executed lines, dimmed lines elsewhere, and a current-line highlight.
- [ ] scrub with the slider, the arrow keys, prev/next and play/pause. the values and editor highlight follow.
- [ ] click a line number in the timeline. the source editor reveals that line.
- [ ] click a loop group. it expands and collapses without losing the current step.
- [ ] select another call from the picker. decorations update and the old call's values disappear.
- [ ] use "compare with previous call". both columns align and the first difference is marked.
- [ ] compare two identical calls. the summary says there is no divergence.
- [ ] set `wakeline.compare_ignore` and compare again. the ignored name no longer counts as a difference.
- [ ] change the source file after recording, then reopen the recording. a stale warning appears; values still land
      on the recorded line numbers.
- [ ] delete the source file after recording, then reopen. the warning says the source is gone.
- [ ] close the timeline panel. decorations disappear and the timeline commands are disabled in the palette.

## caps and large data

- [ ] record a function called more than `max_calls` times. the picker stops at the cap and the status names it.
- [ ] set a small `max_events`. a long call stops at the cap and says so.
- [ ] set a small `max_bytes`. the recording stops growing, opens without hanging, and reports the cap.
- [ ] record a loop with thousands of iterations. the timeline groups repeated lines and scrolling stays smooth.
- [ ] record a function with a huge list and a self-reference. the values are cut or shown as references, and the
      program does not hang.
- [ ] record a function whose object getter throws. the value is marked opaque and the run continues.

## storage

- [ ] record the same function more than `wakeline.retention` times. older files are removed from global storage.
- [ ] run `wakeline: open last recording`. the newest recording opens even without the original editor focused.
- [ ] run `wakeline: clear recordings`, confirm, then try to open one. the extension says there are none.
- [ ] check that no recording file was created inside the workspace.

## paths and platforms

- [ ] record a project whose folder and file names contain spaces and non-ascii characters.
- [ ] record with a relative `run_args` value that the program reads from argv.
- [ ] repeat the start, cancel and cleanup checks on windows and macos.
