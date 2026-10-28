const fs = require("fs");
const path = require("path");

// appends one json object per line. the only policy here is the byte cap: a
// write that would cross it is refused, and the caller turns that into a
// cap_hit line. forced writes still go through so call_end is never lost.

class line_writer {
  constructor(file, max_bytes) {
    // create the folder first, otherwise opening the file fails for a fresh
    // global storage directory.
    this.max_bytes = max_bytes;
    this.bytes = 0;
    this.closed = false;
    const dir = path.dirname(path.resolve(file));
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.fd = fs.openSync(file, "w");
  }

  write(obj, force = false) {
    // -1 means "over the cap"; the caller understands that, but a plain throw
    // from JSON.stringify would be a bug in the recording code, not the program.
    if (this.closed) return -1;
    const data = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
    if (!force && this.max_bytes && this.bytes + data.length > this.max_bytes) return -1;
    fs.writeSync(this.fd, data);
    this.bytes += data.length;
    return data.length;
  }

  flush() {
    if (!this.closed) fs.fsyncSync(this.fd);
  }

  // fsync on close so a crash right after the program ends doesn't lose the
  // final lines. flush is the cheaper version used between calls.
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.fsyncSync(this.fd);
    } finally {
      fs.closeSync(this.fd);
    }
  }
}

module.exports = { line_writer };
