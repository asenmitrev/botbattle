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
