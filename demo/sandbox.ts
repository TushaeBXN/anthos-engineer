import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEED_DIR = path.join(fileURLToPath(import.meta.url), "../seed");
const PROJECT_ROOT = path.join(fileURLToPath(import.meta.url), "../..");

export async function createSandbox(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-demo-"));

  await copyDir(SEED_DIR, dir);

  // Symlink node_modules so tsc and tsx are available without a separate install
  await fs.symlink(
    path.join(PROJECT_ROOT, "node_modules"),
    path.join(dir, "node_modules"),
  );

  // Initialize git so the verification gate can compute diff hashes
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "forge@demo.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Forge Demo"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial seed"], { cwd: dir });

  return dir;
}

export async function cleanupSandbox(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
