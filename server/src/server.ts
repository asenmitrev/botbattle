import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Replay } from "@arena/engine";
import { IsolatedBot } from "@arena/sandbox";
import { ECON, EconomyError } from "./economy.js";
import { Ladder, MAX_CODE_BYTES, NAME_RE, OWNER_RE, SubmitError } from "./ladder.js";
import { MatchPool, playMatch, type MatchRunner } from "./match-runner.js";
import { Scheduler, type SchedulerOptions } from "./scheduler.js";
import { createPlayoff, runPlayoff, savePlayoff, PLAYOFF_FILE, type Playoff } from "./playoff.js";
import { Seasons, startNewSeason } from "./seasons.js";
import { JsonFileStore, type LadderStore } from "./store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HOUSE_BOTS = ["idle", "greedy", "rusher", "balanced", "aggressor", "starter"] as const;

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  store?: LadderStore;
  /** House bot names (files in bots/). Default: all of HOUSE_BOTS. */
  houseBots?: readonly string[];
  scheduler?: SchedulerOptions;
  /** Serve viewer/dist (building it if missing). Default true. */
  serveViewer?: boolean;
  /** Submissions allowed per IP per window. */
  rateLimit?: { max: number; windowMs: number };
  /** Behind a reverse proxy (Cloudflare → nginx): take the client IP from CF-Connecting-IP / X-Real-IP. */
  trustProxy?: boolean;
  /** Password for admin actions (ending the season). Default: $ARENA_ADMIN_PASSWORD, else "djbobo". */
  adminPassword?: string;
  log?: (msg: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  /** The live ladder and its scheduler. Both are replaced when a season ends, so read them fresh. */
  readonly ladder: Ladder;
  readonly scheduler: Scheduler;
  /** The season-ending run in progress (playoff, then archive), if any. */
  readonly seasonEnd: Promise<void> | null;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function ensureViewerBuilt(log: (m: string) => void = console.log): string {
  const viewer = path.join(REPO, "viewer");
  const dist = path.join(viewer, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    log("Building the viewer (one time)…");
    const r = spawnSync("npx", ["vite", "build"], { cwd: viewer, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error("viewer build failed");
  }
  return dist;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dataDir = path.resolve(opts.dataDir ?? "data");
  // `let`: ending a season swaps in a fresh store, ladder and scheduler.
  let store = opts.store ?? new JsonFileStore(dataDir);
  let ladder = new Ladder(store);
  // Parallel ladders play on worker threads, so the engine work spreads over cores and the API stays responsive.
  const concurrency = Math.max(1, Math.floor(opts.scheduler?.concurrency ?? 1));
  const pool = concurrency > 1 ? new MatchPool(concurrency) : null;
  if (pool) ladder.runner = pool.run;
  /** Test games jump the pool's queue: a browser is waiting on the answer. */
  const testRunner: MatchRunner = pool ? pool.runFirst : playMatch;
  /** Wallets with a test game in flight (one at a time each). */
  const testing = new Set<string>();
  const registerHouseBots = () => {
    for (const name of opts.houseBots ?? HOUSE_BOTS) ladder.registerHouseBot(name, path.join(REPO, "bots", `${name}.js`));
  };
  registerHouseBots();
  const opened = ladder.openLegacyWallets();
  if (opened) log(`botcoin: opened ${opened} wallet(s) for existing owners`);
  const makeScheduler = () =>
    new Scheduler(ladder, {
      ...opts.scheduler,
      onError: opts.scheduler?.onError ?? ((e, job) => log(`match ${job.p1} vs ${job.p2} failed: ${e instanceof Error ? e.message : String(e)}`)),
    });
  let scheduler = makeScheduler();
  const adminHash = createHash("sha256").update(opts.adminPassword ?? process.env.ARENA_ADMIN_PASSWORD ?? "djbobo").digest();
  const adminOk = (pw: string) => timingSafeEqual(createHash("sha256").update(pw).digest(), adminHash);
  /** The playoff being played right now, or one that just failed. Otherwise GET /api/playoff reads the last archived one. */
  let playoff: Playoff | null = null;
  let seasonEnd: Promise<void> | null = null;
  const dist = opts.serveViewer === false ? null : ensureViewerBuilt(log);
  const realDist = dist ? fs.realpathSync(dist) : "";
  const limit = opts.rateLimit ?? { max: 10, windowMs: 10 * 60 * 1000 };
  const submissions = new Map<string, number[]>();
  // Past seasons are the `<data>-backup-*` folders next to the data dir (absent with a custom store).
  const seasons = opts.store && !opts.dataDir ? null : new Seasons(opts.dataDir ?? "data");

  /** Read-only mirror of the live ladder routes for an archived season. */
  function seasonRoute(res: http.ServerResponse, url: URL, id: string, rest: string): void {
    const s = seasons?.get(id);
    if (!s) return json(res, 404, { error: "no such season" });
    if (rest === "leaderboard") return json(res, 200, s.ladder.leaderboard());
    if (rest === "highscore") return json(res, 200, s.ladder.topScore());
    if (rest === "playoff") return json(res, 200, seasons!.playoff(id));
    let m = /^bots\/([A-Za-z0-9_-]+)\/matches$/.exec(rest);
    if (m) {
      if (!s.ladder.bot(m[1]!)) return json(res, 404, { error: "no such bot" });
      const lim = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 20));
      return json(res, 200, s.ladder.recentMatches(m[1]!, lim));
    }
    m = /^matches\/([A-Za-z0-9_-]+)\/replay$/.exec(rest);
    if (m) {
      const replay = s.store.loadReplay(m[1]!);
      return replay ? json(res, 200, replay) : json(res, 404, { error: "replays aren't kept for past seasons" });
    }
    return json(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      if (req.method === "GET" && p === "/api/health") {
        return json(res, 200, {
          ok: true,
          queue: scheduler.queue.length,
          busy: scheduler.busy,
          boostQueue: scheduler.queue.filter((j) => j.boostFor).length,
          playoff: !!seasonEnd,
        });
      }
      if (req.method === "GET" && p === "/api/playoff") return json(res, 200, playoff ?? seasons?.latestPlayoff() ?? null);
      if (req.method === "POST" && p === "/api/admin/end-season") return endSeasonRoute(req, res);
      // While a season is ending, nothing may change the ladder that is about to be archived.
      if (seasonEnd && req.method !== "GET" && req.method !== "HEAD" && !["/api/wallet", "/api/mine"].includes(p)) {
        return json(res, 503, { error: "the season is ending: the playoff is being played. Try again once the new season starts." });
      }
      if (req.method === "GET" && p === "/api/leaderboard") {
        const boosts = scheduler.boostCounts();
        return json(res, 200, ladder.leaderboard().map((r) => ({ ...r, boosted: boosts.get(r.id) ?? 0 })));
      }
      if (req.method === "POST" && p === "/api/wallet") return econ(req, res, (b) => ladder.walletView(str(b.owner)));
      if (req.method === "POST" && p === "/api/wallet/stipend") return econ(req, res, (b) => ladder.claimStipend(str(b.owner)));
      if (req.method === "GET" && p === "/api/bets") {
        return json(res, 200, ladder.recentBets(Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50))));
      }
      if (req.method === "GET" && p === "/api/highscore") return json(res, 200, ladder.topScore());
      if (req.method === "POST" && p === "/api/bots") return submit(req, res);
      if (req.method === "POST" && p === "/api/mine") return mine(req, res);
      if (req.method === "POST" && p === "/api/test-game") return testGame(req, res);
      let m = /^\/api\/bots\/([A-Za-z0-9_-]+)\/matches$/.exec(p);
      if (req.method === "GET" && m) {
        if (!ladder.bot(m[1]!)) return json(res, 404, { error: "no such bot" });
        const lim = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 20));
        return json(res, 200, ladder.recentMatches(m[1]!, lim));
      }
      m = /^\/api\/bots\/([A-Za-z0-9_-]+)$/.exec(p);
      if (req.method === "DELETE" && m) return removeBot(req, res, m[1]!);
      m = /^\/api\/bots\/([A-Za-z0-9_-]+)\/(boost|bet)$/.exec(p);
      if (req.method === "POST" && m) {
        const [, id, what] = m;
        return econ(req, res, (b) => {
          const cred = { token: optStr(b.token), owner: optStr(b.owner) };
          if (what === "bet") return ladder.placeBet(id!, cred, Number(b.stake), Number(b.games));
          const pairs = Number(b.pairs);
          if (!Number.isInteger(pairs) || pairs < 1) throw new EconomyError(400, "pairs must be a whole number of at least 1");
          const queued = scheduler.boostQueued(id!);
          if (queued + pairs > ECON.maxBoostPairsQueued) {
            throw new EconomyError(409, `at most ${ECON.maxBoostPairsQueued} boost pairs can be queued per bot (${queued} queued)`);
          }
          const r = ladder.chargeBoost(id!, cred, pairs);
          const games = scheduler.enqueueBoost(r.bot.id, pairs);
          log(`boost ${r.bot.name} ×${pairs}`);
          return { balance: r.balance, queuedGames: games, boosted: scheduler.boostQueued(r.bot.id) };
        });
      }
      m = /^\/api\/matches\/([A-Za-z0-9_-]+)\/replay$/.exec(p);
      if (req.method === "GET" && m) {
        const replay = store.loadReplay(m[1]!);
        return replay ? json(res, 200, replay) : json(res, 404, { error: "no such replay" });
      }
      if (req.method === "GET" && p === "/api/seasons") return json(res, 200, seasons?.list() ?? []);
      m = /^\/api\/seasons\/([0-9-]+)\/(.+)$/.exec(p);
      if (req.method === "GET" && m) return seasonRoute(res, url, m[1]!, m[2]!);
      return json(res, 404, { error: "not found" });
    }
    if (!dist || (req.method !== "GET" && req.method !== "HEAD")) return void res.writeHead(404).end("not found");
    const rel = decodeURIComponent(p === "/" ? "/index.html" : p);
    const abs = path.resolve(dist, "." + rel);
    if (!abs.startsWith(dist + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return void res.writeHead(404).end("not found");
    // Never follow a symlink out of dist/ (old builds linked dist/ladder-bots → data/bots).
    if (!fs.realpathSync(abs).startsWith(realDist + path.sep)) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  }

  /**
   * POST /api/admin/end-season {password, minElo?}: stop the ladder, play the playoff between the top
   * bots, archive the season (with the playoff) and start a new one. Answers 202 at once; follow along
   * with GET /api/playoff.
   */
  async function endSeasonRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { password?: unknown; minElo?: unknown };
    try {
      body = JSON.parse(await readBody(req, 4 * 1024)) as typeof body;
    } catch {
      return json(res, 400, { error: "body must be JSON {password, minElo?}" });
    }
    if (!adminOk(str(body.password))) {
      await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
      return json(res, 403, { error: "wrong password" });
    }
    if (!seasons) return json(res, 400, { error: "seasons need a data dir" });
    if (seasonEnd) return json(res, 409, { error: "the season is already ending" });
    const minElo = body.minElo === undefined || body.minElo === null || body.minElo === "" ? undefined : Number(body.minElo);
    if (minElo !== undefined && !Number.isFinite(minElo)) return json(res, 400, { error: "minElo must be a number" });
    seasonEnd = endSeason(minElo).finally(() => (seasonEnd = null));
    return json(res, 202, { started: true, playoff });
  }

  /** Stop the ladder, play the playoff, archive the season and swap in the fresh ladder. Never throws. */
  async function endSeason(minElo: number | undefined): Promise<void> {
    log("ending the season: stopping the ladder");
    // Show the bracket right away; it is seeded again from the final standings once the games in flight finish.
    playoff = createPlayoff(ladder);
    await scheduler.stop();
    const p = createPlayoff(ladder);
    playoff = p;
    try {
      if (p) {
        log(`playoff: ${p.entrants.map((e) => `${e.seed}. ${e.name}`).join(", ")}`);
        await runPlayoff(p, ladder);
        log(`playoff champion: ${p.champion?.name ?? "none"}`);
        savePlayoff(dataDir, p); // moves into the archive with the rest of the data dir
      }
      const r = startNewSeason(dataDir, new Date(), { minElo });
      if (p) p.seasonId = r.id;
      log(`season archived as ${r.archive}; ${r.bots} bots carried over`);
      if (r.dropped.length) log(`left behind (below ${r.minElo} Elo): ${r.dropped.map((d) => `${d.name} (${d.elo})`).join(", ")}`);
      store = new JsonFileStore(dataDir);
      ladder = new Ladder(store);
      if (pool) ladder.runner = pool.run;
      registerHouseBots();
      scheduler = makeScheduler();
      playoff = null; // the archive serves it from now on
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ending the season failed: ${msg}`);
      if (p) {
        p.status = "failed";
        p.error = msg;
        p.finishedAt = new Date().toISOString();
      }
      fs.rmSync(path.join(dataDir, PLAYOFF_FILE), { force: true });
    } finally {
      scheduler.start();
    }
  }

  /** DELETE /api/bots/:id {token}: the owner removes a user bot. History and replays are kept. */
  async function removeBot(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    let token: string | undefined;
    let owner: string | undefined;
    try {
      const raw = await readBody(req, 4 * 1024);
      const body = raw.trim() ? (JSON.parse(raw) as { token?: unknown; owner?: unknown }) : {};
      token = typeof body.token === "string" ? body.token : undefined;
      owner = typeof body.owner === "string" ? body.owner : undefined;
    } catch {
      return json(res, 400, { error: "body must be JSON {token?, owner?}" });
    }
    try {
      const b = ladder.deleteBot(id, { token, owner });
      scheduler.dropBot(b.id);
      log(`deleted ${b.name} (${b.id})`);
      return json(res, 200, { deleted: b.id });
    } catch (e) {
      if (e instanceof SubmitError) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  /** POST JSON body → `fn(body)` → 200 JSON. Ladder/economy errors map to their HTTP status. */
  async function econ(req: http.IncomingMessage, res: http.ServerResponse, fn: (body: Record<string, unknown>) => unknown): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req, 4 * 1024);
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (!body || typeof body !== "object") throw new Error("not an object");
    } catch {
      return json(res, 400, { error: "body must be a JSON object" });
    }
    try {
      return json(res, 200, fn(body));
    } catch (e) {
      if (e instanceof SubmitError || e instanceof EconomyError) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  /** POST /api/mine {owner, claims?: [{id, token}]}: ids of the bots this browser owns (claims link token-only bots to it). */
  async function mine(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { owner?: unknown; claims?: unknown };
    try {
      body = JSON.parse(await readBody(req, 64 * 1024));
    } catch {
      return json(res, 400, { error: "body must be JSON {owner, claims?}" });
    }
    if (typeof body.owner !== "string" || !OWNER_RE.test(body.owner)) return json(res, 400, { error: "owner must be 32-128 hex characters" });
    const claims = (Array.isArray(body.claims) ? body.claims : [])
      .slice(0, 100)
      .filter((c): c is { id: string; token: string } => !!c && typeof c.id === "string" && typeof c.token === "string");
    return json(res, 200, { ids: ladder.mine(body.owner, claims) });
  }

  /**
   * POST /api/test-game {owner, code, opponent, seed, side}: play the caller's (unsubmitted) code against a
   * ladder bot on the server, so the opponent's code never reaches the browser. Unrated, not recorded, costs
   * ECON.testGameCost (free against house bots and your own). Broken code isn't charged; a server failure is
   * refunded. Responds {replay, cost, balance}.
   */
  async function testGame(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { owner?: unknown; code?: unknown; opponent?: unknown; seed?: unknown; side?: unknown };
    try {
      body = JSON.parse(await readBody(req, MAX_CODE_BYTES + 16 * 1024));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error && e.message === "too large" ? "request too large" : "body must be JSON {owner, code, opponent, seed, side}" });
    }
    const owner = str(body.owner);
    const code = str(body.code);
    const seed = Number(body.seed);
    const side = Number(body.side);
    if (!OWNER_RE.test(owner)) return json(res, 400, { error: "owner must be 32-128 hex characters" });
    if (!code.trim()) return json(res, 400, { error: "code is empty" });
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) return json(res, 400, { error: `code exceeds ${MAX_CODE_BYTES} bytes` });
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return json(res, 400, { error: "seed must be a whole number from 0 to 4294967295" });
    if (side !== 1 && side !== 2) return json(res, 400, { error: "side must be 1 or 2" });
    const opp = ladder.bot(str(body.opponent));
    if (!opp) return json(res, 404, { error: "no such bot" });
    const key = owner;
    if (testing.has(key)) return json(res, 429, { error: "a test game is already running for this wallet" });
    testing.add(key);
    try {
      const probe = await IsolatedBot.create({ source: code, name: "my-bot" });
      const initError = probe.initError;
      probe.dispose();
      if (initError) return json(res, 400, { error: initError, initError: true });
      let charge: ReturnType<Ladder["chargeTestGame"]>;
      try {
        charge = ladder.chargeTestGame(owner, opp.id);
      } catch (e) {
        if (e instanceof SubmitError || e instanceof EconomyError) return json(res, e.status, { error: e.message });
        throw e;
      }
      const mine = { src: { source: code, name: "my-bot" }, rngSeed: (seed * 2 + side) >>> 0 };
      const theirs = { src: charge.src, rngSeed: (seed * 2 + (3 - side)) >>> 0 };
      let replay: Replay;
      try {
        ({ replay } = await testRunner({ seed, bots: side === 1 ? [mine, theirs] : [theirs, mine] }));
      } catch (e) {
        ladder.refundTestGame(charge.wallet, charge.cost, opp.name);
        log(`test game vs ${opp.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        return json(res, 500, { error: "the server couldn't play this game; you weren't charged" });
      }
      replay.bots = side === 1 ? ["my-bot", opp.name] : [opp.name, "my-bot"];
      if (!charge.free) redactOpponent(replay, side === 1 ? 2 : 1);
      return json(res, 200, { replay, cost: charge.cost, balance: ladder.economy.wallet(charge.wallet)!.balance });
    } finally {
      testing.delete(key);
    }
  }

  async function submit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const fwd = opts.trustProxy ? req.headers["cf-connecting-ip"] ?? req.headers["x-real-ip"] : undefined;
    const ip = (typeof fwd === "string" && fwd.trim()) || req.socket.remoteAddress || "?";
    const now = Date.now();
    const recent = (submissions.get(ip) ?? []).filter((t) => now - t < limit.windowMs);
    if (recent.length >= limit.max) return json(res, 429, { error: `rate limit: ${limit.max} submissions per ${Math.round(limit.windowMs / 60000)} min` });
    let body: { name?: unknown; code?: unknown; token?: unknown; owner?: unknown };
    try {
      body = JSON.parse(await readBody(req, MAX_CODE_BYTES + 16 * 1024));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error && e.message === "too large" ? "request too large" : "body must be JSON {name, code, token?}" });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const code = typeof body.code === "string" ? body.code : "";
    const token = typeof body.token === "string" ? body.token : undefined;
    const owner = typeof body.owner === "string" ? body.owner : undefined;
    if (owner !== undefined && !OWNER_RE.test(owner)) return json(res, 400, { error: "owner must be 32-128 hex characters" });
    if (!NAME_RE.test(name)) return json(res, 400, { error: "name must be 2-24 characters: letters, digits, _ or -" });
    if (!code.trim()) return json(res, 400, { error: "code is empty" });
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) return json(res, 400, { error: `code exceeds ${MAX_CODE_BYTES} bytes` });
    recent.push(now);
    submissions.set(ip, recent);
    // Check ownership before spending sandbox time on validation.
    const existing = ladder.byName(name);
    if (existing?.house) return json(res, 403, { error: `"${existing.name}" is a house bot name` });
    if (existing && !ladder.owns(existing, { token, owner })) return json(res, 403, { error: `"${existing.name}" is taken; updating it requires its token` });
    if (!existing && !owner) return json(res, 400, { error: "a new bot needs an owner key (the browser's botcoin wallet)" });
    const quote = ladder.quoteSubmit(name, owner);
    if (quote.cost > quote.balance) {
      return json(res, 402, { error: `not enough botcoin: ${existing ? "another version today" : "a new bot"} costs ${quote.cost}, you have ${quote.balance}`, cost: quote.cost, balance: quote.balance });
    }
    const probe = await IsolatedBot.create({ source: code, name });
    const initError = probe.initError;
    probe.dispose();
    if (initError) return json(res, 400, { error: initError });
    try {
      const r = ladder.submit(name, code, { token, owner });
      const placementGames = scheduler.enqueuePlacement(r.bot.id);
      log(`${r.created ? "new bot" : "updated"} ${r.bot.name} v${r.bot.version} (${r.bot.id})`);
      return json(res, r.created ? 201 : 200, {
        id: r.bot.id,
        name: r.bot.name,
        version: r.bot.version,
        ...(r.token ? { token: r.token } : {}),
        placementGames,
        cost: r.cost,
        balance: r.balance,
      });
    } catch (e) {
      if (e instanceof SubmitError) return json(res, e.status, { error: e.message });
      throw e;
    }
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address() as { port: number; address: string };
  scheduler.start();
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${addr.port}`,
    port: addr.port,
    get ladder() {
      return ladder;
    },
    get scheduler() {
      return scheduler;
    },
    get seasonEnd() {
      return seasonEnd;
    },
    async close() {
      await seasonEnd;
      await scheduler.stop();
      await pool?.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
    },
  };
}

/** Opponent error messages can quote its source (stack traces): keep that it failed, drop the text. */
function redactOpponent(replay: Replay, player: 1 | 2): void {
  for (const t of replay.ticks) {
    for (const e of t.runnerEvents ?? []) if (e.type === "bot_error" && e.player === player) e.message = "(opponent error hidden)";
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
