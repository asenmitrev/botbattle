import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyReplay } from "@arena/engine";
import { MatchPool, playMatch, startServer, type MatchSpec, type RunningServer } from "../src/index.js";

const STARTER = fs.readFileSync(path.resolve(__dirname, "../../bots/starter.js"), "utf8");
let srv: RunningServer;
/** Browser owner key (botcoin wallet) used for new bots. */
const OWNER = "c".repeat(64);
let dir: string;

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(srv.url + p, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-api-"));
  srv = await startServer({
    port: 0,
    dataDir: dir,
    houseBots: ["idle", "greedy", "starter"],
    serveViewer: false,
    scheduler: { autoplay: false, idleDelayMs: 0 },
    rateLimit: { max: 100, windowMs: 60_000 },
    log: () => {},
  });
});
afterAll(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ladder API", () => {
  it("health + initial leaderboard has the house bots at 1200", async () => {
    expect((await api("GET", "/api/health")).body.ok).toBe(true);
    const lb = (await api("GET", "/api/leaderboard")).body;
    expect(lb.map((r: any) => r.name).sort()).toEqual(["greedy", "idle", "starter"]);
    expect(lb.every((r: any) => r.elo === 1200 && r.house && r.games === 0)).toBe(true);
  });

  let token = "";
  let id = "";
  it("submitting a valid bot creates it and runs placement games against every other bot", async () => {
    const r = await api("POST", "/api/bots", { name: "my-bot", code: STARTER, owner: OWNER });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.placementGames).toBe(6); // 3 house bots, both sides
    token = r.body.token;
    id = r.body.id;
    await srv.scheduler.whenIdle();
    const lb = (await api("GET", "/api/leaderboard")).body;
    const me = lb.find((x: any) => x.id === id);
    expect(me.games).toBe(6);
    expect(me.wins + me.losses + me.draws).toBe(6);
    expect(lb.filter((x: any) => x.id !== id).every((x: any) => x.games === 2)).toBe(true);
    expect(me.highScore).toBeGreaterThan(0);
    expect(me.provisional).toBe(true);
    expect(me.house).toBe(false);
    expect(lb.map((x: any) => x.elo)).toEqual([...lb.map((x: any) => x.elo)].sort((a: number, b: number) => b - a));
    expect(lb.map((x: any) => x.rank)).toEqual(lb.map((_: any, i: number) => i + 1));
    expect(lb.some((x: any) => x.elo !== 1200)).toBe(true);
    const top = (await api("GET", "/api/highscore")).body;
    expect(top.score).toBe(Math.max(...lb.map((x: any) => x.highScore ?? 0)));
    // The token is never exposed or stored in plaintext.
    expect(JSON.stringify(lb)).not.toContain(token);
    expect(fs.readFileSync(path.join(dir, "ladder.json"), "utf8")).not.toContain(token);
  });

  it("recent matches and replays: the replay re-simulates to its recorded final state", async () => {
    const ms = (await api("GET", `/api/bots/${id}/matches?limit=3`)).body;
    expect(ms).toHaveLength(3);
    const m = ms[0];
    expect([m.p1.id, m.p2.id]).toContain(id);
    expect(m.p1).toHaveProperty("eloBefore");
    expect(m.p1).toHaveProperty("eloAfter");
    const replay = (await api("GET", `/api/matches/${m.id}/replay`)).body;
    expect(replay.seed).toBe(m.seed);
    expect(verifyReplay(replay).ok).toBe(true);
    expect((await api("GET", "/api/matches/nope/replay")).status).toBe(404);
    expect((await api("GET", "/api/bots/nope/matches")).status).toBe(404);
  });

  it("updating a bot requires its token; with it, version bumps, rating kept, provisional again", async () => {
    const before = (await api("GET", "/api/leaderboard")).body.find((x: any) => x.id === id);
    expect((await api("POST", "/api/bots", { name: "my-bot", code: STARTER })).status).toBe(403);
    expect((await api("POST", "/api/bots", { name: "MY-BOT", code: STARTER, token: "0".repeat(64) })).status).toBe(403);
    const ok = await api("POST", "/api/bots", { name: "my-bot", code: STARTER + "\n// v2", token });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.token).toBeUndefined();
    const lb = (await api("GET", "/api/leaderboard")).body.find((x: any) => x.id === id);
    expect(lb.version).toBe(2);
    expect(lb.provisional).toBe(true);
    expect(lb.games).toBeGreaterThanOrEqual(before.games); // history and rating carried over
    await srv.scheduler.whenIdle();
    const after = (await api("GET", "/api/leaderboard")).body.find((x: any) => x.id === id);
    expect(after.games).toBe(before.games + 6);
  });

  it("rejects bad names, house names, empty / broken / hanging code", async () => {
    for (const name of ["a", "x".repeat(25), "bad name", "évil", "../x"]) {
      expect((await api("POST", "/api/bots", { name, code: STARTER })).status, name).toBe(400);
    }
    expect((await api("POST", "/api/bots", { name: "greedy", code: STARTER })).status).toBe(403);
    expect((await api("POST", "/api/bots", { name: "empty", code: "  " })).status).toBe(400);
    const syntax = await api("POST", "/api/bots", { name: "broken", owner: OWNER, code: "export function onTick( { return [ ; }" });
    expect(syntax.status).toBe(400);
    expect(syntax.body.error).toMatch(/SyntaxError/);
    const t0 = Date.now();
    const hang = await api("POST", "/api/bots", { name: "hang", owner: OWNER, code: "for(;;){} export function onTick(){return []}" });
    expect(hang.status).toBe(400);
    expect(hang.body.error).toMatch(/timeout/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const noTick = await api("POST", "/api/bots", { name: "notick", owner: OWNER, code: "export const x = 1;" });
    expect(noTick.status).toBe(400);
    const big = await api("POST", "/api/bots", { name: "big", owner: OWNER, code: "//" + "x".repeat(110 * 1024) });
    expect(big.status).toBe(400);
    const notJson = await fetch(srv.url + "/api/bots", { method: "POST", body: "nope" });
    expect(notJson.status).toBe(400);
    const lb = (await api("GET", "/api/leaderboard")).body;
    expect(lb.map((x: any) => x.name)).not.toContain("broken");
  });

  it("ratings and history survive a restart", async () => {
    const lb1 = (await api("GET", "/api/leaderboard")).body;
    await srv.close();
    srv = await startServer({
      port: 0, dataDir: dir, houseBots: ["idle", "greedy", "starter"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 }, log: () => {},
    });
    const lb2 = (await api("GET", "/api/leaderboard")).body;
    expect(lb2).toEqual(lb1);
  });
});

