import { CONFIG } from "./config.js";
import { ADJ8, chebyshev, DIRS, DIR_ORDER_P1, dist2, inBounds, mirror } from "./geometry.js";
import { Rng } from "./rng.js";
import { TILE, type GameMap, type Pos } from "./types.js";

export interface GeneratedMap {
  map: GameMap;
  bases: [Pos, Pos];
  energyNodes: Pos[];
  crystalNodes: Pos[];
  attempts: number;
}

type Grid = string[];

/**
 * Generate a point-symmetric map from a seed. Tile (x,y) always equals tile
 * (size-1-x, size-1-y). Retries with derived seeds until validation passes.
 */
export function generateMap(seed: number): GeneratedMap {
  const rng = new Rng(seed);
  const cfg = CONFIG.map;
  for (let attempt = 1; attempt <= cfg.maxGenerationAttempts; attempt++) {
    const result = tryGenerate(rng);
    if (result) return { ...result, attempts: attempt };
  }
  throw new Error(`map generation failed for seed ${seed}`);
}

function tryGenerate(rng: Rng): Omit<GeneratedMap, "attempts"> | null {
  const cfg = CONFIG.map;
  const size = cfg.size;
  const n = size * size;
  const grid: Grid = new Array(n).fill(TILE.floor);
  const idx = (x: number, y: number) => y * size + x;
  const setSym = (x: number, y: number, t: string) => {
    grid[idx(x, y)] = t;
    const m = mirror(size, { x, y });
    grid[idx(m.x, m.y)] = t;
  };

  // 1. Random walls on one half, mirrored to the other.
  for (let i = 0; i < n / 2; i++) {
    const x = i % size;
    const y = (i - x) / size;
    setSym(x, y, rng.next() < cfg.wallDensity ? TILE.wall : TILE.floor);
  }

  // 2. Cellular smoothing. The rule is symmetric, so symmetry is preserved.
  for (let pass = 0; pass < cfg.smoothingPasses; pass++) {
    const next = grid.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let walls = 0;
        for (const o of ADJ8) {
          const nx = x + o.x;
          const ny = y + o.y;
          if (inBounds(size, nx, ny) && grid[idx(nx, ny)] === TILE.wall) walls++;
        }
        const isWall = grid[idx(x, y)] === TILE.wall;
        next[idx(x, y)] = (isWall ? walls >= 3 : walls >= 5) ? TILE.wall : TILE.floor;
      }
    }
    for (let i = 0; i < n; i++) grid[i] = next[i]!;
  }

  // 3. Bases + clear area around them.
  const b1 = { ...cfg.baseP1 };
  const b2 = mirror(size, b1);
  for (let dy = -cfg.baseClearRadius; dy <= cfg.baseClearRadius; dy++) {
    for (let dx = -cfg.baseClearRadius; dx <= cfg.baseClearRadius; dx++) {
      const x = b1.x + dx;
      const y = b1.y + dy;
      if (inBounds(size, x, y)) setSym(x, y, TILE.floor);
    }
  }

  // 4. Energy nodes near each base.
  const energy: Pos[] = [];
  const candidates: Pos[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = { x, y };
      const d2 = dist2(p, b1);
      if (d2 < cfg.energyNodeMinDist ** 2 || d2 > cfg.energyNodeMaxDist ** 2) continue;
      if (chebyshev(p, b1) <= cfg.baseClearRadius) continue;
      if (grid[idx(x, y)] !== TILE.floor) continue;
      candidates.push(p);
    }
  }
  for (let k = 0; k < cfg.energyNodesPerSide; k++) {
    const ok = candidates.filter((c) => energy.every((e) => chebyshev(c, e) >= 2));
    if (ok.length === 0) return null;
    const p = rng.pick(ok);
    energy.push(p);
    setSym(p.x, p.y, TILE.energy_node);
  }

  // 5. Crystal nodes in mirrored pairs anywhere on the map, away from both starting bases.
  // Distances to b1 and b2 swap under the mirror, so a tile passes iff its twin does.
  const pairs = rng.int(cfg.crystalPairsMin, cfg.crystalPairsMax);
  const crystalHalf: Pos[] = [];
  const crystalCandidates: Pos[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = { x, y };
      if (grid[idx(x, y)] !== TILE.floor) continue;
      if (dist2(p, b1) < cfg.crystalMinBaseDist ** 2 || dist2(p, b2) < cfg.crystalMinBaseDist ** 2) continue;
      if (chebyshev(p, mirror(size, p)) < cfg.crystalMinSpacing) continue;
      if (energy.some((e) => chebyshev(e, p) < cfg.crystalMinSpacing || chebyshev(mirror(size, e), p) < cfg.crystalMinSpacing)) continue;
      crystalCandidates.push(p);
    }
  }
  for (let k = 0; k < pairs; k++) {
    const placed = crystalHalf.flatMap((c) => [c, mirror(size, c)]);
    const ok = crystalCandidates.filter((p) => {
      const m = mirror(size, p);
      return placed.every((c) => chebyshev(c, p) >= cfg.crystalMinSpacing && chebyshev(c, m) >= cfg.crystalMinSpacing);
    });
    if (ok.length === 0) return null;
    const p = rng.pick(ok);
    crystalHalf.push(p);
    setSym(p.x, p.y, TILE.crystal_node);
  }

  // 6. Validate connectivity.
  const tiles = grid.join("");
  const map: GameMap = { size, tiles };
  const energyNodes = [...energy, ...energy.map((p) => mirror(size, p))];
  const crystalNodes = [...crystalHalf, ...crystalHalf.map((p) => mirror(size, p))];
  if (!validateMap(map, [b1, b2], [...energyNodes, ...crystalNodes])) return null;

  return { map, bases: [b1, b2], energyNodes, crystalNodes };
}

/**
 * BFS over floor tiles from the tiles adjacent to base 1. Valid iff base 2 is
 * reachable (some neighbor of it is reached) and every node has a reachable neighbor.
 * Bases occupy floor tiles in the terrain but are treated as blocking.
 */
export function validateMap(map: GameMap, bases: [Pos, Pos], nodes: Pos[]): boolean {
  const size = map.size;
  const blocked = (x: number, y: number) =>
    map.tiles[y * size + x] !== TILE.floor || bases.some((b) => b.x === x && b.y === y);
  const seen = new Uint8Array(size * size);
  const queue: Pos[] = [];
  for (const d of DIR_ORDER_P1) {
    const x = bases[0].x + DIRS[d].x;
    const y = bases[0].y + DIRS[d].y;
    if (inBounds(size, x, y) && !blocked(x, y) && !seen[y * size + x]) {
      seen[y * size + x] = 1;
      queue.push({ x, y });
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    for (const d of DIR_ORDER_P1) {
      const x = c.x + DIRS[d].x;
      const y = c.y + DIRS[d].y;
      if (!inBounds(size, x, y) || blocked(x, y) || seen[y * size + x]) continue;
      seen[y * size + x] = 1;
      queue.push({ x, y });
    }
  }
  const reachableNeighbor = (p: Pos) =>
    ADJ8.some((o) => {
      const x = p.x + o.x;
      const y = p.y + o.y;
      return inBounds(size, x, y) && seen[y * size + x] === 1;
    });
  return reachableNeighbor(bases[1]) && nodes.every(reachableNeighbor);
}

export function tileAt(map: GameMap, x: number, y: number): string {
  return map.tiles[y * map.size + x]!;
}
