// Viewer entry: exposes `PhotoWay.mount` (DATA_CONTRACT 3) and auto-mounts on DOMContentLoaded.
import "./style.css";
import { App, type MountOptions } from "./app";
import { findProject } from "./data";
import type { Project } from "./model";
import { normalizeLocale } from "../../shared/locale";
import { viewerStrings } from "./catalog";

export type { MountOptions } from "./app";
export type { Project } from "./model";

export interface PhotoWayHandle {
  destroy(): void;
  setProject(p: Project): void;
  /** Diagnostics for tests and tooling; not part of the stable contract. */
  stats(): ReturnType<App["stats"]>;
}

export function mount(el: HTMLElement, project: Project, opts: MountOptions = {}): PhotoWayHandle {
  const app = new App(el, project, { mode: "export", ...opts });
  return {
    destroy: () => app.destroy(),
    setProject: (p) => app.setProject(p),
    stats: () => app.stats(),
  };
}

function autoMount(): void {
  const el = document.getElementById("photoway");
  if (!el) return;
  const project = findProject();
  if (!project) {
    el.textContent = viewerStrings(normalizeLocale(navigator.language) ?? "en").loadError;
    return;
  }
  (window as unknown as { __photoway__?: PhotoWayHandle }).__photoway__ = mount(el, project, { mode: "export" });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
}
