// Viewer entry. Wave 0 placeholder: proves the build/embed pipeline; Wave 1 · C replaces the UI.
import "./style.css";
import { findProject, resolveRef } from "./data";
import type { Project } from "./model";

export interface MountOptions {
  mode?: "export" | "preview";
  resolveRef?: (ref: string) => string;
}

export function mount(el: HTMLElement, project: Project, opts: MountOptions = {}) {
  const resolve = opts.resolveRef ?? ((r: string) => resolveRef(r));
  const render = (p: Project) => {
    el.innerHTML = "";
    const h = document.createElement("h1");
    h.textContent = `${p.title} — ${p.items.length} items`;
    const grid = document.createElement("div");
    grid.className = "pw-grid";
    for (const item of p.items.slice(0, 60)) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = item.name;
      img.src = resolve(item.thumb);
      grid.append(img);
    }
    el.append(h, grid);
  };
  render(project);
  return { destroy: () => (el.innerHTML = ""), setProject: render };
}

document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("photoway");
  const project = findProject();
  if (el && project) mount(el, project, { mode: "export" });
});
