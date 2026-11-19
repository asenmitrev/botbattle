import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import {
  buildBotView, computeVisibility, createInitialState, parseRaceExport, runMatch, step, verifyReplay,
  type BotController, type BotState,
} from "../src/index.js";
import type { GameEvent, GameState, Structure } from "../src/types.js";
import { addUnit, testState, unit } from "./util.js";

const invalid = (events: GameEvent[]) => events.filter((e) => e.type === "invalid_action");
const T = CONFIG.races.tumor;
/** Player 1 plays Tumor, player 2 classic. */
const tumorState = () => testState({ races: ["tumor", "classic"] });
const addStructure = (s: GameState, owner: 1 | 2, type: Structure["type"], x: number, y: number, hp = CONFIG.structures[type].hp): Structure => {
  const st: Structure = { id: s.nextId++, owner, type, x, y, hp, upgrades: [] };
  s.structures.push(st);
  return st;
};

describe("races", () => {
  it("a Tumor player starts with a 30-HP Tumor Cell and two Stem Cells", () => {
    const s = createInitialState(7, ["tumor", "classic"]);
    expect(s.players.map((p) => p.race)).toEqual(["tumor", "classic"]);
    expect(s.bases.map((b) => b.hp)).toEqual([T.base.hp, CONFIG.races.classic.base.hp]);
    expect(s.units.filter((u) => u.owner === 1).map((u) => u.type)).toEqual(["stemCell", "stemCell"]);
    expect(s.units.filter((u) => u.owner === 2).map((u) => u.type)).toEqual(["worker", "worker"]);
    const view = buildBotView(s, 1);
    expect(view.race).toBe("tumor");
    expect(view.myUpgrades).toEqual({ tumorSpeed: false, photosynthesis: false, freedom: false, toxic: false });
    expect(buildBotView(s, 2).myUpgrades).toEqual({ scout: false, wall: false, fighter: false });
  });

  it("Tumor Cells see 10 tiles", () => {
    const s = tumorState();
    const vis = computeVisibility(s, 1);
    expect(vis[4 * 40 + 14]).toBe(1);
    expect(vis[4 * 40 + 15]).toBe(0);
  });

  it("players can only spawn, build and upgrade their own race's types", () => {
    const s = tumorState();
    const stem = addUnit(s, 1, "stemCell", 6, 6);
    const worker = addUnit(s, 2, "worker", 33, 33);
    const r = step(s, [
      { type: "spawn", unit: "fighter" },
      { type: "build", unitId: stem.id, structure: "turret", x: 7, y: 6 },
      { type: "upgrade", upgrade: "scout" },
    ], [
      { type: "spawn", unit: "immuneCell" },
      { type: "build", unitId: worker.id, structure: "siegeCell", x: 32, y: 33 },
      { type: "upgrade", upgrade: "toxic" },
    ]);
    expect(invalid(r.events).map((e) => (e as { reason: string }).reason)).toEqual([
      "fighter is not a unit of your race",
      "scout is not an upgrade of your race",
      "immuneCell is not a unit of your race",
      "toxic is not an upgrade of your race",
      "turret is not a building your race can build",
      "siegeCell is not a building your race can build",
    ]);
    expect(r.state.units).toHaveLength(2);
    expect(r.state.structures).toHaveLength(0);
  });

  it("Stem Cells can't build a base, and only Stem Cells can transform", () => {
    const s = tumorState();
    const stem = addUnit(s, 1, "stemCell", 6, 6);
    const worker = addUnit(s, 2, "worker", 33, 33);
    const r = step(s, [{ type: "build", unitId: stem.id, structure: "base", x: 7, y: 6 }], [{ type: "transform", unitId: worker.id }]);
    expect(invalid(r.events).map((e) => (e as { reason: string }).reason)).toEqual([
      "worker cannot transform",
      "base is not a building your race can build",
    ]);
  });

  it("parses a bot's race export", () => {
    expect(parseRaceExport(undefined)).toEqual({ race: "classic" });
    expect(parseRaceExport("tumor")).toEqual({ race: "tumor" });
    expect(parseRaceExport("zerg")).toHaveProperty("error");
    expect(parseRaceExport(3)).toHaveProperty("error");
  });
});

