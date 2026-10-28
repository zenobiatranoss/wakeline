import json
import os
import threading

# appends one json object per line, bytes counted as it goes. the byte cap is
# enforced here and nowhere else: a write that would cross it returns -1 and the
# tracer turns that into a cap_hit line.


class line_writer:
    def __init__(self, path, max_bytes):
        # make the folder first. a fresh global storage directory won't exist
        # yet, and failing to open the recording is fatal for the run.
        self.max_bytes = max_bytes
        self.bytes = 0
        self.closed = False
        # tracing can happen on several threads at once, so every write takes
        # the lock. json.dumps happens outside it to keep the lock short.
        self._lock = threading.Lock()
        self._since_flush = 0

        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)

        self._file = open(path, "wb")

    def write(self, obj, force=False):
        # compact separators and raw unicode: this file is read by our own
        # reader, not by a human, and bytes are the thing we are limiting.
        data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            if self.closed:
                return -1
            # forced writes are allowed to cross the cap. they are used for
            # cap_hit, failure and call_end, which the reader needs to make sense
            # of everything before them.
            if not force and self.max_bytes and self.bytes + len(data) > self.max_bytes:
                return -1
            self._file.write(data)
            self.bytes += len(data)
            self._since_flush += 1
            # flushing every write is slow, flushing never loses the tail on a
            # kill. 256 lines is the compromise.
            if self._since_flush >= 256:
                self._file.flush()
                self._since_flush = 0
            return len(data)

    def flush(self):
        with self._lock:
            if not self.closed:
                self._file.flush()
                self._since_flush = 0

    def close(self):
        # called from a finally in the cli, so it runs even if the program
        # raised. make it idempotent.
        with self._lock:
            if self.closed:
                return
            try:
                self._file.flush()
            finally:
                self._file.close()
                self.closed = True
