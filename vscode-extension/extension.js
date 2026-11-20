// Forge in VS Code. Forge runs in the terminal panel exactly as it does in a shell,
// so approvals, the policy check and the status line all work unchanged. The terminal
// runs only Forge: when Forge quits, the terminal ends, so text never reaches a shell.
const vscode = require("vscode");
const { lineRange, selectionMessage, fileMessage } = require("./messages");

const NAME = "Forge";
/** A new terminal needs a moment for the shell to start Forge before it can take a message. */
const STARTUP_MS = 2500;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(tools) Forge";
  status.tooltip = "Start Forge in the terminal";
  status.command = "forge.start";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("forge.start", () => forgeTerminal()),
    vscode.commands.registerCommand("forge.askSelection", askSelection),
    vscode.commands.registerCommand("forge.askFile", askFile),
    vscode.commands.registerCommand("forge.repomap", () => send("/repomap")),
    vscode.commands.registerCommand("forge.undo", () => send("/undo")),
  );
}

/** The open Forge terminal, or a new one started in the workspace folder. */
function forgeTerminal() {
  const open = vscode.window.terminals.find((t) => t.name === NAME && t.exitStatus === undefined);
  if (open) {
    open.show();
    return { terminal: open, fresh: false };
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  const command = vscode.workspace.getConfiguration("forge").get("command", "forge");
  const terminal = vscode.window.createTerminal({ name: NAME, cwd: folder?.uri.fsPath, ...runOnly(command) });
  terminal.show();
  return { terminal, fresh: true };
}

/**
 * The terminal runs Forge itself, not a shell that starts it, so when Forge quits the terminal
 * ends too. Otherwise the next question would be typed into the shell left behind and run as
 * a command, outside Forge's policy and sandbox. The login shell is used only to find the
 * command on your PATH (nvm, Homebrew).
 */
function runOnly(command) {
  if (process.platform === "win32") return { shellPath: process.env.ComSpec || "cmd.exe", shellArgs: ["/d", "/c", command] };
  return { shellPath: process.env.SHELL || "/bin/sh", shellArgs: ["-l", "-i", "-c", command] };
}

async function send(text) {
  const { terminal, fresh } = forgeTerminal();
  if (fresh) await new Promise((resolve) => setTimeout(resolve, STARTUP_MS));
  terminal.sendText(text);
}

/** Forge reads files from disk, so the editor must be showing a saved file. */
function savedEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Forge: open a file first.");
    return null;
  }
  if (editor.document.uri.scheme !== "file" || editor.document.isDirty) {
    vscode.window.showWarningMessage("Forge reads files from disk. Save this file first.");
    return null;
  }
  return editor;
}

async function askSelection() {
  const editor = savedEditor();
  if (!editor) return;
  const { start, end } = editor.selection;
  const { from, to } = lineRange(start.line, end.line, end.character);
  const question = await vscode.window.showInputBox({ prompt: `Ask Forge about lines ${from}-${to}` });
  if (!question) return;
  await send(selectionMessage(vscode.workspace.asRelativePath(editor.document.uri), from, to, question));
}

async function askFile() {
  const editor = savedEditor();
  if (!editor) return;
  const file = vscode.workspace.asRelativePath(editor.document.uri);
  const question = await vscode.window.showInputBox({ prompt: `Ask Forge about ${file}` });
  if (!question) return;
  await send(fileMessage(file, question));
}

function deactivate() {}

module.exports = { activate, deactivate };
