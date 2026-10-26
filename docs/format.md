# recording format

one json object per line, utf-8, newline separated. the file is append-only while recording and read
incrementally afterwards.

the format is versioned. version 1 is described here. an extension refuses a recording whose major version it
does not understand.

## lines

every line has a `k` field naming its kind. the first line is always the version line.

### version

```json
{"k":"ver","v":1}
```

must be the first line. nothing else may precede it.

### call start

```json
{"k":"call_start","i":"c1","f":"sample.add","l0":1,"l1":3,"dp":0,"a":[2,3],"t":1700000000123}
```

- `i` call id, unique within the file, short and stable
- `f` qualified function name
- `l0`, `l1` first and last source line of the function, 1-based
- `dp` call depth, 0 for a call made from outside the function, 1 for a direct recursive call
- `a` arguments as encoded values, one per positional parameter
- `t` start time, unix epoch milliseconds

call ids are opaque strings. recorders may use `c1`, `c2`, or anything else, as long as every event refers to
the id of the call it belongs to.

### line event

```json
{"k":"line","i":"c1","s":0,"l":2,"v":{"a":2,"b":3}}
```

- `s` step index within the call, starts at 0 and increases by one
- `l` source line about to execute, 1-based
- `v` local variables visible at that point, as a map

a line event is written before the line executes, which is what `sys.settrace` and the javascript hook can see.
so `v` holds the values the line starts with, not the values it produces. the next line event shows those.

only locals are recorded, not globals or closure variables. arguments are locals, so they appear too.

### exception

```json
{"k":"exception","i":"c1","x":{"t":"ZeroDivisionError","m":"division by zero","s":["sample.py:2 in divide"]}}
```

written when an exception is raised inside a traced call. it may be caught later in the same call; that is why
the marker is not the same as the call outcome. `x` has:

- `t` exception type or class name
- `m` message
- `s` array of short stack frames, innermost first

### call end

returned normally:

```json
{"k":"call_end","i":"c1","s":1,"o":"return","r":5,"ms":1,"c":"none"}
```

threw out of the call:

```json
{"k":"call_end","i":"c1","s":0,"o":"throw","x":{"t":"ZeroDivisionError","m":"division by zero","s":["sample.py:2 in divide"]},"ms":0,"c":"none"}
```

- `s` last step index recorded for the call
- `o` `"return"` or `"throw"`
- `r` return value, only when `o` is `"return"`
- `x` exception, only when `o` is `"throw"`
- `ms` wall time from call start to call end, milliseconds
- `c` cap that stopped this call, or `"none"`

a recursive call is its own call record. it starts and ends between the parent's line events, so the file
interleaves records. `i` and `dp` make the nesting unambiguous.

### cap hit

```json
{"k":"cap_hit","i":"c1","r":"max_events","s":10000,"b":524288}
```

- `r` one of `max_calls`, `max_events`, `max_bytes`
- `s` steps written for this call when the cap hit
- `b` bytes written to the file when the cap hit

written immediately before the recorder stops tracing. the user's program is never stopped by a cap.

### truncated

```json
{"k":"truncated","i":"c1","s":77,"why":"bytes"}
```

an event existed but was dropped because it exceeded a per-event size bound. `s` is the step it would have had.
individual values are truncated in place with the value encoding below, not with this line.

## values

json primitives are used directly when they fit: `null`, `true`, `false`, and numbers that are finite and within
the safe integer range. everything else is an object with a `$` field.

| shape | meaning |
| --- | --- |
| `{"$":"int","v":"123456789012345678901"}` | integer outside the safe range or a bigint |
| `{"$":"num","v":"nan"}` | nan, inf, -inf |
| `{"$":"undefined"}` | javascript undefined |
| `{"$":"str","v":"prefix","n":9000,"cut":true}` | string over the string limit |
| `{"$":"bytes","v":"base64 prefix","n":1048576,"cut":true}` | bytes, buffers, typed arrays |
| `{"$":"list","id":1,"v":[...],"n":100000,"cut":true}` | list, tuple, array |
| `{"$":"dict","id":2,"v":[[k,v],...],"n":50,"cut":false}` | dict, map |
| `{"$":"set","id":3,"v":[...],"n":12,"cut":false}` | set |
| `{"$":"obj","id":4,"cls":"point","v":{"x":1,"y":2},"n":2,"cut":false}` | object and its enumerable fields |
| `{"$":"ref","id":1}` | second sighting of an already encoded object |
| `{"$":"opaque","cls":"file","why":"repr failed"}` | value that cannot be read safely |
| `{"$":"trunc","why":"depth"}` | value cut before it could be encoded |
| `{"$":"fn","name":"f"}` | function, symbol, or other callable |
| `{"$":"error","cls":"TypeError","m":"boom"}` | error object |

`id` is assigned on first sighting of a non-primitive within a call, starting at 1. a second sighting becomes a
`ref`, which is how cycles are represented and how shared objects stay shared in the ui.

