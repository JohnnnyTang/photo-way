// App shell entry. Wave 0 placeholder; Wave 2 · F builds the real UI.
import { invoke } from "@tauri-apps/api/core";

const app = document.getElementById("app")!;
app.innerHTML = `<h1>Photo Way</h1><p id="version"></p>`;
invoke<string>("core_version").then((v) => {
  document.getElementById("version")!.textContent = `core ${v}`;
});
