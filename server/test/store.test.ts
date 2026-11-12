import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyLadder, JsonFileStore, writeFileAtomic } from "../src/store.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("JsonFileStore", () => {
  it("round-trips ladder data, code and replays", () => {
    const dir = tmp();
    const s = new JsonFileStore(dir);
    expect(s.load()).toEqual(emptyLadder());
    const data = emptyLadder();
    data.nextSeed = 42;
    data.bots.push({
      id: "b1", name: "x", house: false, version: 2, tokenHash: "ab", file: null, elo: 1234.5, games: 3, wins: 2, losses: 1,
      draws: 0, gamesSinceVersion: 1, highScore: 900, highScoreMatch: "m1", createdAt: "t", lastPlayedAt: null,
    });
    s.save(data);
    s.saveCode("b1", "export function onTick(){return []}");
    s.saveReplay("m1", { format: "bot-arena-replay" } as never);
    const s2 = new JsonFileStore(dir);
    expect(s2.load()).toEqual(data);
    expect(s2.loadCode("b1")).toContain("onTick");
    expect(s2.loadReplay("m1")).toEqual({ format: "bot-arena-replay" });
    s2.deleteReplay("m1");
    expect(s2.loadReplay("m1")).toBeNull();
    expect(s2.loadReplay("../ladder")).toBeNull();
    expect(() => s2.saveCode("../evil", "x")).toThrow();
  });

  it("writes atomically: no temp files left; a crashed write (stray temp) never corrupts the ladder", () => {
    const dir = tmp();
    const s = new JsonFileStore(dir);
    const a = emptyLadder();
    a.nextSeed = 7;
    s.save(a);
    // Simulate a crash mid-write: a partial temp file next to the real one.
    fs.writeFileSync(path.join(dir, "ladder.json.123.456.tmp"), '{"formatVersion":1,"nextSe');
    expect(s.load().nextSeed).toBe(7);
    const b = emptyLadder();
    b.nextSeed = 8;
    s.save(b);
    expect(s.load().nextSeed).toBe(8);
    const temps = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") && !f.includes(".123.456."));
    expect(temps).toEqual([]);
  });

  it("writeFileAtomic replaces content in one step", () => {
    const f = path.join(tmp(), "x.json");
    writeFileAtomic(f, "1");
    writeFileAtomic(f, "2");
    expect(fs.readFileSync(f, "utf8")).toBe("2");
  });
});