`why` on `trunc` is one of `depth`, `items`, `string`, `bytes`, `error`.

default bounds, all configurable in the recorder:

- depth 4
- 100 items per collection
- 4096 characters per string
- 65536 bytes per encoded value

a truncated collection keeps the first items and sets `n` to the real length and `cut` to true. the ui shows a
truncation marker next to it.

## complete examples

### simple function

source:

```python
def add(a, b):          # line 1
    total = a + b       # line 2
    return total        # line 3
```

call `add(2, 3)`:

```json
{"k":"ver","v":1}
{"k":"call_start","i":"c1","f":"sample.add","l0":1,"l1":3,"dp":0,"a":[2,3],"t":1700000000123}
{"k":"line","i":"c1","s":0,"l":2,"v":{"a":2,"b":3}}
{"k":"line","i":"c1","s":1,"l":3,"v":{"a":2,"b":3,"total":5}}
{"k":"call_end","i":"c1","s":1,"o":"return","r":5,"ms":1,"c":"none"}
```

### recursive function

source:

```python
def fact(n):            # line 1
    if n <= 1:          # line 2
        return 1        # line 3
    return n * fact(n - 1)  # line 4
```

call `fact(3)`, written in execution order:

```json
{"k":"ver","v":1}
{"k":"call_start","i":"c1","f":"sample.fact","l0":1,"l1":4,"dp":0,"a":[3],"t":1700000000200}
{"k":"line","i":"c1","s":0,"l":2,"v":{"n":3}}
{"k":"line","i":"c1","s":1,"l":4,"v":{"n":3}}
{"k":"call_start","i":"c2","f":"sample.fact","l0":1,"l1":4,"dp":1,"a":[2],"t":1700000000201}
{"k":"line","i":"c2","s":0,"l":2,"v":{"n":2}}
{"k":"line","i":"c2","s":1,"l":4,"v":{"n":2}}
{"k":"call_start","i":"c3","f":"sample.fact","l0":1,"l1":4,"dp":2,"a":[1],"t":1700000000202}
{"k":"line","i":"c3","s":0,"l":2,"v":{"n":1}}
{"k":"line","i":"c3","s":1,"l":3,"v":{"n":1}}
{"k":"call_end","i":"c3","s":1,"o":"return","r":1,"ms":0,"c":"none"}
{"k":"call_end","i":"c2","s":1,"o":"return","r":2,"ms":1,"c":"none"}
{"k":"call_end","i":"c1","s":1,"o":"return","r":6,"ms":2,"c":"none"}
```

each call has its own step numbering. the parent's line 4 event is followed by the child's record, and the
parent's `call_end` comes after the child's.

### function that throws

source:

```python
def divide(a, b):       # line 1
    return a / b        # line 2
```

call `divide(1, 0)`:

```json
{"k":"ver","v":1}
{"k":"call_start","i":"c1","f":"sample.divide","l0":1,"l1":2,"dp":0,"a":[1,0],"t":1700000000300}
{"k":"line","i":"c1","s":0,"l":2,"v":{"a":1,"b":0}}
{"k":"exception","i":"c1","x":{"t":"ZeroDivisionError","m":"division by zero","s":["sample.py:2 in divide"]}}
{"k":"call_end","i":"c1","s":0,"o":"throw","x":{"t":"ZeroDivisionError","m":"division by zero","s":["sample.py:2 in divide"]},"ms":0,"c":"none"}
```

### truncated values and a cap

```json
{"k":"ver","v":1}
{"k":"call_start","i":"c1","f":"sample.report","l0":10,"l1":20,"dp":0,"a":[{"$":"list","id":1,"v":[1,2,3],"n":3,"cut":false}],"t":1700000000400}
{"k":"line","i":"c1","s":0,"l":11,"v":{"rows":{"$":"list","id":2,"v":[1,2,3,4,5],"n":100000,"cut":true},"again":{"$":"ref","id":2},"blob":{"$":"bytes","v":"aaec","n":1048576,"cut":true},"deep":{"$":"trunc","why":"depth"}}}
{"k":"line","i":"c1","s":1,"l":12,"v":{"rows":{"$":"ref","id":2},"total":42}}
{"k":"cap_hit","i":"c1","r":"max_events","s":1,"b":524288}
{"k":"call_end","i":"c1","s":1,"o":"return","r":42,"ms":12,"c":"max_events"}
```

## forward compatibility

- version 1 is the only version now. a reader must refuse a file whose `ver` is higher than the version it
  supports, with a message naming both versions.
- within the same major version, new line kinds and new fields may be added. readers ignore unknown `k` lines
  and unknown fields inside known lines.
- unknown `$` value shapes are rendered as opaque with the raw shape preserved, never as a crash.
- a reader must tolerate a file whose last line is incomplete, because a recorder can be killed mid-write. that
  line is dropped.
- a `call_start` without a matching `call_end` is shown as interrupted, not silently discarded.
- a recorder must never write a line longer than the per-event bound. if an event would exceed it, it writes a
  `truncated` line instead.
