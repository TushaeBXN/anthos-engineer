// Stand-in for forge: records where it started and every line typed into it.
const fs = require("fs"); const log = process.argv[2];
fs.appendFileSync(log, JSON.stringify({ started: process.cwd() }) + "\n");
process.stdin.setEncoding("utf8"); let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.search(/\r|\n/)) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line === "/quit-test") process.exit(0); if (line) fs.appendFileSync(log, JSON.stringify({ line }) + "\n"); } });
