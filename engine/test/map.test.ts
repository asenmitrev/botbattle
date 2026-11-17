import { describe, expect, it } from "vitest";
import { CONFIG } from "../src/config.js";
import { createInitialState, generateMap, validateMap } from "../src/index.js";
import { TILE } from "../src/types.js";

const mirror = (p: { x: number; y: number }) => ({ x: CONFIG.map.size - 1 - p.x, y: CONFIG.map.size - 1 - p.y });
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);

describe("map generation", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(generateMap(42)).toEqual(generateMap(42));
    expect(generateMap(42).map.tiles).not.toBe(generateMap(43).map.tiles);
  });

  it.each(SEEDS)("seed %i: point-symmetric, valid, correct node counts", (seed) => {
    const g = generateMap(seed);
    const { size, tiles } = g.map;
    expect(size).toBe(40);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) expect(tiles[y * size + x]).toBe(tiles[(size - 1 - y) * size + (size - 1 - x)]);

    expect(g.energyNodes).toHaveLength(2 * CONFIG.map.energyNodesPerSide);
    expect([2, 4]).toContain(g.crystalNodes.length);
    const count = (c: string) => tiles.split("").filter((t) => t === c).length;
    expect(count(TILE.energy_node)).toBe(8);
    expect(count(TILE.crystal_node)).toBe(g.crystalNodes.length);

    const [b1, b2] = g.bases;
    expect(b2).toEqual({ x: 39 - b1.x, y: 39 - b1.y });
    for (const n of g.energyNodes.slice(0, 4)) {
      const d = Math.hypot(n.x - b1.x, n.y - b1.y);
      expect(d).toBeGreaterThanOrEqual(3);
      expect(d).toBeLessThanOrEqual(8);
    }
    expect(validateMap(g.map, g.bases, [...g.energyNodes, ...g.crystalNodes])).toBe(true);

    // Crystal: mirrored pairs, away from both bases, spaced from every other node.
    const half = g.crystalNodes.length / 2;
    for (let i = 0; i < half; i++) expect(g.crystalNodes[half + i]).toEqual(mirror(g.crystalNodes[i]!));
    for (const c of g.crystalNodes) {
      expect(tiles[c.y * size + c.x]).toBe(TILE.crystal_node);
      for (const b of g.bases) expect(Math.hypot(c.x - b.x, c.y - b.y)).toBeGreaterThanOrEqual(CONFIG.map.crystalMinBaseDist);
      for (const o of [...g.energyNodes, ...g.crystalNodes]) {
        if (o === c) continue;
        expect(cheb(c, o)).toBeGreaterThanOrEqual(CONFIG.map.crystalMinSpacing);
      }
    }
  });

  it("crystal is deterministic per seed", () => {
    for (const seed of SEEDS.slice(0, 10)) expect(generateMap(seed).crystalNodes).toEqual(generateMap(seed).crystalNodes);
  });

  it("crystal spreads across the whole map, not just the center", () => {
    const center = (CONFIG.map.size - 1) / 2;
    const crystals = Array.from({ length: 200 }, (_, i) => generateMap(i * 104729 + 3).crystalNodes).flat();
    const fromCenter = crystals.map((c) => Math.hypot(c.x - center, c.y - center));
    // The old generator kept every crystal within 7 of the center; now many land well outside it.
    const outside = fromCenter.filter((d) => d > 7).length;
    expect(outside / crystals.length).toBeGreaterThan(0.5);
    expect(Math.max(...fromCenter)).toBeGreaterThan(15);
    // All four quadrants get crystal.
    const quadrants = new Set(crystals.map((c) => `${c.x < center ? "W" : "E"}${c.y < center ? "N" : "S"}`));
    expect(quadrants.size).toBe(4);
  });

  it("initial state: bases 200 HP, 150 energy, 2 workers adjacent to base each", () => {
    const s = createInitialState(7);
    expect(s.bases.map((b) => b.hp)).toEqual([200, 200]);
    expect(s.players.map((p) => [p.energy, p.crystal])).toEqual([[150, 0], [150, 0]]);
    for (const owner of [1, 2] as const) {
      const ws = s.units.filter((u) => u.owner === owner);
      expect(ws).toHaveLength(2);
      const base = s.bases[owner - 1];
      for (const w of ws) expect(Math.max(Math.abs(w.x - base.x), Math.abs(w.y - base.y))).toBe(1);
    }
  });

  it("validateMap rejects a map with bases separated by a wall", () => {
    const g = generateMap(5);
    const tiles = g.map.tiles.split("");
    for (let x = 0; x < 40; x++) tiles[20 * 40 + x] = TILE.wall;
    expect(validateMap({ size: 40, tiles: tiles.join("") }, g.bases, [])).toBe(false);
  });
});
