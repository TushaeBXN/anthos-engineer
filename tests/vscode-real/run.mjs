// Runs the extension inside a real VS Code, with a throwaway profile, against a stand-in Forge
// (recorder.cjs) that logs where it started and every line it receives. Not part of `npm test`:
// it needs VS Code installed and opens a window for a few seconds.
//   node tests/vscode-real/run.mjs [path to the VS Code binary]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "../../vscode-extension");
const bin = process.argv[2] ?? (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : "code");
// VS Code's socket path must stay under 103 characters, so keep this short.
const dir = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "fvsc-"));
const ws = path.join(dir, "workspace");
fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
fs.writeFileSync(path.join(ws, "math.js"), "export function average(numbers) {\n  return 0;\n}\n");
const log = path.join(dir, "recorder.log"), out = path.join(dir, "result.json");
fs.writeFileSync(path.join(ws, ".vscode/settings.json"), JSON.stringify({ "forge.command": `node "${path.join(here, "recorder.cjs")}" "${log}"` }));

const vsc = spawn(bin, [ws, `--extensionDevelopmentPath=${ext}`, `--extensionTestsPath=${path.join(here, "runner.cjs")}`,
  `--user-data-dir=${path.join(dir, "p")}`, `--extensions-dir=${path.join(dir, "e")}`, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window"],
  { env: { ...process.env, FORGE_TRIAL_LOG: log, FORGE_TRIAL_OUT: out }, stdio: "ignore" });

const end = Date.now() + 120_000;
while (!fs.existsSync(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
vsc.kill();
if (!fs.existsSync(out)) { console.error("VS Code didn't report back within 2 minutes."); process.exit(1); }
const { version, results } = JSON.parse(fs.readFileSync(out, "utf8"));
console.log(`VS Code ${version}`);
for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.name}${r.ok ? "" : `  ${r.detail}`}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
