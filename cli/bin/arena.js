#!/usr/bin/env node
// isolated-vm needs --no-node-snapshot on Node >= 20: re-exec with it if missing.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.execArgv.includes("--no-node-snapshot")) {
  const r = spawnSync(process.execPath, ["--no-node-snapshot", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const { register } = await import("tsx/esm/api");
register();
await import("../src/index.ts");
