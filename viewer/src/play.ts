import type { Item } from "./model";
import { clamp } from "./util";

/** What the map draws while the trip plays: legs before `k` are complete, leg `k` is drawn up to `head`. */
export interface PlayFrame {
  k: number;
  from: [number, number];
  head: [number, number];
}

export interface PlayHost {
  /** The stops to play, in order (the route of what the map shows). */
  points(): Item[];
  onFrame(frame: PlayFrame | null): void;
  /** The head reached a stop. */
  onStop(item: Item): void;
  /** Playing, paused or stopped. */
  onState(state: PlayState): void;
}

export type PlayState = "playing" | "paused" | "stopped";

export const SPEEDS = [1, 2, 4, 8] as const;
const HOLD_AT_END_MS = 1200;

/** Milliseconds from one stop to the next at 1x: short trips linger on each photo, long ones keep moving. */
export const msPerStop = (stops: number) => clamp(40000 / Math.max(1, stops - 1), 120, 1400);

/** Animates the trip stop by stop. Positions are fractional stop indexes. */
export class Player {
  private pts: Item[] = [];
  private pos = 0;
  private reached = -1;
  private raf = 0;
  private last = 0;
  private endTimer = 0;
  private speedIndex = 0;
  state: PlayState = "stopped";

  constructor(private host: PlayHost) {}

  get speed(): number {
    return SPEEDS[this.speedIndex]!;
  }

  get active(): boolean {
    return this.state !== "stopped";
  }

  cycleSpeed(): number {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    return this.speed;
  }

  /** Starts from the beginning, or resumes when paused. Returns false when there is nothing to play. */
  play(): boolean {
    if (this.state === "paused" && this.pos < this.pts.length - 1) {
      this.setState("playing");
      this.loop();
      return true;
    }
    clearTimeout(this.endTimer); // pressed again while holding the last frame: start over
    this.pts = this.host.points();
    if (this.pts.length < 2) return false;
    this.pos = 0;
    this.reached = -1;
    this.setState("playing");
    this.advance(0);
    this.loop();
    return true;
  }

  pause(): void {
    if (this.state !== "playing") return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.setState("paused");
  }

  /** Ends playback and tells the host to draw the full route again. */
  stop(): void {
    if (this.state === "stopped") return;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.endTimer);
    this.raf = 0;
    this.setState("stopped");
    this.host.onFrame(null);
  }

  private setState(s: PlayState): void {
    this.state = s;
    this.host.onState(s);
  }

  private loop(): void {
    this.last = performance.now();
    const tick = (now: number) => {
      if (this.state !== "playing") return;
      // rAF time can precede the performance.now() taken when scheduling (Firefox); a background tab must not jump ahead.
      const dt = Math.max(0, Math.min(100, now - this.last));
      this.last = now;
      this.advance((dt * this.speed) / msPerStop(this.pts.length));
      if (this.state === "playing" && this.pos < this.pts.length - 1) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private advance(by: number): void {
    const n = this.pts.length;
    this.pos = Math.min(n - 1, this.pos + by);
    const k = Math.floor(this.pos);
    if (k > this.reached) {
      this.reached = k;
      this.host.onStop(this.pts[k]!);
    }
    const a = this.pts[Math.min(k, n - 2)]!;
    const b = this.pts[Math.min(k + 1, n - 1)]!;
    const f = k >= n - 1 ? 1 : this.pos - k;
    this.host.onFrame({ k: Math.min(k, n - 2), from: [a.lon, a.lat], head: [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f] });
    if (this.pos >= n - 1) {
      this.setState("paused");
      this.endTimer = window.setTimeout(() => this.stop(), HOLD_AT_END_MS);
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.endTimer);
  }
}