describe("rate limit", () => {
  it("limits submissions per IP", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-rl-"));
    const s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 }, rateLimit: { max: 2, windowMs: 60_000 }, log: () => {},
    });
    const post = (name: string) =>
      fetch(s.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, code: "x(" }) }).then((r) => r.status);
    expect(await post("aa")).toBe(400);
    expect(await post("bb")).toBe(400);
    expect(await post("cc")).toBe(429);
    await s.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("background matchmaking", () => {
  it("samples background pairs across the whole ladder when autoplay is on", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-bg-"));
    let played = 0;
    const s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle", "greedy", "starter"], serveViewer: false,
      scheduler: { autoplay: true, idleDelayMs: 0, onMatch: () => played++ }, log: () => {},
    });
    while (played < 24) await new Promise((r) => setTimeout(r, 50));
    await s.close();
    const lb = s.ladder.leaderboard();
    expect(lb.reduce((t, r) => t + r.games, 0)).toBeGreaterThanOrEqual(8);
    // Seeds are a persisted counter: every match has a distinct pair seed.
    const seeds = s.ladder.data.matches.map((m) => m.seed);
    expect(new Set(seeds).size).toBe(Math.ceil(seeds.length / 2));
    // Not locked onto one pairing: with 3 bots, all 3 pairings show up in 12 background pairs.
    const pairs = new Set(s.ladder.data.matches.map((m) => [m.p1.id, m.p2.id].sort().join("|")));
    expect(pairs.size).toBe(3);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("parallel matches", () => {
  it("plays several games at once and records every one", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-par-"));
    let peak = 0;
    const s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle", "greedy", "starter"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0, concurrency: 4 }, log: () => {},
    });
    const id = s.ladder.data.bots.find((b) => b.name === "starter")!.id;
    s.scheduler.enqueuePlacement(id); // 2 opponents x both sides = 4 games
    const probe = setInterval(() => (peak = Math.max(peak, s.scheduler.running)), 1);
    await s.scheduler.whenIdle();
    clearInterval(probe);
    await s.close();
    expect(peak).toBeGreaterThan(1);
    const ms = s.ladder.data.matches;
    expect(ms.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("match worker pool", () => {
  it("a match played on a worker thread is byte-identical to one played in-process", async () => {
    const bots = path.resolve(__dirname, "../../bots");
    const spec: MatchSpec = {
      seed: 11,
      bots: [
        { src: { file: path.join(bots, "balanced.js"), name: "balanced" }, rngSeed: 23 },
        { src: { source: fs.readFileSync(path.join(bots, "starter.js"), "utf8"), name: "starter" }, rngSeed: 24 },
      ],
    };
    const pool = new MatchPool(2);
    try {
      const [w, local] = await Promise.all([pool.run(spec), playMatch(spec)]);
      expect(JSON.stringify(w.replay)).toBe(JSON.stringify(local.replay));
      expect(w.result).toEqual(local.result);
    } finally {
      await pool.close();
    }
  });
});

describe("deleting a bot", () => {
  let s: RunningServer;
  let d: string;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(s.url + p, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  beforeAll(async () => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-del-"));
    s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle", "greedy"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 }, rateLimit: { max: 100, windowMs: 60_000 }, log: () => {},
    });
  });
  afterAll(async () => {
    await s.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("only the owner can delete; house bots never; the bot, its code and queued games go, history stays", async () => {
    const r = await call("POST", "/api/bots", { name: "doomed", code: STARTER, owner: OWNER });
    expect(r.status).toBe(201);
    const { id, token } = r.body;
    await s.scheduler.whenIdle();
    const codeFile = path.join(d, "bots", `${id}.js`);
    expect(fs.existsSync(codeFile)).toBe(true);
    const greedyId = (await call("GET", "/api/leaderboard")).body.find((x: any) => x.name === "greedy").id;
    const before = (await call("GET", `/api/bots/${greedyId}/matches?limit=200`)).body;
    expect(before.some((m: any) => m.p1.id === id || m.p2.id === id)).toBe(true);

    expect((await call("DELETE", "/api/bots/nope", { token })).status).toBe(404);
    expect((await call("DELETE", `/api/bots/${id}`)).status).toBe(403);
    expect((await call("DELETE", `/api/bots/${id}`, { token: "0".repeat(64) })).status).toBe(403);
    expect((await call("DELETE", `/api/bots/${greedyId}`, { token })).status).toBe(403);
    expect((await call("DELETE", `/api/bots/${greedyId}`, { token: "" })).status).toBe(403);

    // Queue some games involving it, then delete: they must be dropped.
    s.scheduler.enqueuePlacement(id);
    const del = await call("DELETE", `/api/bots/${id}`, { token });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: id });
    expect(s.scheduler.queue.some((j) => j.p1 === id || j.p2 === id)).toBe(false);
    await s.scheduler.whenIdle();

    const lb = (await call("GET", "/api/leaderboard")).body;
    expect(lb.map((x: any) => x.id)).not.toContain(id);
    expect(fs.existsSync(codeFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(d, "ladder.json"), "utf8")).bots.map((b: any) => b.id)).not.toContain(id);
    expect((await call("GET", `/api/bots/${id}/code`)).status).toBe(404);
    expect((await call("DELETE", `/api/bots/${id}`, { token })).status).toBe(404);

    // The opponent's history (and its replays) still lists the old games.
    const after = (await call("GET", `/api/bots/${greedyId}/matches?limit=200`)).body;
    const old = after.filter((m: any) => m.p1.id === id || m.p2.id === id);
    expect(old.length).toBeGreaterThan(0);
    expect(old[0].p1.name === "doomed" || old[0].p2.name === "doomed").toBe(true);
    expect((await call("GET", `/api/matches/${old[0].id}/replay`)).status).toBe(200);

    // The name is free again, and matchmaking never picks the deleted bot.
    const again = await call("POST", "/api/bots", { name: "doomed", code: STARTER, owner: OWNER });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(id);
    await s.scheduler.whenIdle();
  });

  it("a game in flight when its bot is deleted is discarded, not recorded", async () => {
    const r = await call("POST", "/api/bots", { name: "mid-run", code: STARTER, owner: OWNER });
    const { id, token } = r.body;
    // Wait until the first placement game is actually running, then delete.
    while (!s.scheduler.busy) await new Promise((res) => setTimeout(res, 1));
    expect((await call("DELETE", `/api/bots/${id}`, { token })).status).toBe(200);
    const recorded = s.ladder.data.matches.filter((m) => m.p1.id === id || m.p2.id === id).length;
    await s.scheduler.whenIdle();
    expect(s.ladder.bot(id)).toBeUndefined();
    expect(s.ladder.data.matches.filter((m) => m.p1.id === id || m.p2.id === id).length).toBe(recorded);
    // Every remaining bot's stats match the recorded history exactly (nothing applied from discarded games).
    for (const b of s.ladder.data.bots) {
      expect(b.games, b.name).toBe(s.ladder.data.matches.filter((m) => m.p1.id === b.id || m.p2.id === b.id).length);
    }
  });
});

