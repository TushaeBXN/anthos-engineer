/**
 * Forge's version, read from its own package.json so there is one place to change it.
 * Works from the source (agent/version.ts) and from the build (dist/agent/version.js).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "forge-anthos-intelligence" && pkg.version) return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

export const VERSION = readVersion();
