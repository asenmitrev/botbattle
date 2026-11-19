// Helper library for bots. Pure functions only (no I/O), safe to use inside the sandbox.

export const DIRS = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 } };

export const COSTS = {
  worker: { energy: 50, crystal: 0 },
  fighter: { energy: 60, crystal: 15 },
  scout: { energy: 30, crystal: 0 },
  turret: { energy: 100, crystal: 0 },
  wall: { energy: 3, crystal: 0 },
  base: { energy: 100, crystal: 50 },
  // Tumor race
  stemCell: { energy: 25, crystal: 0 },
  immuneCell: { energy: 0, crystal: 15 },
  purificationCell: { energy: 50, crystal: 0 },
  siegeCell: { energy: 75, crystal: 0 },
  /** What a Stem Cell's `transform` costs. */
  tumorCell: { energy: 75, crystal: 0 },
};

/** Upgrade costs, by upgrade name (bought once; only your race's upgrades can be bought). */
export const UPGRADE_COSTS = {
  scout: { energy: 0, crystal: 15 },
  wall: { energy: 50, crystal: 0 },
  fighter: { energy: 0, crystal: 20 },
  tumorSpeed: { energy: 100, crystal: 0 },
  photosynthesis: { energy: 0, crystal: 20 },
  freedom: { energy: 150, crystal: 0 },
  toxic: { energy: 0, crystal: 20 },
};

/** Chebyshev distance — the metric used for all action ranges (adjacent = 1). */
export function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Manhattan distance — number of 4-directional steps on an open map. */
export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function isAdjacent(a, b) {
  return distance(a, b) === 1;
}

/** Item in `list` closest to `from` (Chebyshev, tie-break Manhattan then lowest id). */
export function nearest(from, list, filter) {
  let best = null;
  let bd = Infinity;
  let bm = Infinity;
  for (const item of list) {
    if (filter && !filter(item)) continue;
    const d = distance(from, item);
    const m = manhattan(from, item);
    if (d < bd || (d === bd && (m < bm || (m === bm && best && item.id < best.id)))) {
      best = item;
      bd = d;
      bm = m;
    }
  }
  return best;
}

/** The enemy starting base is the point mirror of your starting base. */
export function enemyBasePos(state) {
  const base = state.startingBase || state.myBase;
  return { x: state.mapSize - 1 - base.x, y: state.mapSize - 1 - base.y };
}

export function canAfford(state, what, count = 1) {
  const c = COSTS[what];
  return state.energy >= c.energy * count && state.crystal >= c.crystal * count;
}

/**
 * Persist terrain the bot has seen into `memory.map` (a string of size*size chars:
 * '?' unknown, '.' floor, '#' wall, 'E' energy node, 'C' crystal node).
 */
export function rememberMap(state, memory) {
  const n = state.mapSize * state.mapSize;
  const chars = typeof memory.map === "string" && memory.map.length === n ? memory.map.split("") : new Array(n).fill("?");
  const code = { floor: ".", wall: "#", energy_node: "E", crystal_node: "C" };
  for (const t of state.visibleTiles) chars[t.y * state.mapSize + t.x] = code[t.type];
  memory.map = chars.join("");
  return memory.map;
}

/**
 * BFS shortest path from `from` to `to` over known terrain (unknown tiles are
 * assumed walkable). If `to` is blocked, the path ends next to it.
 * Options: { map: memory.map string, avoid: [{x,y}] extra blocked tiles, maxNodes }.
 * Returns an array of {x,y,dir} steps (empty if already there or unreachable).
 */
export function pathTo(state, from, to, options = {}) {
  const size = state.mapSize;
  const blocked = new Uint8Array(size * size);
  const mapStr = options.map;
  if (typeof mapStr === "string" && mapStr.length === size * size) {
    for (let i = 0; i < mapStr.length; i++) if (mapStr[i] !== "." && mapStr[i] !== "?") blocked[i] = 1;
  } else {
    for (const t of state.visibleTiles) if (t.type !== "floor") blocked[t.y * size + t.x] = 1;
  }
  for (const b of state.myBases || [state.myBase]) if (b.hp > 0) blocked[b.y * size + b.x] = 1;
  for (const s of state.myStructures) blocked[s.y * size + s.x] = 1;
  for (const e of state.visibleEnemies) if (e.kind !== "unit") blocked[e.y * size + e.x] = 1;
  for (const p of options.avoid || []) blocked[p.y * size + p.x] = 1;

  const start = from.y * size + from.x;
  const goal = to.y * size + to.x;
  if (start === goal) return [];
  const prev = new Int32Array(size * size).fill(-1);
  prev[start] = start;
  const queue = [start];
  const order = ["N", "E", "S", "W"];
  let found = -1;
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    const cx = cur % size;
    const cy = (cur - cx) / size;
    for (const d of order) {
      const nx = cx + DIRS[d].x;
      const ny = cy + DIRS[d].y;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (prev[ni] !== -1) continue;
      if (ni === goal) {
        prev[ni] = cur;
        found = blocked[ni] ? cur : ni;
        break;
      }
      if (blocked[ni]) continue;
      prev[ni] = cur;
      queue.push(ni);
    }
    if (found !== -1) break;
  }
  if (found === -1) return [];
  const path = [];
  for (let c = found; c !== start; c = prev[c]) {
    const x = c % size;
    const y = (c - x) / size;
    const px = prev[c] % size;
    const py = (prev[c] - px) / size;
    const dir = x > px ? "E" : x < px ? "W" : y > py ? "S" : "N";
    path.push({ x, y, dir });
  }
  return path.reverse();
}

/** Free tiles adjacent (8-neighborhood) to `p`, according to the bot's current view. */
export function freeNeighbors(state, p) {
  const size = state.mapSize;
  const taken = new Set();
  const key = (x, y) => y * size + x;
  for (const t of state.visibleTiles) if (t.type !== "floor") taken.add(key(t.x, t.y));
  for (const u of state.myUnits) taken.add(key(u.x, u.y));
  for (const s of state.myStructures) taken.add(key(s.x, s.y));
  for (const e of state.visibleEnemies) taken.add(key(e.x, e.y));
  for (const b of state.myBases || [state.myBase]) if (b.hp > 0) taken.add(key(b.x, b.y));
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = p.x + dx;
      const y = p.y + dy;
      if (x < 0 || y < 0 || x >= size || y >= size || taken.has(key(x, y))) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** Is `p` inside the zone that will be in effect next tick (with an optional margin)? */
export function inSafeZone(state, p, margin = 0) {
  const dx = p.x - state.zone.x;
  const dy = p.y - state.zone.y;
  const r = state.zone.nextRadius - margin;
  return dx * dx + dy * dy <= r * r;
}
