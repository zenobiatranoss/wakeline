# wakeline

under build. nothing here records anything yet.

time travel for a single function inside vs code.

right-click a function, choose "record this function", then run your program normally. wakeline records every
call to that function without pausing the program: arguments, local values after each executed line, the return
value or the exception. after the run you scrub a timeline and see the values beside the source lines.

python and javascript (node) from the first release. adding another language should mean writing one recorder
and nothing else.

## status

stage 1 of 8 is done: design docs and extension scaffolding. the recorders are empty and the commands only say
they are not implemented yet. see `docs/progress.md` for what exists and `docs/roadmap.md` for the plan.

## design

- `docs/design.md` - architecture, data flow, ui, caps, trust
- `docs/format.md` - the recording format
- `docs/decisions.md` - why things are the way they are

## development

```
npm install
npm run build
```

press f5 in vs code to launch the extension host, or run `npm run check` for typecheck and lint.

## license

mit