describe("Tumor: transform", () => {
  it("turns a Stem Cell into a Tumor Cell on its own tile, anywhere, for its energy cost", () => {
    const s = tumorState();
    const stem = addUnit(s, 1, "stemCell", 30, 20, { cargo: { energy: 5, crystal: 0 } });
    const before = s.players[0].energy;
    const r = step(s, [{ type: "transform", unitId: stem.id }], []);
    expect(invalid(r.events)).toHaveLength(0);
    expect(unit(r.state, stem.id)).toBeUndefined();
    const cell = r.state.bases.find((b) => b.x === 30 && b.y === 20)!;
    expect(cell).toMatchObject({ owner: 1, hp: T.base.hp });
    expect(r.state.players[0].energy).toBe(before - T.base.costEnergy);
    expect(r.events).toContainEqual({ type: "transform", player: 1, unitId: stem.id, baseId: cell.id, x: 30, y: 20 });
    expect(r.events.some((e) => e.type === "death")).toBe(false);
    // The new Tumor Cell spawns from the next tick.
    const r2 = step(r.state, [{ type: "spawn", unit: "stemCell", baseId: cell.id }], []);
    expect(invalid(r2.events)).toHaveLength(0);
  });

  it("fails without the energy, and the Stem Cell stays", () => {
    const s = tumorState();
    s.players[0].energy = T.base.costEnergy - 1;
    const stem = addUnit(s, 1, "stemCell", 30, 20);
    const r = step(s, [{ type: "transform", unitId: stem.id }], []);
    expect(invalid(r.events)[0]).toMatchObject({ reason: "not enough resources" });
    expect(unit(r.state, stem.id)).toBeDefined();
    expect(r.state.bases).toHaveLength(2);
  });
});

describe("Tumor: placement", () => {
  it("Purification and Siege Cells go within 8 of a Tumor Cell, 16 with Tumor Speed", () => {
    for (const [x, ok, upgrades] of [[12, true, []], [13, false, []], [20, true, ["tumorSpeed"]], [21, false, ["tumorSpeed"]]] as const) {
      const s = tumorState();
      s.players[0].upgrades = [...upgrades];
      const stem = addUnit(s, 1, "stemCell", x - 1, 4);
      const r = step(s, [{ type: "build", unitId: stem.id, structure: "siegeCell", x, y: 4 }], []);
      expect(r.state.structures.length === 1).toBe(ok);
      if (!ok) expect(invalid(r.events)[0]).toMatchObject({ reason: `siegeCell must be within ${upgrades.length ? 16 : 8} tiles of base` });
    }
  });
});

