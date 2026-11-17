import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bracketOrder, decideSeries, startServer, type PlayoffSeries, type RunningServer } from "../src/index.js";

describe("playoff bracket", () => {
  it("seeds 1 and 2 can only meet in the final", () => {
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketOrder(2)).toEqual([1, 2]);
  });

  it("series winner: wins, then total score, then the better seed", () => {
    const a = { id: "a", name: "a", seed: 1, elo: 1300 };
    const b = { id: "b", name: "b", seed: 4, elo: 1250 };
    const s = (x: Partial<PlayoffSeries>): PlayoffSeries => ({ round: 0, a, b, games: [], aWins: 0, bWins: 0, draws: 0, aScore: 0, bScore: 0, winner: null, status: "done", ...x });
    expect(decideSeries(s({ aWins: 2, bWins: 3 })).id).toBe("b");
    expect(decideSeries(s({ aWins: 2, bWins: 2, draws: 1, aScore: 10, bScore: 30 })).id).toBe("b");
    expect(decideSeries(s({ aWins: 2, bWins: 2, draws: 1, aScore: 30, bScore: 30 })).id).toBe("a");
  });
});

describe("ending a season from the server", () => {
  let srv: RunningServer;
  let root: string;
  let dir: string;
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(srv.url + p, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "playoff-"));
    dir = path.join(root, "data");
    srv = await startServer({
      port: 0,
      dataDir: dir,
      houseBots: ["idle", "greedy", "starter"],
      serveViewer: false,
      scheduler: { autoplay: false, idleDelayMs: 0 },
      adminPassword: "secret",
      log: () => {},
    });
    for (const b of srv.ladder.data.bots) srv.scheduler.enqueuePlacement(b.id);
    await srv.scheduler.whenIdle();
  }, 120_000); // placement games take longer than the default 10 s hook timeout on a busy machine
  afterAll(async () => {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a wrong password", async () => {
    expect((await api("POST", "/api/admin/end-season", { password: "nope" })).status).toBe(403);
  });

  it("plays the top bots in best-of-5 series, crowns one champion, archives and starts over", { timeout: 120_000 }, async () => {
    const before = (await api("GET", "/api/leaderboard")).body;
    const r = await api("POST", "/api/admin/end-season", { password: "secret" });
    expect(r.status).toBe(202);
    expect((await api("POST", "/api/admin/end-season", { password: "secret" })).status).toBe(409);
    expect((await api("POST", "/api/bots", { name: "late", code: "x", owner: "c".repeat(64) })).status).toBe(503);
    expect((await api("GET", "/api/health")).body.playoff).toBe(true);
    await srv.seasonEnd;

    const p = (await api("GET", "/api/playoff")).body;
    expect(p.status).toBe("done");
    expect(p.seasonId).toMatch(/^\d{8}-\d{6}$/);
    // 3 bots: a 4-slot bracket, seed 1 gets a bye.
    expect(p.entrants.map((e: any) => e.name)).toEqual(before.slice(0, 3).map((x: any) => x.name));
    expect(p.rounds).toHaveLength(2);
    expect(p.rounds[0][0].status).toBe("bye");
    expect(p.rounds[0][0].winner).toBe(p.entrants[0].id);
    const played = p.rounds.flat().filter((s: any) => s.status === "done");
    expect(played).toHaveLength(2);
    for (const s of played) {
      expect(s.games).toHaveLength(5);
      expect(s.aWins + s.bWins + s.draws).toBe(5);
      // Sides alternate.
      expect(s.games.map((g: any) => g.p1)).toEqual([s.a.id, s.b.id, s.a.id, s.b.id, s.a.id]);
    }
    const final = p.rounds[1][0];
    expect(p.champion.id).toBe(final.winner);

    // Archived without its replays; the new season starts at 1200 with no games.
    const seasons = (await api("GET", "/api/seasons")).body;
    expect(seasons).toHaveLength(1);
    expect(seasons[0].id).toBe(p.seasonId);
    expect(seasons[0].champion).toMatchObject({ name: p.champion.name, playoff: true });
    expect((await api("GET", `/api/seasons/${p.seasonId}/playoff`)).body.champion.id).toBe(p.champion.id);
    const replay = await api("GET", `/api/seasons/${p.seasonId}/matches/${final.games[0].id}/replay`);
    expect(replay.status).toBe(404);
    const lb = (await api("GET", "/api/leaderboard")).body;
    expect(lb).toHaveLength(3);
    expect(lb.every((x: any) => x.elo === 1200 && x.games === 0)).toBe(true);
    expect(fs.existsSync(path.join(dir, "playoff.json"))).toBe(false);

    // The new season is live: the ladder plays again.
    srv.scheduler.enqueuePlacement(lb[0].id);
    await srv.scheduler.whenIdle();
    expect((await api("GET", "/api/leaderboard")).body.some((x: any) => x.games > 0)).toBe(true);
  });

  it("with hold, a deploy's season end leaves the new season paused and closed to changes until a restart", { timeout: 120_000 }, async () => {
    const r = await api("POST", "/api/admin/end-season", { password: "secret", hold: true });
    expect(r.status).toBe(202);
    expect(r.body.hold).toBe(true);
    await srv.seasonEnd;
    const p = (await api("GET", "/api/playoff")).body;
    expect(p.status).toBe("done");
    expect(p.champion).toBeTruthy();
    expect((await api("GET", "/api/seasons")).body.at(-1).id).toBe(p.seasonId);
    expect((await api("GET", "/api/health")).body).toMatchObject({ playoff: false, held: true });
    expect(srv.scheduler.started).toBe(false);
    expect((await api("POST", "/api/bots", { name: "late", code: "x", owner: "c".repeat(64) })).status).toBe(503);
    expect((await api("POST", "/api/admin/end-season", { password: "secret" })).status).toBe(409);
  });
});
