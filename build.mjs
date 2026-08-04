/**
 * Bundles the demo into a single self-contained index.html.
 *
 * Inlining matters here: the page has to keep working from a file:// URL,
 * because getUserMedia is routinely blocked in sandboxed frames and "save it
 * and open it from disk" is the documented fallback. ES modules cannot be
 * loaded over file://, so the bundle goes inline in a classic script tag.
 */

import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [join(root, "src/demo/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  minify: false,
  write: false,
  legalComments: "none",
});

const js = result.outputFiles[0].text;
const template = await readFile(join(root, "src/demo/index.template.html"), "utf8");

if (!template.includes("/*BUNDLE*/")) {
  throw new Error("template is missing the /*BUNDLE*/ placeholder");
}

// Guard against the bundle terminating the script element early.
const safe = js.replaceAll("</script", "<\\/script");
const html = template.replace("/*BUNDLE*/", () => `\n${safe}\n`);

await writeFile(join(root, "index.html"), html);
console.log(`index.html  ${(html.length / 1024).toFixed(1)} kB`);