describe("Tumor: Immune Cell leash and upgrades", () => {
  it("can't step more than 8 from its nearest Tumor Cell, but can step back", () => {
    const s = tumorState();
    const out = addUnit(s, 1, "immuneCell", 12, 4); // 8 from (4,4)
    const r = step(s, [{ type: "move", unitId: out.id, dir: "E" }], []);
    expect(unit(r.state, out.id)).toMatchObject({ x: 12, y: 4 });
    const back = step(r.state, [{ type: "move", unitId: out.id, dir: "W" }], []);
    expect(unit(back.state, out.id)).toMatchObject({ x: 10, y: 4 }); // speed 2
  });

  it("a stranded Immune Cell can walk home but not farther away", () => {
    const s = tumorState();
    const lost = addUnit(s, 1, "immuneCell", 30, 4); // 26 from (4,4)
    expect(unit(step(s, [{ type: "move", unitId: lost.id, dir: "E" }], []).state, lost.id)).toMatchObject({ x: 30 });
    expect(unit(step(s, [{ type: "move", unitId: lost.id, dir: "W" }], []).state, lost.id)).toMatchObject({ x: 28 });
  });

  it("Adaptation Freedom removes the leash, for current and future Immune Cells", () => {
    const s = tumorState();
    const out = addUnit(s, 1, "immuneCell", 20, 4);
    const r = step(s, [{ type: "upgrade", upgrade: "freedom" }, { type: "move", unitId: out.id, dir: "E" }], []);
    expect(unit(r.state, out.id)).toMatchObject({ x: 22, upgrades: ["freedom"] });
    expect(buildBotView(r.state, 1).myUnits[0]).toMatchObject({ leash: null, upgraded: true, upgrades: ["freedom"] });
    const spawned = step(r.state, [{ type: "spawn", unit: "immuneCell" }], []);
    expect(spawned.state.units.find((u) => u.id !== out.id)!.upgrades).toEqual(["freedom"]);
  });

  it("Adaptation Toxic gives range 2", () => {
    const s = tumorState();
    const cell = addUnit(s, 1, "immuneCell", 10, 10);
    const target = addUnit(s, 2, "worker", 12, 10);
    expect(invalid(step(s, [{ type: "attack", unitId: cell.id, targetId: target.id }], []).events)[0]).toMatchObject({ reason: "target out of range" });
    const r = step(s, [{ type: "upgrade", upgrade: "toxic" }, { type: "attack", unitId: cell.id, targetId: target.id }], []);
    expect(invalid(r.events)).toHaveLength(0);
    expect(unit(r.state, target.id)!.hp).toBe(CONFIG.units.worker.hp - CONFIG.units.immuneCell.damage);
    expect(buildBotView(r.state, 1).myUnits[0]!.range).toBe(2);
  });
});

describe("Tumor: automatic attacks", () => {
  it("a Tumor Cell shoots the lowest-HP enemy unit within 3, skipping upgraded fighters", () => {
    const s = tumorState();
    const far = addUnit(s, 2, "fighter", 8, 4, { hp: 1 });
    const immune = addUnit(s, 2, "fighter", 7, 4, { hp: 5, upgrades: ["fighter"] });
    const plain = addUnit(s, 2, "fighter", 6, 5, { hp: 10 });
    const other = addUnit(s, 2, "fighter", 5, 5, { hp: 20 });
    const r = step(s, [], []);
    expect(unit(r.state, immune.id)!.hp).toBe(5);
    expect(unit(r.state, plain.id)!.hp).toBe(10 - T.base.damage);
    expect(unit(r.state, far.id)!.hp).toBe(1);
    expect(unit(r.state, other.id)!.hp).toBe(20);
  });

  it("upgraded fighters take no damage from any building", () => {
    const s = tumorState();
    addStructure(s, 1, "siegeCell", 6, 4);
    const fighter = addUnit(s, 2, "fighter", 5, 5, { upgrades: ["fighter"] }); // in Tumor Cell and Siege Cell range
    const r = step(s, [], []);
    expect(unit(r.state, fighter.id)!.hp).toBe(CONFIG.units.fighter.hp);
    expect(r.events.filter((e) => e.type === "attack" && e.targetId === fighter.id)).toHaveLength(0);
  });

  it("a Siege Cell shoots the lowest-HP enemy building within 6 and never units", () => {
    const s = tumorState();
    const siege = addStructure(s, 1, "siegeCell", 20, 20);
    const wall = addStructure(s, 2, "wall", 26, 20, 30);
    const turret = addStructure(s, 2, "turret", 25, 25, 40);
    const tooFar = addStructure(s, 2, "wall", 27, 20, 1);
    addUnit(s, 2, "scout", 21, 20, { hp: 1 });
    const r = step(s, [], []);
    expect(r.events.filter((e) => e.type === "attack" && e.attackerId === siege.id)).toEqual([
      { type: "attack", attackerId: siege.id, targetId: wall.id, damage: 1 },
    ]);
    expect(r.state.structures.find((x) => x.id === turret.id)!.hp).toBe(40);
    expect(r.state.structures.find((x) => x.id === tooFar.id)!.hp).toBe(1);
  });

  it("a Siege Cell can hit a base", () => {
    const s = tumorState();
    addStructure(s, 1, "siegeCell", 29, 35);
    const r = step(s, [], []);
    expect(r.state.bases[1]!.hp).toBe(CONFIG.races.classic.base.hp - CONFIG.structures.siegeCell.damage);
  });
});

