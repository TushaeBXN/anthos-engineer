/**
 * Forge demo server — Express + Server-Sent Events.
 * Each /api/run request spawns a worker subprocess that runs the Forge pipeline
 * in an ephemeral git sandbox. Events stream back as SSE.
 *
 * Start: ANTHROPIC_API_KEY=sk-ant-... node --import tsx/esm demo/server.ts
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createSandbox, cleanupSandbox } from "./sandbox.js";

const WORKER = path.join(fileURLToPath(import.meta.url), "../worker.ts");
const PUBLIC = path.join(fileURLToPath(import.meta.url), "../public");
const PORT = Number(process.env["PORT"] ?? 3000);

// ── Rate limiting ─────────────────────────────────────────────────────────────
const ipCounts = new Map<string, { count: number; reset: number }>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const window = 10 * 60 * 1000; // 10 minutes
  const limit = 5;
  const entry = ipCounts.get(ip);
  if (!entry || now > entry.reset) {
    ipCounts.set(ip, { count: 1, reset: now + window });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ── Session store ─────────────────────────────────────────────────────────────
interface Session {
  events: string[];
  done: boolean;
  listeners: Set<(chunk: string) => void>;
}

const sessions = new Map<string, Session>();

function pushEvent(id: string, data: object): void {
  const session = sessions.get(id);
  if (!session) return;
  const chunk = `data: ${JSON.stringify(data)}\n\n`;
  session.events.push(chunk);
  for (const l of session.listeners) l(chunk);
}

// ── Worker runner ─────────────────────────────────────────────────────────────
async function runSession(sessionId: string, goal: string): Promise<void> {
  let sandboxDir: string | null = null;

  try {
    pushEvent(sessionId, { type: "status", message: "Creating sandbox…" });
    sandboxDir = await createSandbox();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx/esm", WORKER, goal, sandboxDir!],
        {
          env: { ...process.env },
          timeout: 3 * 60 * 1000,
        },
      );

      let buffer = "";

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("EVENT:")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as object;
            pushEvent(sessionId, event);
          } catch {
            // Ignore malformed lines
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        // Forward worker errors as a status event so the UI can display them
        pushEvent(sessionId, {
          type: "worker-log",
          message: chunk.toString().trim().slice(0, 300),
        });
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Worker exited with code ${code}`));
      });

      child.on("error", reject);
    });
  } catch (err) {
    pushEvent(sessionId, { type: "error", message: (err as Error).message });
  } finally {
    if (sandboxDir) await cleanupSandbox(sandboxDir).catch(() => {});
    const session = sessions.get(sessionId);
    if (session) {
      session.done = true;
      // Flush any remaining listeners
      for (const l of session.listeners) l(`data: ${JSON.stringify({ type: "stream-end" })}\n\n`);
      session.listeners.clear();
      setTimeout(() => sessions.delete(sessionId), 10 * 60 * 1000);
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const ip = (req.headers["x-forwarded-for"] as string ?? "").split(",")[0].trim()
    || req.socket.remoteAddress
    || "unknown";

  // POST /api/run
  if (req.method === "POST" && url.pathname === "/api/run") {
    if (!checkRate(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests — try again in 10 minutes" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let goal = "";
      try {
        goal = (JSON.parse(body) as { goal?: string }).goal?.trim() ?? "";
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!goal) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "goal is required" }));
        return;
      }
      if (goal.length > 500) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "goal must be under 500 characters" }));
        return;
      }

      const sessionId = randomUUID();
      sessions.set(sessionId, { events: [], done: false, listeners: new Set() });
      runSession(sessionId, goal); // fire and forget

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId }));
    });
    return;
  }

  // GET /api/stream/:sessionId
  const streamMatch = url.pathname.match(/^\/api\/stream\/([0-9a-f-]{36})$/);
  if (req.method === "GET" && streamMatch) {
    const session = sessions.get(streamMatch[1]);
    if (!session) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Replay buffered events
    for (const chunk of session.events) res.write(chunk);
    if (session.done) { res.end(); return; }

    const listener = (chunk: string) => {
      res.write(chunk);
      if (chunk.includes('"type":"done"') || chunk.includes('"type":"error"') || chunk.includes('"type":"stream-end"')) {
        res.end();
      }
    };
    session.listeners.add(listener);
    req.on("close", () => session.listeners.delete(listener));
    return;
  }

  // Static files
  let filePath = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  // Basic path traversal guard
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentType: Record<string, string> = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".ico": "image/x-icon",
  };
  res.writeHead(200, { "Content-Type": contentType[ext] ?? "text/plain" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\nForge demo server running at http://localhost:${PORT}`);
  console.log(`Provider: ${process.env["FORGE_PROVIDER"] ?? "anthropic"}`);
  console.log(`Model:    ${process.env["FORGE_MODEL"] ?? "claude-sonnet-5-5"}\n`);
});