describe("owner key (browser id)", () => {
  let s: RunningServer;
  let d: string;
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(s.url + p, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  beforeAll(async () => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-owner-"));
    s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 }, rateLimit: { max: 100, windowMs: 60_000 }, log: () => {},
    });
  });
  afterAll(async () => {
    await s.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("every bot submitted with a key belongs to it: listed, updatable and deletable without tokens", async () => {
    const one = (await call("POST", "/api/bots", { name: "own-one", code: STARTER, owner: A })).body;
    const two = (await call("POST", "/api/bots", { name: "own-two", code: STARTER, owner: A })).body;
    const other = (await call("POST", "/api/bots", { name: "not-mine", code: STARTER, owner: B })).body;
    await s.scheduler.whenIdle();
    expect((await call("POST", "/api/mine", { owner: A })).body.ids.sort()).toEqual([one.id, two.id].sort());
    expect((await call("POST", "/api/mine", { owner: "nothex" })).status).toBe(400);
    expect((await call("POST", "/api/bots", { name: "own-bad", code: STARTER, owner: "XYZ" })).status).toBe(400);
    // The hash never leaks through the public API.
    expect(JSON.stringify((await call("GET", "/api/leaderboard")).body)).not.toContain("ownerHash");

    // Update by key alone; someone else's key can neither update nor delete.
    expect((await call("POST", "/api/bots", { name: "own-two", code: STARTER, owner: A })).body.version).toBe(2);
    expect((await call("POST", "/api/bots", { name: "not-mine", code: STARTER, owner: A })).status).toBe(403);
    expect((await call("DELETE", `/api/bots/${other.id}`, { owner: A })).status).toBe(403);
    expect((await call("DELETE", `/api/bots/house-idle`, { owner: A })).status).toBe(403);

    expect((await call("DELETE", `/api/bots/${one.id}`, { owner: A })).status).toBe(200);
    expect((await call("POST", "/api/mine", { owner: A })).body.ids).toEqual([two.id]);
    await s.scheduler.whenIdle();
  });

  it("a token-only (pre-key) bot is linked to the key by a claim with its token, and only then", async () => {
    // New bots need an owner key over HTTP; a pre-key bot only exists in old data, so create it directly.
    const created = s.ladder.submit("legacy", STARTER, {});
    const legacy = { id: created.bot.id, token: created.token! };
    s.scheduler.enqueuePlacement(legacy.id);
    await s.scheduler.whenIdle();
    expect((await call("POST", "/api/mine", { owner: B, claims: [{ id: legacy.id, token: "f".repeat(64) }] })).body.ids).not.toContain(legacy.id);
    expect((await call("POST", "/api/mine", { owner: B, claims: [{ id: legacy.id, token: legacy.token }] })).body.ids).toContain(legacy.id);
    expect((await call("POST", "/api/mine", { owner: B })).body.ids).toContain(legacy.id); // persisted
    expect((await call("DELETE", `/api/bots/${legacy.id}`, { owner: B })).status).toBe(200);
  });
});

