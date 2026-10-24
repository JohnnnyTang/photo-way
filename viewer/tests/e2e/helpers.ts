// Shared plumbing for the output specs: manifest, per-worker servers (CLI `photoway serve` or a Node fallback),
// console-error collection, and the viewer's readiness signal.
import { test as base, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

export type OutputId = "html" | "dir" | "zip";
export interface Manifest {
  source: "cli" | "fallback";
  cli: string | null;
  note: string;
  outputs: Record<OutputId, { file: string; archive?: string | null }>;
}

export const repoRoot = resolve(process.cwd(), "..");
export const outputsDir = join(repoRoot, "target", "e2e-outputs", "current");
export const loadManifest = (): Manifest => JSON.parse(readFileSync(join(outputsDir, "manifest.json"), "utf8"));

export interface Target {
  /** URL to open: file:// or http://. */
  url: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

interface Running {
  url: string;
  stop(): Promise<void>;
}

/** `photoway serve <path> --addr 127.0.0.1:0`; the first stdout line is "Serving <path> at <url>". */
function startCliServer(cli: string, path: string): Promise<Running> {
  return new Promise((resolveRun, reject) => {
    const child: ChildProcess = spawn(cli, ["serve", path, "--addr", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`photoway serve printed no URL in 15 s. stdout: ${out} stderr: ${err}`));
    }, 15_000);
    child.stderr!.on("data", (d) => (err += String(d)));
    child.stdout!.on("data", (d) => {
      out += String(d);
      const m = /^Serving .* at (\S+)\s*$/m.exec(out);
      if (!m) return;
      clearTimeout(timer);
      resolveRun({
        url: m[1],
        stop: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill();
            setTimeout(done, 3000);
          }),
      });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`photoway serve exited early (${code}). stderr: ${err}`));
    });
  });
}

/** Tiny static server used while the CLI is unavailable. Serves `root`; "/" redirects to `entry`. */
function startNodeServer(root: string, entry: string): Promise<Running> {
  const base = resolve(root);
  const server: Server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const file = resolve(base, "." + (path === "/" ? "/" + entry : path));
      if (file !== base && !file.startsWith(base + sep)) throw new Error("outside root");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolveRun) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolveRun({ url: `http://127.0.0.1:${port}/`, stop: () => new Promise<void>((d) => server.close(() => d())) });
    });
  });
}

async function startServer(manifest: Manifest, id: OutputId): Promise<Running> {
  const o = manifest.outputs[id];
  if (manifest.source === "cli" && manifest.cli) {
    const path = id === "html" ? o.file : id === "dir" ? dirname(o.file) : (o.archive ?? dirname(o.file));
    return startCliServer(manifest.cli, path);
  }
  return startNodeServer(dirname(o.file), basename(o.file));
}

export const isLocal = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol !== "http:" && u.protocol !== "https:" ? true : u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return true;
  }
};

/**
 * Console errors that are fine: failed network requests to remote (non-local http/https) hosts, i.e. online map
 * tiles when the machine is offline or blocks them. Everything else, and every uncaught page error, counts.
 */
export function isIgnorableConsoleError(m: ConsoleMessage): boolean {
  if (m.type() !== "error") return true;
  const url = m.location().url;
  const text = m.text();
  const networkNoise = /Failed to load resource|net::ERR_|NetworkError|AJAXError|Failed to fetch/i.test(text);
  return networkNoise && !!url && !isLocal(url);
}

export interface ViewerProject {
  id: string;
  title: string;
  items: { id: number; name: string; lat?: number; lon?: number; flags?: string[] }[];
}

export interface Stats {
  items: number;
  onMap: number;
  suspects: number;
  hidden: number;
  edited: number;
  timelineNodes: number;
  selected: number | null;
  modalOpen: boolean;
  map: { clusters: number; pins: number; hasRoute: boolean; loaded: boolean } | null;
}

export const statsOf = (page: Page): Promise<Stats> => page.evaluate(() => (window as any).__photoway__.stats());

/** Waits for the viewer's ready signal: the handle exists, the project is loaded and the map overlay is up. */
export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as any).__photoway__?.stats?.();
    return !!s && s.items > 0 && s.map?.loaded === true;
  }, undefined, { timeout: 30_000 }); // software WebGL on CI runners can be slow
}

export const projectOf = (page: Page): Promise<ViewerProject> =>
  page.evaluate(() => {
    const w = window as any;
    if (w.__PHOTOWAY__) return w.__PHOTOWAY__;
    return JSON.parse(document.getElementById("pw-data")!.textContent!);
  });

export const toFileUrl = (p: string): string => pathToFileURL(p).href;

interface Fixtures {
  /** Console + page errors seen so far (online tile failures excluded). */
  errors: string[];
}
interface WorkerFixtures {
  manifest: Manifest;
  servers: (id: OutputId) => Promise<Target>;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  manifest: [async ({}, use) => use(loadManifest()), { scope: "worker" }],
  servers: [
    async ({ manifest }, use) => {
      const running = new Map<OutputId, Promise<Running>>();
      await use(async (id) => {
        if (!running.has(id)) running.set(id, startServer(manifest, id));
        return { url: (await running.get(id)!).url };
      });
      await Promise.all([...running.values()].map((r) => r.then((x) => x.stop(), () => undefined)));
    },
    { scope: "worker" },
  ],
  errors: async ({ page }, use) => {
    // No request interception: routing breaks file:// pages in WebKit. The outputs use the offline basemap, and
    // failed remote (online tile) requests are filtered out of the error list by isIgnorableConsoleError.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (!isIgnorableConsoleError(m)) errors.push(`console.error: ${m.text()} (${m.location().url})`);
    });
    await use(errors);
  },
});

export { expect };
