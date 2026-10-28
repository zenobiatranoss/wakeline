# performance

measured on linux 6.12, x86_64, python 3.13.5, node 22.23.3. one machine, one run each, so treat these as
orders of magnitude, not a benchmark suite.

the test function is a hot increment called in a loop. the recorder instruments or traces only that function.
both runs use the default caps (`max_calls` 100, `max_events` 10000, `max_bytes` 10 MiB), so recording stops
after 100 calls and the rest of the loop runs with the recorder idle.

## 1,000,000 calls

| run | baseline | recorded | difference |
| --- | --- | --- | --- |
| python | 0.055-0.061 s | 0.090-0.093 s | +0.032 s |
| node | 0.027-0.037 s | 0.246-0.247 s | +0.210 s |

## 10,000,000 calls

| run | baseline | recorded | difference |
| --- | --- | --- | --- |
| python | 0.457-0.481 s | 0.481-0.503 s | about +0.025 s |
| node | 0.031-0.037 s | 0.438-0.482 s | about +0.42 s |

the node baseline is short enough that the jit can specialize the loop. the recorder keeps helper calls and
bounds checks in the instrumented function, so the relative cost looks worse than the absolute cost. at 10
million calls the extra work is roughly 40 ns per call; the rest of the difference is node startup and source
instrumentation.

python's `sys.settrace` predicate returns quickly for every non-target frame. after the call cap is reached the
trace function is removed, so the remaining loop pays only the interpreter's normal cost. the 1m python number
is dominated by interpreter startup, which is why the relative overhead drops at 10m.

## where the caps kick in

on the same 100-call recording both recorders wrote 303 lines and about 21 KiB, then a `max_calls` marker:

```
{"k":"call_end","i":"c100","s":0,"o":"return","r":100,"ms":0,"c":"none"}
{"k":"cap_hit","r":"max_calls","s":0,"b":21042}
```

- `max_calls` stops new calls and writes one global marker. in-flight calls keep their id and finish.
- `max_events` is per call. the call keeps running, but its later line events are dropped and its `call_end`
  carries the cap name.
- `max_bytes` is checked before each write. the recorder stops itself when the next line would pass the limit;
  the file can overshoot by the line already being written. the extension kills the process only if the file
  passes the limit by another megabyte, which protects against a recorder that stops responding.
- value serialization has its own budgets: depth 4, 100 items, 4096 characters, 64 KiB per encoded value. those
  bounds keep a single bad object from stalling the program, independent of the global caps.

## what was not measured

- deep recursion, large debugger values, multi-threaded python, and event-heavy functions
- extension host cpu while indexing very large recordings
- webview rendering time on a slow machine
- windows and macos
