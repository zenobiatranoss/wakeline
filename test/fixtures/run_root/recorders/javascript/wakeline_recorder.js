const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--out") + 1];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '{"k":"ver","v":1}\n');

const split = argv.indexOf("--");
fs.writeFileSync(out + ".args", JSON.stringify(split < 0 ? [] : argv.slice(split + 1)));

process.stdout.write("hello from fake\n");

if (argv.includes("slow")) {
  setInterval(() => {}, 1000);
} else {
  process.exit(3);
}
