// Copies the export template next to the built viewer assets (dist/template.html).
import { copyFileSync } from "node:fs";

copyFileSync(new URL("../src/template.html", import.meta.url), new URL("../dist/template.html", import.meta.url));
