/**
 * One command for phone testing: build, serve just the bundle, open a
 * Cloudflare tunnel, and print the URL to type into the phone.
 *
 * The tunnel is not a convenience. iOS Safari refuses getUserMedia on a
 * self-signed certificate no matter how the warning is dismissed, so a
 * genuinely trusted certificate is the only way to reach the camera from a
 * device that is not the one running the server.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT ?? "8080";
const children = [];

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, ...opts });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await new Promise((resolve, reject) => {
  const build = run("node", ["build.mjs"], { stdio: "inherit" });
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
});

// Serve a directory holding only the bundle: the tunnel is public, and the
// repo root would put source, .git and anything else alongside it.
await mkdir(join(root, "dist"), { recursive: true });
await copyFile(join(root, "index.html"), join(root, "dist/index.html"));

const server = run("npx", ["http-server", "dist", "-p", port, "-c-1", "--silent"]);
server.on("exit", (code) => {
  if (code !== 0) {
    console.error(`\nhttp-server exited (${code}) — is port ${port} already in use?`);
    shutdown(1);
  }
});

const tunnel = run("cloudflared", ["tunnel", "--url", `http://localhost:${port}`]);

tunnel.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error("\ncloudflared is not installed. Run: brew install cloudflared");
    shutdown(1);
  }
});

let announced = false;
const watch = (chunk) => {
  const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match || announced) return;
  announced = true;
  console.log(
    `\n  Phone (receiver, camera):  ${match[0]}` +
      `\n  Laptop (transmitter):      http://localhost:${port}` +
      `\n\n  The phone URL is public and changes every run. Ctrl-C stops both.\n`,
  );
};

tunnel.stdout.on("data", watch);
tunnel.stderr.on("data", watch);
