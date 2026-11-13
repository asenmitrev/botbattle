import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMatch, verifyReplay, type MatchResult } from "@arena/engine";
import { IsolatedBot } from "@arena/sandbox";
import type { BotController } from "@arena/engine";
import { loadLocalBot } from "./local-bot.js";

/** Official mode: every bot runs in its own isolated-vm sandbox. `--unsafe` runs bots in-process (debugging only). */
async function loadBot(file: string, tag: string, seed: number, player: 1 | 2, unsafe: boolean): Promise<BotController> {
  if (unsafe) return loadLocalBot(file, tag);
  const bot = await IsolatedBot.create({ file }, { seed: (seed * 2 + player) >>> 0 });
  if (bot.initError) console.error(`warning: ${bot.name}: ${bot.initError}`);
  return bot;
}

const USAGE = `Usage:
  arena run <botA.js> <botB.js> [--seed N] [--out replay.json] [--quiet] [--unsafe]
  arena tournament <bots...> [--rounds N] [--seed N] [--unsafe]

  Bots run sandboxed (isolated-vm) by default; --unsafe runs them in-process (trusted code only, faster).
  arena verify <replay.json>
  arena view <replay.json> [--port N] [--no-open]   open a replay in the web viewer
  arena playground [--port N] [--no-open]          open the browser playground (editor + viewer)
  arena server [--port 8787] [--data ./data] [--host 127.0.0.1] [--no-autoplay] [--concurrency 8] [--trust-proxy] [--house-bots none|a,b]
  arena new-season [--data ./data] [--min-elo N]  archive the ladder as a past season and restart it (server stopped)
                                                   ranked ladder: playground + Elo leaderboard + API`;

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function intFlag(flags: Args["flags"], key: string, def: number): number {
  const v = flags[key];
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${key} must be an integer`);
  return n;
}

function describe(result: MatchResult, names: [string, string]): string {
  const w = result.winner === "draw" ? "draw" : `${names[result.winner - 1]} (P${result.winner}) wins`;
  return `${w} by ${result.reason} at tick ${result.tick} — ${result.units ? `units ${result.units[0]} : ${result.units[1]}, ` : ""}score ${result.scores[0]} : ${result.scores[1]}`;
}

async function cmdRun(args: Args): Promise<void> {
  const [a, b] = args.positional;
  if (!a || !b) throw new Error(USAGE);
  const seed = intFlag(args.flags, "seed", 1);
  const unsafe = args.flags.unsafe === true;
  const bots = [await loadBot(a, "p1", seed, 1, unsafe), await loadBot(b, "p2", seed, 2, unsafe)] as const;
  const t0 = performance.now();
  const { state, replay } = await runMatch([bots[0], bots[1]], { seed });
  for (const b of bots) await b.dispose?.();
  const ms = performance.now() - t0;
  const out = typeof args.flags.out === "string" ? args.flags.out : null;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(replay));
  }
  if (!args.flags.quiet) {
    const errors = replay.ticks.flatMap((t) => t.runnerEvents ?? []);
    const invalid = replay.ticks.flatMap((t) => t.events).filter((e) => e.type === "invalid_action");
    console.log(`seed ${seed}: ${bots[0].name} vs ${bots[1].name}`);
    console.log(describe(state.result!, [bots[0].name, bots[1].name]));
    console.log(
      `units ${state.units.filter((u) => u.owner === 1).length} : ${state.units.filter((u) => u.owner === 2).length}, ` +
        `invalid actions ${invalid.filter((e) => e.type === "invalid_action" && e.player === 1).length} : ${invalid.filter((e) => e.type === "invalid_action" && e.player === 2).length}, ` +
        `bot errors ${errors.length}, ${ms.toFixed(0)} ms${unsafe ? " (UNSAFE in-process)" : " (sandboxed)"}`,
    );
    for (const e of errors.slice(0, 5)) if (e.type === "bot_error") console.log(`  P${e.player} error: ${e.message}`);
    if (out) console.log(`replay written to ${out} (hash ${replay.finalStateHash})`);
  }
}

async function cmdTournament(args: Args): Promise<void> {
  const files = args.positional;
  if (files.length < 2) throw new Error(USAGE);
  const rounds = intFlag(args.flags, "rounds", 20);
  const baseSeed = intFlag(args.flags, "seed", 1000);
  const names = files.map((f) => path.basename(f).replace(/\.[cm]?js$/, ""));
  const n = files.length;
  // wins[i][j] = games bot i won against bot j
  const wins = names.map(() => names.map(() => 0));
  const draws = names.map(() => names.map(() => 0));
  const reasons: Record<string, number> = {};
  const t0 = performance.now();
  let games = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let r = 0; r < rounds; r++) {
        // Alternate sides; each pair of rounds shares a seed so the map is identical.
        const seed = baseSeed + Math.floor(r / 2);
        const swap = r % 2 === 1;
        const [pi, pj] = swap ? [j, i] : [i, j];
        const unsafe = args.flags.unsafe === true;
        const bots = [
          await loadBot(files[pi]!, `t${games}a`, seed, 1, unsafe),
          await loadBot(files[pj]!, `t${games}b`, seed, 2, unsafe),
        ] as const;
        const { state } = await runMatch([bots[0], bots[1]], { seed });
        for (const b of bots) await b.dispose?.();
        const res = state.result!;
        reasons[res.reason] = (reasons[res.reason] ?? 0) + 1;
        if (res.winner === "draw") {
          draws[i]![j]!++;
          draws[j]![i]!++;
        } else {
          const w = res.winner === 1 ? pi : pj;
          const l = w === pi ? pj : pi;
          wins[w]![l]!++;
        }
        games++;
      }
    }
  }
  const ms = performance.now() - t0;
  const width = Math.max(8, ...names.map((s) => s.length)) + 2;
  const pad = (s: string) => s.padEnd(width);
  console.log(`\n${games} games, ${rounds} per pairing, ${(ms / games).toFixed(0)} ms/game. Cells: W-L-D of row vs column.\n`);
  console.log(pad("") + names.map(pad).join("") + "total W-L-D   win%");
  for (let i = 0; i < n; i++) {
    let W = 0;
    let L = 0;
    let D = 0;
    const cells = names.map((_, j) => {
      if (i === j) return pad("—");
      W += wins[i]![j]!;
      L += wins[j]![i]!;
      D += draws[i]![j]!;
      return pad(`${wins[i]![j]}-${wins[j]![i]}-${draws[i]![j]}`);
    });
    const pct = ((100 * (W + D / 2)) / Math.max(1, W + L + D)).toFixed(1);
    console.log(pad(names[i]!) + cells.join("") + `${W}-${L}-${D}`.padEnd(14) + pct);
  }
  console.log(`\nend reasons: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

function cmdVerify(args: Args): void {
  const file = args.positional[0];
  if (!file) throw new Error(USAGE);
  const replay = JSON.parse(fs.readFileSync(file, "utf8"));
  const res = verifyReplay(replay);
  console.log(res.ok ? `OK: re-simulation matches (${res.actual})` : `MISMATCH: expected ${res.expected}, got ${res.actual}`);
  if (!res.ok) process.exitCode = 1;
}

const VIEWER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../viewer");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function cmdView(args: Args): Promise<void> {
  const file = args.positional[0];
  if (file && !fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const dist = path.join(VIEWER_DIR, "dist");
  if (!fs.existsSync(path.join(dist, "index.html")) || args.flags.rebuild) {
    console.log("Building the viewer (one time)…");
    const r = spawnSync("npx", ["vite", "build"], { cwd: VIEWER_DIR, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error("viewer build failed");
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/replay.json" && file) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const abs = path.resolve(dist, "." + rel);
    if (!abs.startsWith(dist + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  });
  const port = intFlag(args.flags, "port", 0);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const target = `http://127.0.0.1:${addr.port}/${file ? "?replay=/replay.json" : ""}`;
  console.log(`Viewer running at ${target}  (Ctrl+C to stop)`);
  if (!args.flags["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [target], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
  }
  await new Promise(() => {}); // serve until interrupted
}

async function cmdServer(args: Args): Promise<void> {
  const { startServer } = await import("@arena/server");
  const srv = await startServer({
    port: intFlag(args.flags, "port", 8787),
    host: typeof args.flags.host === "string" ? args.flags.host : "127.0.0.1",
    dataDir: typeof args.flags.data === "string" ? args.flags.data : "data",
    trustProxy: args.flags["trust-proxy"] === true,
    ...(typeof args.flags["house-bots"] === "string"
      ? { houseBots: args.flags["house-bots"] === "none" ? [] : args.flags["house-bots"].split(",").map((s) => s.trim()).filter(Boolean) }
      : {}),
    scheduler: { autoplay: !args.flags["no-autoplay"], concurrency: intFlag(args.flags, "concurrency", 8), onMatch: (id) => console.log(`played ${id}`) },
  });
  console.log(`Ladder server at ${srv.url}  (data: ${typeof args.flags.data === "string" ? args.flags.data : "data"}; Ctrl+C to stop)`);
  const shutdown = async () => {
    console.log("stopping…");
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
}

/** Archive the data dir as a past season and start a fresh ladder with the same bots. Stop the server first. */
async function cmdNewSeason(args: Args): Promise<void> {
  const { startNewSeason } = await import("@arena/server");
  const dir = typeof args.flags.data === "string" ? args.flags.data : "data";
  const minElo = typeof args.flags["min-elo"] === "string" ? Number(args.flags["min-elo"]) : undefined;
  if (minElo !== undefined && !Number.isFinite(minElo)) throw new Error("--min-elo must be a number");
  const r = startNewSeason(dir, new Date(), { minElo });
  console.log(`New season: archived ${dir} as ${r.archive}; ${r.bots} bots carried over at 1200 Elo; ${r.refundedBets} open bet(s) refunded.`);
  if (r.dropped.length) console.log(`Left behind (below ${minElo} Elo): ${r.dropped.map((d) => `${d.name} (${d.elo})`).join(", ")}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "run":
      return cmdRun(args);
    case "tournament":
      return cmdTournament(args);
    case "verify":
      return cmdVerify(args);
    case "view":
      return cmdView(args);
    case "server":
      return cmdServer(args);
    case "new-season":
      return cmdNewSeason(args);
    case "playground":
      return cmdView({ positional: [], flags: args.flags });
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
