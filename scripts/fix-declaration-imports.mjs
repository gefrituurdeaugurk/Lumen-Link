import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? declarationFiles(path) : [path];
    }),
  );
  return files.flat().filter((path) => path.endsWith(".d.ts"));
}

for (const path of await declarationFiles(dist)) {
  const source = await readFile(path, "utf8");
  const rewritten = source.replaceAll(/(["'][^"']+)\.ts(["'])/g, "$1.js$2");
  if (rewritten !== source) await writeFile(path, rewritten);
}