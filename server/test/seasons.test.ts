import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ladder } from "../src/ladder.js";
import { startServer, type RunningServer } from "../src/index.js";
import { JsonFileStore } from "../src/store.js";

const BOTS = path.resolve(__dirname, "../../bots");
let srv: RunningServer;
let root: string;
let matchId: string;

async function get(p: string) {
  const res = await fetch(srv.url + p);
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-seasons-"));
  // Two archived seasons (what a reset leaves next to data/), plus noise that must be ignored.
  for (const id of ["20260101-120000", "20260202-130000"]) {
    const ladder = new Ladder(new JsonFileStore(path.join(root, `data-backup-${id}`)));
    for (const n of ["idle", "greedy"]) ladder.registerHouseBot(n, path.join(BOTS, `${n}.js`));
    const rec = await ladder.playGame("house-greedy", "house-idle", 7);
    matchId = rec!.id;
  }
  fs.mkdirSync(path.join(root, "data-backup-notadate"));
  fs.mkdirSync(path.join(root, "data-backup-20260303-000000")); // no ladder.json
  srv = await startServer({
    port: 0,
    dataDir: path.join(root, "data"),
    houseBots: ["idle"],
    serveViewer: false,
    scheduler: { autoplay: false, idleDelayMs: 0 },
    log: () => {},
  });
});
afterAll(async () => {
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("past seasons", () => {
  it("lists backups next to the data dir, oldest first, numbered", async () => {
    const { body } = await get("/api/seasons");
    expect(body.map((s: any) => [s.id, s.number])).toEqual([["20260101-120000", 1], ["20260202-130000", 2]]);
    expect(body[0]).toMatchObject({ bots: 2, matches: 1, champion: { name: "greedy" } });
  });

  it("serves an archived season's leaderboard, matches and replays read-only", async () => {
    const base = "/api/seasons/20260101-120000";
    const lb = (await get(`${base}/leaderboard`)).body;
    expect(lb.map((r: any) => [r.name, r.games])).toEqual([["greedy", 1], ["idle", 1]]);
    expect((await get(`${base}/highscore`)).body.name).toBe("greedy");
    const ms = (await get(`${base}/bots/house-idle/matches`)).body;
    expect(ms.map((m: any) => m.id)).toEqual([matchId]);
    const replay = (await get(`${base}/matches/${matchId}/replay`)).body;
    expect(replay.bots).toEqual(["greedy", "idle"]);
    // The live ladder is untouched.
    expect((await get("/api/leaderboard")).body.map((r: any) => r.games)).toEqual([0]);
  });

  it("404s on unknown seasons, bad ids and unknown routes", async () => {
    expect((await get("/api/seasons/20990101-000000/leaderboard")).status).toBe(404);
    expect((await get("/api/seasons/20260303-000000/leaderboard")).status).toBe(404);
    expect((await get("/api/seasons/..%2F..%2Fetc/leaderboard")).status).toBe(404);
    expect((await get("/api/seasons/20260101-120000/bots/nope/matches")).status).toBe(404);
    expect((await get("/api/seasons/20260101-120000/matches/m9999999/replay")).status).toBe(404);
    expect((await get("/api/seasons/20260101-120000/whatever")).status).toBe(404);
  });
});

describe("startNewSeason", () => {
  it("archives the data dir and restarts the ladder with the same bots, wallets kept, open bets refunded", async () => {
    const { startNewSeason, Seasons } = await import("../src/index.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "new-season-"));
    const dir = path.join(root, "data");
    const l = new Ladder(new JsonFileStore(dir));
    const owner = "f".repeat(64);
    const { bot } = l.submit("keeper", "export function onTick(){return []}", { owner });
    Object.assign(bot, { elo: 1500, games: 9, wins: 9, highScore: 77, highScoreMatch: "m0000009" });
    l.data.nextMatch = 10;
    l.placeBet(bot.id, { owner }, 30, 4);
    const loser = l.submit("loser", "export function onTick(){return []}", { owner }).bot;
    loser.elo = 1199.4; // shown as 1199
    l.economy.credit(Object.keys(l.economy.data.wallets)[0]!, 100, "admin");
    const even = l.submit("even", "export function onTick(){return []}", { owner }).bot;
    even.elo = 1199.5; // shown as 1200
    l.save();

    const r = startNewSeason(dir, new Date(2026, 10, 13, 15, 4, 5), { minElo: 1200 });
    expect(r).toMatchObject({ archive: `${dir}-backup-20261113-150405`, bots: 2, refundedBets: 1, dropped: [{ name: "loser", elo: 1199 }] });
    // The archive is the old ladder, untouched.
    expect(JSON.parse(fs.readFileSync(path.join(r.archive, "ladder.json"), "utf8")).bots[0].elo).toBe(1500);
    const fresh = new Ladder(new JsonFileStore(dir));
    const b = fresh.bot(bot.id)!;
    expect(b).toMatchObject({ name: "keeper", elo: 1200, games: 0, wins: 0, highScore: null, version: 1 });
    expect(fresh.owns(b, { owner })).toBe(true);
    expect(fresh.store.loadCode(b.id)).toContain("onTick");
    expect(fresh.data.matches).toEqual([]);
    expect(fresh.data.nextMatch).toBe(10);
    expect(fresh.bot(loser.id)).toBeUndefined(); // below 1200: stays in the archive only
    expect(fresh.store.loadCode(loser.id)).toBeNull();
    expect(new JsonFileStore(r.archive).loadCode(loser.id)).toContain("onTick");
    expect(fresh.bot(even.id)).toBeDefined(); // shown as 1200: carries over
    // The bet stake came back; the 2nd and 3rd bots cost 30 and 60.
    expect(fresh.walletView(owner)).toMatchObject({ balance: 100 + 100 - 30 - 60, nextNewBotCost: 30 }); // count reset; owns bots, so not free
    expect(fresh.economy.openBet(b.id)).toBeUndefined();
    expect(new Seasons(dir).list().map((s) => s.id)).toEqual(["20261113-150405"]);
    expect(() => startNewSeason(path.join(root, "nope"))).toThrow(/no ladder.json/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("Elo cut at the start of a new season", () => {
    const code = "export function onTick(){return []}";
    async function endSeasonWith(elos: Record<string, number>) {
      const { startNewSeason } = await import("../src/index.js");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "season-cut-"));
      const dir = path.join(root, "data");
      const l = new Ladder(new JsonFileStore(dir));
      const ids: Record<string, string> = {};
      for (const [name, elo] of Object.entries(elos)) {
        const { bot } = l.submit(name, code, { owner: "a".repeat(64) });
        bot.elo = elo;
        ids[name] = bot.id;
      }
      l.save();
      const r = startNewSeason(dir, new Date(2026, 10, 14, 9, 0, 0)); // default threshold
      const fresh = new Ladder(new JsonFileStore(dir));
      const archived = new JsonFileStore(r.archive);
      return { r, fresh, archived, ids, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    }

    it("removes a bot that finished below SEASON_MIN_ELO, keeping it in the archive", async () => {
      const { SEASON_MIN_ELO } = await import("../src/index.js");
      expect(SEASON_MIN_ELO).toBe(1200);
      const { r, fresh, archived, ids, cleanup } = await endSeasonWith({ weak: 1150, strong: 1300 });
      expect(r.minElo).toBe(1200);
      expect(r.dropped).toEqual([{ name: "weak", elo: 1150 }]);
      expect(fresh.bot(ids.weak!)).toBeUndefined();
      expect(fresh.byName("weak")).toBeUndefined();
      expect(fresh.store.loadCode(ids.weak!)).toBeNull();
      expect(archived.load().bots.find((b) => b.id === ids.weak)?.elo).toBe(1150);
      expect(archived.loadCode(ids.weak!)).toContain("onTick");
      cleanup();
    });

    it("keeps a bot that finished above 1200, reset to the starting Elo", async () => {
      const { r, fresh, ids, cleanup } = await endSeasonWith({ strong: 1450 });
      expect(r.dropped).toEqual([]);
      expect(fresh.bot(ids.strong!)).toMatchObject({ name: "strong", elo: 1200, games: 0 });
      expect(fresh.store.loadCode(ids.strong!)).toContain("onTick");
      cleanup();
    });

    it("keeps a bot that finished at exactly 1200", async () => {
      const { r, fresh, ids, cleanup } = await endSeasonWith({ exact: 1200, below: 1199 });
      expect(r.dropped).toEqual([{ name: "below", elo: 1199 }]);
      expect(fresh.bot(ids.exact!)).toMatchObject({ name: "exact", elo: 1200 });
      expect(fresh.store.loadCode(ids.exact!)).toContain("onTick");
      cleanup();
    });
  });
});
