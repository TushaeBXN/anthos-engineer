// What the extension types into Forge. Kept free of the vscode module so it can be tested with plain Node.

/** Forge reads one line per message, so newlines would send half a question. */
function oneLine(text) {
  return String(text).replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** VS Code lines are 0-based, and a selection ending at column 0 doesn't include that line. */
function lineRange(start, end, endCharacter) {
  const last = endCharacter === 0 && end > start ? end - 1 : end;
  return { from: start + 1, to: last + 1 };
}

function selectionMessage(file, from, to, question) {
  const where = from === to ? `line ${from}` : `lines ${from}-${to}`;
  return oneLine(`Look at ${file} ${where}: ${question}`);
}

function fileMessage(file, question) {
  return oneLine(`Look at ${file}: ${question}`);
}

module.exports = { oneLine, lineRange, selectionMessage, fileMessage };
