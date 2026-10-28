import argparse
import os
import runpy
import sys

from wk_trace import tracer
from wk_writer import line_writer

# the python cli. it parses the flags the extension passes, opens the recording,
# installs the tracer and then runs the user's program in this same process so
# the trace hook can see its frames. uninstall and close happen in a finally.


def parse_lines(text):
    # the extension sends the function range as "start:end", one based and
    # inclusive. argparse turns a bad value into a clean usage error.
    parts = text.split(":", 1)
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("lines must look like start:end")
    try:
        start = int(parts[0])
        end = int(parts[1])
    except ValueError:
        raise argparse.ArgumentTypeError("lines must be integers")
    if start < 1 or end < start:
        raise argparse.ArgumentTypeError("line range is invalid")
    return start, end


def build_parser():
    # defaults match the extension's defaults. the limits can be overridden from
    # settings, but these are what you get if you run the recorder by hand.
    parser = argparse.ArgumentParser(prog="wakeline_recorder")
    parser.add_argument("--file", help="program file to run")
    parser.add_argument("--module", help="module to run with -m semantics")
    parser.add_argument("--target", help="file that contains the function")
    parser.add_argument("--name", required=True, help="qualified function name")
    parser.add_argument("--lines", required=True, type=parse_lines, help="function line range, start:end")
    parser.add_argument("--out", required=True, help="recording path")
    parser.add_argument("--max-calls", type=int, default=100)
    parser.add_argument("--max-events", type=int, default=10000)
    parser.add_argument("--max-bytes", type=int, default=10485760)
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--max-items", type=int, default=100)
    parser.add_argument("--max-string", type=int, default=4096)
    parser.add_argument("--max-value-bytes", type=int, default=65536)
    parser.add_argument("--mask", default="", help="comma separated names or glob patterns to hide")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    return parser


def main(argv=None):
    # --file and --module are mutually exclusive in effect. doing it by hand
    # rather than with argparse groups keeps the REMAINDER handling simple.
    parser = build_parser()
    args = parser.parse_args(argv)

    if bool(args.file) == bool(args.module):
        parser.error("give exactly one of --file or --module")
    if args.module and not args.target:
        parser.error("--module needs --target so the recorder knows which file to match")

    target = args.target or args.file
    program_args = args.rest
    if program_args and program_args[0] == "--":
        program_args = program_args[1:]
    masked = [p for p in args.mask.split(",") if p]

    # the program should see its own argv, not ours. anything after -- is passed
    # through untouched.
    program_name = args.file or args.module
    sys.argv = [program_name] + program_args

    # python puts the script's directory on sys.path when you run it normally.
    # runpy doesn't, so do it here or sibling imports break.
    if args.file:
        program_dir = os.path.dirname(os.path.abspath(args.file))
        if program_dir and program_dir not in sys.path:
            sys.path.insert(0, program_dir)
    else:
        cwd = os.getcwd()
        if cwd not in sys.path:
            sys.path.insert(0, cwd)

    writer = None
    trace = None

    try:
        writer = line_writer(args.out, max(0, args.max_bytes))
        # version and source metadata go first. the reader refuses a file whose
        # first line isn't a version it understands.
        writer.write({"k": "ver", "v": 1})
        source = os.path.realpath(target)
        meta = {"k": "meta", "src": source}
        try:
            meta["sm"] = int(os.stat(source).st_mtime * 1000)
        except OSError:
            pass
        writer.write(meta)
    except Exception as exc:
        print("wakeline: cannot write recording at %s: %s" % (args.out, exc), file=sys.stderr)
        writer = None

    if writer is not None:
        # target is the file the function lives in, which for --module is not
        # the file being run.
        trace = tracer(
            target_file=target,
            target_name=args.name,
            lines=args.lines,
            writer=writer,
            max_calls=args.max_calls,
            max_events=args.max_events,
            max_bytes=max(0, args.max_bytes),
            max_depth=args.max_depth,
            max_items=args.max_items,
            max_string=args.max_string,
            max_value_bytes=args.max_value_bytes,
            masked=masked,
        )
        try:
            trace.install()
        except Exception as exc:
            print("wakeline: cannot start tracing: %s" % exc, file=sys.stderr)
            try:
                writer.write({"k": "failure", "why": str(exc)[:500], "where": "install"}, force=True)
            except Exception:
                pass
            trace = None

    # runpy runs the program with __name__ == "__main__", the same as python
    # would. the finally is non negotiable: the user's program may raise, and
    # the recording still has to be flushed and the trace removed.
    try:
        if args.module:
            runpy.run_module(args.module, run_name="__main__", alter_sys=True)
        else:
            runpy.run_path(args.file, run_name="__main__")
    finally:
        if trace is not None:
            trace.uninstall()
        if writer is not None:
            writer.close()


if __name__ == "__main__":
    main()
