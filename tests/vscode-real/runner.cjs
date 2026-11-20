// Runs inside VS Code (see run.mjs). Checks the extension against a stand-in Forge.
const vscode = require("vscode"); const fs = require("fs"); const path = require("path");
const LOG = process.env.FORGE_TRIAL_LOG, OUT = process.env.FORGE_TRIAL_OUT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = () => fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(200); } return false; }
exports.run = async function () {
  const results = []; const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail });
  try {
    const ext = vscode.extensions.getExtension("anthos-intelligence.forge-vscode");
    check("extension found", ext); await until(() => ext.isActive, 10000);
    check("activates on startup", ext.isActive);
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["forge.start", "forge.askSelection", "forge.askFile", "forge.repomap", "forge.undo"]) check(`command ${c} registered`, cmds.includes(c));
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;

    await vscode.commands.executeCommand("forge.start");
    const t = vscode.window.terminals.find((x) => x.name === "Forge");
    check("Start opens a terminal named Forge", t);
    check("Forge starts in the workspace folder", await until(() => lines().some((l) => l.started && fs.realpathSync(l.started) === fs.realpathSync(ws))), JSON.stringify(lines()));
    await vscode.commands.executeCommand("forge.start");
    check("Start again reuses the terminal", vscode.window.terminals.filter((x) => x.name === "Forge").length === 1);

    await vscode.commands.executeCommand("forge.repomap");
    check("Show Repo Map sends /repomap", await until(() => lines().some((l) => l.line === "/repomap")));
    await vscode.commands.executeCommand("forge.undo");
    check("Undo sends /undo", await until(() => lines().some((l) => l.line === "/undo")));

    const doc = await vscode.workspace.openTextDocument(path.join(ws, "math.js"));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "// unsaved\n"));
    const before = lines().length;
    await vscode.commands.executeCommand("forge.askFile"); await wait(1500);
    check("an unsaved file is not sent", lines().length === before);
    await vscode.commands.executeCommand("workbench.action.files.revert");

    // Forge quits on its own: the terminal must end with it, and the next command must start a new Forge.
    t.sendText("/quit-test");
    check("when Forge quits, its terminal ends", await until(() => t.exitStatus !== undefined), JSON.stringify(t.exitStatus));
    const n = lines().length;
    await vscode.commands.executeCommand("forge.repomap");
    check("the next command starts a new Forge and reaches it, not a shell", await until(() => { const l = lines().slice(n); return l[0] && l[0].started && l.some((x) => x.line === "/repomap"); }), JSON.stringify(lines().slice(n)));

    vscode.window.terminals.filter((x) => x.name === "Forge" && x.exitStatus === undefined).forEach((x) => x.dispose()); await wait(1000);
    await vscode.commands.executeCommand("forge.start");
    check("after the terminal is closed, Start opens a new one", await until(() => lines().filter((l) => l.started).length === 3));
  } catch (e) { results.push({ name: "runner error", ok: false, detail: String(e && e.stack || e) }); }
  fs.writeFileSync(OUT, JSON.stringify({ version: vscode.version, results }, null, 2));
};