describe("Tumor: healing and Photosynthesis", () => {
  it("a Purification Cell heals friendly units, structures and Tumor Cells within 5 by 1, up to max HP", () => {
    const s = tumorState();
    s.bases[0]!.hp = 20;
    const pur = addStructure(s, 1, "purificationCell", 6, 6, 90);
    const hurt = addUnit(s, 1, "immuneCell", 8, 8, { hp: 10 });
    const full = addUnit(s, 1, "stemCell", 7, 7);
    const far = addUnit(s, 1, "immuneCell", 12, 6, { hp: 10 });
    const enemy = addUnit(s, 2, "scout", 9, 6, { hp: 1 });
    const r = step(s, [], []);
    expect(r.state.bases[0]!.hp).toBe(21);
    expect(r.state.structures[0]!.hp).toBe(91);
    expect(unit(r.state, hurt.id)!.hp).toBe(11);
    expect(unit(r.state, full.id)!.hp).toBe(CONFIG.units.stemCell.hp);
    expect(unit(r.state, far.id)!.hp).toBe(10);
    expect(unit(r.state, enemy.id)!.hp).toBe(1);
    expect(r.events.filter((e) => e.type === "heal").map((e) => (e as { targetId: number }).targetId)).toEqual([1, pur.id, hurt.id]);
  });

  it("heals don't stack: two Purification Cells in range still heal 1, and never past max HP", () => {
    const s = tumorState();
    const first = addStructure(s, 1, "purificationCell", 10, 10);
    addStructure(s, 1, "purificationCell", 12, 10);
    const a = addUnit(s, 1, "immuneCell", 11, 11, { hp: 10 });
    const b = addUnit(s, 1, "immuneCell", 11, 12, { hp: 20 });
    const r = step(s, [], []);
    expect(unit(r.state, a.id)!.hp).toBe(11);
    expect(unit(r.state, b.id)!.hp).toBe(20);
    expect(r.events.filter((e) => e.type === "heal" && e.targetId === a.id)).toEqual([{ type: "heal", healerId: first.id, targetId: a.id, amount: 1 }]);
  });

  it("Photosynthesis adds 3 energy every tick", () => {
    const s = tumorState();
    const r1 = step(s, [{ type: "upgrade", upgrade: "photosynthesis" }], []);
    expect(r1.state.players[0].energy).toBe(1000 + 3);
    expect(r1.state.players[0].crystal).toBe(1000 - 20);
    expect(step(r1.state, [], []).state.players[0].energy).toBe(1000 + 6);
  });
});

describe("Tumor: matches and replays", () => {
  it("runs a Tumor-vs-classic match whose replay re-simulates exactly", async () => {
    const tumor: BotController = {
      name: "grower",
      race: "tumor",
      turn: (v: BotState) => ({
        // Both Stem Cells walk toward the center; the first one grows a Tumor Cell at tick 8.
        actions: v.myUnits.map((u, i) => (i === 0 && v.tick === 8 ? { type: "transform", unitId: u.id } : { type: "moveTo", unitId: u.id, x: 20, y: 20 })),
      }),
    };
    const classic: BotController = { name: "idle", turn: () => ({ actions: [] }) };
    const { state, replay } = await runMatch([tumor, classic], { seed: 3 });
    expect(replay.races).toEqual(["tumor", "classic"]);
    expect(state.bases.filter((b) => b.owner === 1).length).toBeGreaterThan(1);
    expect(verifyReplay(replay).ok).toBe(true);
  });
});