describe("botcoin API", () => {
  let s: RunningServer;
  let d: string;
  const A = "d".repeat(64);
  const B = "e".repeat(64);
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(s.url + p, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  beforeAll(async () => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-coin-"));
    s = await startServer({
      port: 0, dataDir: d, houseBots: ["idle", "greedy"], serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 }, rateLimit: { max: 100, windowMs: 60_000 }, log: () => {},
    });
  });
  afterAll(async () => {
    await s.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("wallet, stipend, submission costs, boost and bets", async () => {
    // The first visit opens the wallet; the first bot is still free.
    expect((await call("POST", "/api/wallet", { owner: A })).body).toMatchObject({ exists: true, balance: 100, nextNewBotCost: 0 });
    expect((await call("POST", "/api/bots", { name: "coin-bot", code: STARTER })).status).toBe(400); // new bots need a key
    const first = await call("POST", "/api/bots", { name: "coin-bot", code: STARTER, owner: A });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ cost: 0, balance: 100 });
    await s.scheduler.whenIdle();
    let w = (await call("POST", "/api/wallet", { owner: A })).body;
    expect(w.exists).toBe(true);
    expect(w.bots).toEqual([{ id: first.body.id, name: "coin-bot", nextUpdateCost: 0 }]);
    const afterPlacement = w.balance;
    expect(afterPlacement).toBe(100); // placement games pay nothing

    // Broken code is never charged.
    const broken = await call("POST", "/api/bots", { name: "coin-two", code: "export function onTick( {", owner: A });
    expect(broken.status).toBe(400);
    expect((await call("POST", "/api/wallet", { owner: A })).body.balance).toBe(afterPlacement);

    // Stipend once a day.
    expect((await call("POST", "/api/wallet/stipend", { owner: A })).body.balance).toBeCloseTo(afterPlacement + 100, 2);
    expect((await call("POST", "/api/wallet/stipend", { owner: A })).status).toBe(409);
    expect((await call("POST", "/api/wallet/stipend", { owner: B })).status).toBe(404);

    // Boost: only the owner, capped, paid, queued ahead of background games.
    const id = first.body.id;
    expect((await call("POST", `/api/bots/${id}/boost`, { owner: B, pairs: 1 })).status).toBe(403);
    expect((await call("POST", `/api/bots/house-idle/boost`, { owner: A, pairs: 1 })).status).toBe(403);
    expect((await call("POST", `/api/bots/${id}/boost`, { owner: A, pairs: 0 })).status).toBe(400);
    expect((await call("POST", `/api/bots/${id}/boost`, { owner: A, pairs: 11 })).status).toBe(409);
    await s.scheduler.stop(); // inspect the queue without workers taking jobs
    s.scheduler.queue.push({ p1: "house-idle", p2: "house-greedy", seed: 999, reason: "background" });
    const boost = await call("POST", `/api/bots/${id}/boost`, { owner: A, pairs: 2 });
    expect(boost.status).toBe(200);
    expect(boost.body).toMatchObject({ queuedGames: 4, boosted: 2 });
    expect(boost.body.balance).toBeCloseTo(afterPlacement + 100 - 10, 2);
    expect(s.scheduler.queue.map((j) => j.reason)).toEqual(["boost", "boost", "boost", "boost", "background"]);
    expect(s.scheduler.queue.slice(0, 4).every((j) => j.p1 === id || j.p2 === id)).toBe(true);
    expect((await call("GET", "/api/leaderboard")).body.find((r: any) => r.id === id).boosted).toBe(2);

    // Bet on the next 4 games; the boost games settle it.
    const bet = await call("POST", `/api/bots/${id}/bet`, { owner: A, stake: 10, games: 4 });
    expect(bet.status).toBe(200);
    expect((await call("POST", `/api/bots/${id}/bet`, { owner: A, stake: 10, games: 4 })).status).toBe(409);
    expect((await call("GET", "/api/leaderboard")).body.find((r: any) => r.id === id).openBet).toEqual({ stake: 10, games: 4, played: 0 });
    s.scheduler.queue.pop(); // drop the stray background game
    s.scheduler.start();
    await s.scheduler.whenIdle();
    const bets = (await call("GET", "/api/bets")).body;
    expect(bets[0]).toMatchObject({ botName: "coin-bot", stake: 10, games: 4, played: 4, outcome: "settled" });
    expect(bets[0].payout).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(bets)).not.toMatch(/owner/);

    // A second bot costs 30, a third 60; a broke owner gets 402.
    w = (await call("POST", "/api/wallet", { owner: A })).body;
    expect(w.nextNewBotCost).toBe(30);
    const second = await call("POST", "/api/bots", { name: "coin-two", code: STARTER, owner: A });
    expect(second.body.cost).toBe(30);
    expect(second.body.balance).toBeCloseTo(w.balance - 30, 2);
    await s.scheduler.whenIdle();
    s.ladder.economy.debit(Object.keys(s.ladder.economy.data.wallets)[0]!, (await call("POST", "/api/wallet", { owner: A })).body.balance, "admin");
    const broke = await call("POST", "/api/bots", { name: "coin-three", code: STARTER, owner: A });
    expect(broke.status).toBe(402);
    expect(broke.body).toMatchObject({ cost: 60, balance: 0 });
  });

  it("test games: played on the server, unrated, 0.5 vs others' bots, free vs house and own bots; code stays private", async () => {
    const C = "f".repeat(64);
    const lb = (await call("GET", "/api/leaderboard")).body;
    const coinBot = lb.find((r: any) => r.name === "coin-bot");
    expect((await call("GET", `/api/bots/${coinBot.id}/code`)).status).toBe(404);
    const matchesBefore = s.ladder.data.matches.length;

    expect((await call("POST", "/api/wallet", { owner: C })).body.balance).toBe(100);
    const g = await call("POST", "/api/test-game", { owner: C, code: STARTER, opponent: coinBot.id, seed: 7, side: 2 });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ cost: 0.5, balance: 99.5 });
    expect(g.body.replay.bots).toEqual(["coin-bot", "my-bot"]);
    expect(g.body.replay.result).toBeTruthy();
    expect(verifyReplay(g.body.replay).ok).toBe(true);
    expect((await call("POST", "/api/test-game", { owner: C, code: STARTER, opponent: coinBot.id, seed: 8, side: 1 })).body.balance).toBe(99);
    const ledger = (await call("POST", "/api/wallet", { owner: C })).body.ledger;
    expect(ledger[0]).toMatchObject({ kind: "test", ref: "coin-bot", delta: -1, count: 2 });

    expect((await call("POST", "/api/test-game", { owner: C, code: STARTER, opponent: "house-idle", seed: 1, side: 1 })).body).toMatchObject({ cost: 0, balance: 99 });
    // Broken code isn't charged.
    const broken = await call("POST", "/api/test-game", { owner: C, code: "export function onTick( {", opponent: coinBot.id, seed: 1, side: 1 });
    expect(broken.status).toBe(400);
    expect(broken.body.initError).toBe(true);
    expect((await call("POST", "/api/wallet", { owner: C })).body.balance).toBe(99);
    // Bad input.
    expect((await call("POST", "/api/test-game", { owner: C, code: STARTER, opponent: "nope", seed: 1, side: 1 })).status).toBe(404);
    expect((await call("POST", "/api/test-game", { owner: C, code: STARTER, opponent: coinBot.id, seed: 1, side: 3 })).status).toBe(400);
    expect((await call("POST", "/api/test-game", { owner: "xyz", code: STARTER, opponent: coinBot.id, seed: 1, side: 1 })).status).toBe(400);

    // A (broke) plays its own bot for free, but can't pay for someone else's.
    expect((await call("POST", "/api/test-game", { owner: A, code: STARTER, opponent: coinBot.id, seed: 1, side: 1 })).body).toMatchObject({ cost: 0, balance: 0 });
    const cBot = await call("POST", "/api/bots", { name: "coin-c", code: STARTER, owner: C });
    expect(cBot.body.cost).toBe(0); // C's first bot is still free though its wallet opened earlier
    expect((await call("POST", "/api/test-game", { owner: A, code: STARTER, opponent: cBot.body.id, seed: 1, side: 1 })).status).toBe(402);

    // Nothing was rated or recorded by the test games.
    await s.scheduler.whenIdle();
    expect(s.ladder.data.matches.every((m, i) => i < matchesBefore || m.p1.id === cBot.body.id || m.p2.id === cBot.body.id)).toBe(true);
  });
});
