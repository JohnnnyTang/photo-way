// Video poster frames (PLAN D6): decode a frame in the webview, hand the JPEG to the backend.
import { api } from "./api";

const LOAD_TIMEOUT_MS = 8000;
const SEEK_TIMEOUT_MS = 5000;
const MAX_EDGE = 512;
const SEEK_SECONDS = 0.5;

let base = "";

/** Absolute URL of the source video of scan entry `index`, served by the `pw` protocol. */
export function sourceUrl(index: number): string {
  return `${base}/src/${index}`;
}

/** `previewUrl` is e.g. `http://pw.localhost/preview.html` (Windows) or `pw://localhost/preview.html`. */
export function setProtocolBase(previewUrl: string): void {
  base = previewUrl.slice(0, previewUrl.lastIndexOf("/"));
}

function once(target: EventTarget, ok: string[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), ms);
    const handlers = ok.map((name) => {
      const h = () => done(name !== "error");
      target.addEventListener(name, h, { once: true });
      return [name, h] as const;
    });
    function done(result: boolean) {
      clearTimeout(timer);
      for (const [name, h] of handlers) target.removeEventListener(name, h);
      resolve(result);
    }
  });
}

/** A JPEG of the video near its start, or null when the webview cannot decode it in time. */
export async function captureFrame(url: string): Promise<Blob | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  try {
    const loaded = once(video, ["loadeddata", "error"], LOAD_TIMEOUT_MS);
    video.src = url;
    if (!(await loaded)) return null;
    const target = Number.isFinite(video.duration) ? Math.min(SEEK_SECONDS, video.duration / 2) : SEEK_SECONDS;
    if (target > 0.01) {
      const seeked = once(video, ["seeked", "error"], SEEK_TIMEOUT_MS);
      video.currentTime = target;
      if (!(await seeked)) return null;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
      } catch {
        resolve(null); // tainted canvas
      }
    });
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

export interface PosterRun {
  /** Videos that got a real poster. */
  captured: number;
  /** Videos that will use the placeholder tile. */
  failed: number;
  cancelled: boolean;
}

/** Captures and registers a poster for each entry index, one at a time. */
export async function capturePosters(
  indices: number[],
  onStep: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<PosterRun> {
  const run: PosterRun = { captured: 0, failed: 0, cancelled: false };
  for (let i = 0; i < indices.length; i++) {
    if (isCancelled()) {
      run.cancelled = true;
      break;
    }
    onStep(i, indices.length);
    const blob = await captureFrame(sourceUrl(indices[i]));
    if (blob) {
      try {
        await api.setPoster(indices[i], new Uint8Array(await blob.arrayBuffer()));
        run.captured++;
        continue;
      } catch {
        // fall through to the placeholder
      }
    }
    run.failed++;
  }
  onStep(indices.length, indices.length);
  return run;
}
