import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# tests for the python recorder. they run the cli exactly the way the extension
# does and then read the jsonl straight back, so a format change on either side
# shows up here.


root = pathlib.Path(__file__).resolve().parents[2]
recorder = root / "recorders" / "python" / "wakeline_recorder.py"
fixtures = root / "test" / "fixtures" / "python"


def run_recorder(fixture, name, lines, extra=None, program_args=None, cwd=None, module=None):
    # run the recorder against a fixture and return the process, the output path
    # and the parsed lines. missing output is allowed: some tests expect it.
    out_dir = tempfile.mkdtemp(prefix="wakeline_")
    out_path = os.path.join(out_dir, "rec.jsonl")
    argv = [sys.executable, str(recorder)]
    if module:
        argv += ["--module", module, "--target", str(fixtures / fixture)]
    else:
        argv += ["--file", str(fixtures / fixture)]
    argv += ["--name", name, "--lines", lines, "--out", out_path]
    if extra:
        argv += extra
    if program_args:
        argv += ["--"] + list(program_args)

    proc = subprocess.run(
        argv,
        cwd=str(cwd or root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
    )
    lines_out = []
    if os.path.exists(out_path):
        with open(out_path, "r", encoding="utf-8") as handle:
            for raw in handle:
                raw = raw.strip()
                if raw:
                    lines_out.append(json.loads(raw))
    return proc, out_path, lines_out


def kind(lines, name):
    # all lines of one kind. reads better than a list comprehension at every use.
    return [line for line in lines if line["k"] == name]


def call_events(lines, cid, name=None):
    # events belonging to one call id, optionally filtered to one kind.
    out = []
    for line in lines:
        if line.get("i") != cid:
            continue
        if name is None or line["k"] == name:
            out.append(line)
    return out


class recorder_tests(unittest.TestCase):
    # each test is one fixture and one property of the output. the fixtures live
    # in test/fixtures/python and stay deliberately tiny.

    def test_simple(self):
        # the happy path: one call, two lines, a return value and the program's
        # own stdout untouched.
        proc, path, lines = run_recorder("simple.py", "add", "1:3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "5\n")
        self.assertEqual(lines[0], {"k": "ver", "v": 1})

        starts = kind(lines, "call_start")
        ends = kind(lines, "call_end")
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)

        start = starts[0]
        self.assertEqual(start["i"], "c1")
        self.assertEqual(start["a"], {"a": 2, "b": 3})
        self.assertEqual(start["dp"], 0)
        self.assertEqual((start["l0"], start["l1"]), (1, 3))
        self.assertIsInstance(start["t"], int)

        events = call_events(lines, "c1", "line")
        self.assertEqual([ev["s"] for ev in events], [0, 1])
        self.assertEqual([ev["l"] for ev in events], [2, 3])
        self.assertEqual(events[0]["v"], {"a": 2, "b": 3})
        self.assertEqual(events[1]["v"], {"a": 2, "b": 3, "total": 5})

        end = ends[0]
        self.assertEqual(end["o"], "return")
        self.assertEqual(end["r"], 5)
        self.assertEqual(end["c"], "none")
        self.assertEqual(end["s"], 1)
        self.assertGreaterEqual(end["ms"], 0)
        self.assertEqual(os.path.getsize(path) > 0, True)

    def test_loop_and_branching(self):
        proc, _path, lines = run_recorder("loop.py", "classify", "1:8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "-3\n")
        events = call_events(lines, "c1", "line")
        self.assertEqual(len(events), 21)
        seen = {ev["l"] for ev in events}
        self.assertEqual(seen, {2, 3, 4, 5, 7, 8})
        self.assertEqual(kind(lines, "call_end")[0]["r"], -3)

    def test_recursion(self):
        proc, _path, lines = run_recorder("recursion.py", "fact", "1:4")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "6\n")

        starts = kind(lines, "call_start")
        ends = kind(lines, "call_end")
        self.assertEqual([s["i"] for s in starts], ["c1", "c2", "c3"])
        self.assertEqual([s["dp"] for s in starts], [0, 1, 2])
        self.assertEqual([s["a"] for s in starts], [{"n": 3}, {"n": 2}, {"n": 1}])
        self.assertEqual([e["i"] for e in ends], ["c3", "c2", "c1"])
        self.assertEqual([e["r"] for e in ends], [1, 2, 6])

        nested = [i for i in lines if i.get("i") in ("c1", "c2", "c3")]
        first_end = next(i for i, line in enumerate(nested) if line["k"] == "call_end")
        self.assertEqual(nested[first_end]["i"], "c3")

    def test_generator(self):
        # yields show up as line events and the call only ends once, when the
        # generator is exhausted.
        proc, _path, lines = run_recorder("generator.py", "count", "1:3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "[0, 1, 2, 3]\n")

        starts = kind(lines, "call_start")
        ends = kind(lines, "call_end")
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)

        events = call_events(lines, "c1", "line")
        self.assertEqual(len(events), 9)
        self.assertEqual([ev["s"] for ev in events], list(range(9)))
        self.assertEqual(
            [ev["l"] for ev in events],
            [2, 3, 2, 3, 2, 3, 2, 3, 2],
        )
        self.assertEqual([ev["v"]["i"] for ev in events if "i" in ev["v"]], [0, 0, 1, 1, 2, 2, 3, 3])
        self.assertEqual(ends[0]["o"], "return")
        self.assertIsNone(ends[0]["r"])

    def test_async(self):
        proc, _path, lines = run_recorder("async_func.py", "work", "4:6")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "6\n")

        self.assertEqual(len(kind(lines, "call_start")), 1)
        events = call_events(lines, "c1", "line")
        self.assertEqual([ev["l"] for ev in events], [5, 6])
        end = kind(lines, "call_end")[0]
        self.assertEqual(end["i"], "c1")
        self.assertEqual(end["r"], 6)

    def test_exception(self):
        proc, _path, lines = run_recorder("exception.py", "divide", "1:2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "caught\n")

        exc = kind(lines, "exception")
        self.assertEqual(len(exc), 1)
        self.assertEqual(exc[0]["x"]["t"], "ZeroDivisionError")
        self.assertEqual(exc[0]["x"]["m"], "division by zero")
        self.assertTrue(exc[0]["x"]["s"][0].endswith("exception.py:2 in divide"))

        end = kind(lines, "call_end")[0]
        self.assertEqual(end["o"], "throw")
        self.assertEqual(end["x"]["t"], "ZeroDivisionError")
        self.assertNotIn("r", end)

    def test_huge_list_argument(self):
        proc, _path, lines = run_recorder("huge_arg.py", "size", "1:2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "100000\n")

        start = kind(lines, "call_start")[0]
        xs = start["a"]["xs"]
        self.assertEqual(xs["$"], "list")
        self.assertEqual(xs["n"], 100000)
        self.assertTrue(xs["cut"])
        self.assertEqual(len(xs["v"]), 100)
        self.assertIn("id", xs)

        first = call_events(lines, "c1", "line")[0]
        self.assertEqual(first["v"]["xs"], {"$": "ref", "id": xs["id"]})

    def test_cycle(self):
        proc, _path, lines = run_recorder("cycle.py", "cycle", "1:5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(call_events(lines, "c1", "line")), 4)
        refs = [
            value
            for line in call_events(lines, "c1", "line")
            for value in line["v"].values()
            if isinstance(value, dict) and value.get("$") == "ref"
        ]
        self.assertTrue(refs)
        end = kind(lines, "call_end")[0]
        self.assertEqual(end["o"], "return")

    def test_object_with_broken_repr(self):
        proc, _path, lines = run_recorder("bad_repr.py", "take", "6:7")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "1\n")
        start = kind(lines, "call_start")[0]
        self.assertEqual(start["a"]["x"]["$"], "obj")
        self.assertEqual(start["a"]["x"]["cls"], "broken")

    def test_cap_calls(self):
        proc, _path, lines = run_recorder("cap.py", "spin", "1:5", ["--max-calls", "2"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "499500\n90\n")

        starts = kind(lines, "call_start")
        ends = kind(lines, "call_end")
        self.assertEqual(len(starts), 2)
        self.assertEqual(len(ends), 2)

        caps = kind(lines, "cap_hit")
        self.assertEqual(len(caps), 1)
        self.assertEqual(caps[0]["r"], "max_calls")
        self.assertNotIn("i", caps[0])

    def test_cap_events(self):
        proc, _path, lines = run_recorder("cap.py", "spin", "1:5", ["--max-events", "5"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "499500\n90\n")

        events = call_events(lines, "c1", "line")
        self.assertEqual(len(events), 5)
        caps = kind(lines, "cap_hit")
        self.assertTrue(caps)
        self.assertEqual({cap["r"] for cap in caps}, {"max_events"})
        self.assertEqual(caps[0]["i"], "c1")

        end = kind(lines, "call_end")[0]
        self.assertEqual(end["c"], "max_events")
        self.assertEqual(end["r"], 499500)

    def test_cap_bytes(self):
        proc, path, lines = run_recorder("cap.py", "spin", "1:5", ["--max-bytes", "3000"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "499500\n90\n")

        caps = kind(lines, "cap_hit")
        self.assertTrue(caps)
        self.assertEqual(caps[0]["r"], "max_bytes")
        self.assertLess(os.path.getsize(path), 8000)

    def test_threads(self):
        proc, _path, lines = run_recorder("threads.py", "work", "4:5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "[0, 2, 4, 6]\n")

        starts = kind(lines, "call_start")
        ends = kind(lines, "call_end")
        self.assertEqual(len(starts), 4)
        self.assertEqual(len(ends), 4)
        self.assertEqual(len({s["i"] for s in starts}), 4)
        self.assertEqual(sorted(e["r"] for e in ends), [0, 2, 4, 6])

    def test_exit_code_passes_through(self):
        proc, _path, lines = run_recorder("exit_code.py", "stop", "4:5")
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, "")
        end = kind(lines, "call_end")[0]
        self.assertEqual(end["o"], "throw")
        self.assertEqual(end["x"]["t"], "SystemExit")

    def test_function_never_called(self):
        proc, _path, lines = run_recorder("no_call.py", "unused", "1:2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "done\n")
        self.assertEqual(lines[0], {"k": "ver", "v": 1})
        self.assertEqual(kind(lines, "call_start"), [])
        self.assertEqual(kind(lines, "line"), [])

    def test_wrong_name_records_nothing(self):
        proc, _path, lines = run_recorder("simple.py", "nada", "1:3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "5\n")
        self.assertEqual(lines[0], {"k": "ver", "v": 1})
        self.assertEqual(kind(lines, "call_start"), [])

    def test_header_records_source(self):
        proc, _path, lines = run_recorder("simple.py", "add", "1:3")
        self.assertEqual(proc.returncode, 0, proc.stderr)

        meta = kind(lines, "meta")
        self.assertEqual(len(meta), 1)
        self.assertEqual(os.path.realpath(meta[0]["src"]), os.path.realpath(fixtures / "simple.py"))
        self.assertIsInstance(meta[0]["sm"], int)

    def test_module_mode(self):
        proc, _path, lines = run_recorder(
            "module_prog.py", "triple", "1:2", module="module_prog", cwd=fixtures
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "12\n")
        self.assertEqual(kind(lines, "call_start")[0]["a"], {"n": 4})
        self.assertEqual(kind(lines, "call_end")[0]["r"], 12)

    def test_argv_passthrough(self):
        proc, _path, lines = run_recorder("argv_prog.py", "show", "4:5", program_args=["4", "5"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, "9\n")
        self.assertEqual(kind(lines, "call_start")[0]["a"], {"a": 4, "b": 5})

    def test_creates_output_directory(self):
        parent = tempfile.mkdtemp(prefix="wakeline_")
        out_path = os.path.join(parent, "nested", "deeper", "rec.jsonl")
        proc = subprocess.run(
            [
                sys.executable,
                str(recorder),
                "--file",
                str(fixtures / "simple.py"),
                "--name",
                "add",
                "--lines",
                "1:3",
                "--out",
                out_path,
            ],
            cwd=str(root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(os.path.exists(out_path))

    def test_bad_line_range(self):
        proc = subprocess.run(
            [
                sys.executable,
                str(recorder),
                "--file",
                str(fixtures / "simple.py"),
                "--name",
                "add",
                "--lines",
                "3:1",
                "--out",
                os.path.join(tempfile.mkdtemp(prefix="wakeline_"), "rec.jsonl"),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid", proc.stderr)

    def test_unrelated_functions_not_traced(self):
        proc, _path, lines = run_recorder("simple.py", "add", "1:3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual({line.get("f") for line in kind(lines, "call_start")}, {"add"})


if __name__ == "__main__":
    unittest.main()
