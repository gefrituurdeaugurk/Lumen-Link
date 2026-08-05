/**
 * One command for phone testing: build, serve just the bundle, open a
 * Cloudflare tunnel, and print the URL to type into the phone.
 *
 * The tunnel is not a convenience. iOS Safari refuses getUserMedia on a
 * self-signed certificate no matter how the warning is dismissed, so a
 * genuinely trusted certificate is the only way to reach the camera from a
 * device that is not the one running the server.
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

function listenersOn(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing is listening
  }
}

/**
 * Reclaim the port from a previous run. A leftover http-server survives its
 * terminal being closed, which is the usual reason this fails. Anything that
 * is not a node process is somebody else's, so report it and stop.
 */
async function freePort(port) {
  for (const pid of listenersOn(port)) {
    let command = "";
    try {
      command = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
    } catch {
      continue;
    }

    if (!/\bnode\b|http-server/.test(command)) {
      console.error(
        `\nPort ${port} is held by pid ${pid}, which is not a dev server:\n  ${command}\n` +
          `Stop it yourself, or pick another port: PORT=8081 npm run phone\n`,
      );
      process.exit(1);
    }

    process.kill(Number(pid), "SIGTERM");
    console.log(`port ${port} was in use — stopped pid ${pid}`);
  }

  for (let i = 0; i < 20 && listenersOn(port).length; i++) await sleep(100);
  if (listenersOn(port).length) {
    console.error(`\nPort ${port} did not free up. Try: PORT=8081 npm run phone\n`);
    process.exit(1);
  }
}

/**
 * An abandoned quick tunnel keeps routing its public URL to this port, so one
 * left over from a previous run would silently front the new server.
 */
function killStaleTunnels(port) {
  let pids = [];
  try {
    pids = execFileSync("pgrep", ["-f", `cloudflared.*--url http://localhost:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return;
  }

  for (const pid of pids) {
    process.kill(Number(pid), "SIGTERM");
    console.log(`stopped a leftover tunnel (pid ${pid}) still pointing at port ${port}`);
  }
}

await freePort(port);
killStaleTunnels(port);

await new Promise((resolve, reject) => {
  const build = run("node", ["build.mjs"], { stdio: "inherit" });
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));
});

// Serve a directory holding only the bundle: the tunnel is public, and the
// repo root would put source, .git and anything else alongside it.
await mkdir(join(root, "dist"), { recursive: true });
await copyFile(join(root, "index.html"), join(root, "dist/index.html"));

// The local binary, not npx: npx wraps the server in an extra process, so the
// child we track is not the one holding the port and neither kills nor exit
// detection reaches it.
const server = run(join(root, "node_modules/.bin/http-server"), [
  "dist",
  "-p",
  port,
  "-c-1",
  "--silent",
]);
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
