// Shared building blocks for the sample bots. Bots may import this like any helper.
import { distance, enemyBasePos, isAdjacent, manhattan, nearest, pathTo, rememberMap } from "./helpers.js";

/** Nodes below this are treated as depleted (energy regenerates only 1/tick). */
const MIN_NODE_AMOUNT = 5;

/** Refresh remembered terrain, nodes and unit bookkeeping. Call once at the top of onTick. */
export function observe(state, memory) {
  rememberMap(state, memory);
  memory.nodes = memory.nodes || {};
  for (const n of state.visibleNodes) memory.nodes[n.id] = { id: n.id, type: n.type, x: n.x, y: n.y, amount: n.amount };
  memory.assign = memory.assign || {};
  memory.last = memory.last || {};
  memory.stuck = memory.stuck || {};
  const alive = new Set(state.myUnits.map((u) => u.id));
  for (const k of Object.keys(memory.assign)) if (!alive.has(Number(k))) delete memory.assign[k];
  for (const k of Object.keys(memory.stuck)) if (!alive.has(Number(k))) delete memory.stuck[k];
  for (const u of state.myUnits) {
    const prev = memory.last[u.id];
    memory.stuck[u.id] = prev && prev.x === u.x && prev.y === u.y && prev.moving ? (memory.stuck[u.id] || 0) + 1 : 0;
  }
  memory.last = {};
}

export function knownNodes(memory, type) {
  return Object.values(memory.nodes || {}).filter((n) => n.type === type && n.amount >= MIN_NODE_AMOUNT);
}

/** Move toward a target, sidestepping when blocked for a few ticks. Records intent for stuck detection. */
export function go(state, memory, u, target) {
  memory.last[u.id] = { x: u.x, y: u.y, moving: true };
  const stuck = memory.stuck[u.id] || 0;
  const to = { x: Math.round(target.x), y: Math.round(target.y) };
  if (stuck >= 1) {
    // Blocked: re-path treating other units as obstacles.
    const avoid = [...state.myUnits.filter((o) => o.id !== u.id), ...state.visibleEnemies.filter((e) => e.kind === "unit")];
    const path = pathTo(state, u, to, { map: memory.map, avoid });
    if (path.length && stuck < 6) return { type: "move", unitId: u.id, dir: path[0].dir };
    const dirs = ["N", "E", "S", "W"];
    return { type: "move", unitId: u.id, dir: dirs[(u.id + state.tick) % 4] };
  }
  return { type: "moveTo", unitId: u.id, x: to.x, y: to.y };
}

/** Pick (and remember) a node for a worker: fewest assigned workers, then closest to base. */
export function assignNode(state, memory, u, type, maxPerNode = 3) {
  const current = memory.assign[u.id] && memory.nodes[memory.assign[u.id]];
  if (current && current.type === type && current.amount >= MIN_NODE_AMOUNT) return current;
  const counts = {};
  for (const id of Object.values(memory.assign)) counts[id] = (counts[id] || 0) + 1;
  let best = null;
  let bestKey = null;
  for (const n of knownNodes(memory, type)) {
    const c = counts[n.id] || 0;
    if (c >= maxPerNode) continue;
    const base = nearest(n, state.myBases || [state.myBase]) || state.myBase;
    const key = [c, distance(n, base), manhattan(n, u), n.id];
    if (!bestKey || compareKeys(key, bestKey) < 0) {
      best = n;
      bestKey = key;
    }
  }
  if (best) memory.assign[u.id] = best.id;
  else delete memory.assign[u.id];
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Standard worker loop: harvest the given node until full, then deposit.
 * Returns home early near the end of the match so cargo counts toward score.
 */
export function workerAct(state, memory, u, node) {
  const carried = u.cargo.energy + u.cargo.crystal;
  const base = nearest(u, state.myBases || [state.myBase]) || state.myBase;
  const ticksLeft = state.maxTicks - state.tick;
  const homeward =
    carried >= u.cargoCapacity ||
    (carried > 0 && (!node || node.amount <= 0)) ||
    (carried > 0 && ticksLeft <= manhattan(u, base) + 2);
  if (homeward) {
    if (isAdjacent(u, base)) return { type: "deposit", unitId: u.id };
    return go(state, memory, u, base);
  }
  if (!node) return null;
  if (isAdjacent(u, node)) return { type: "harvest", unitId: u.id, nodeId: node.id };
  return go(state, memory, u, node);
}

/** Spacing of the search grid: under two worker vision radii, so neighbouring sweeps overlap. */
const SEARCH_STEP = 8;

/** Crystal can be anywhere on the map, so search a grid of waypoints that covers all of it. */
export function searchWaypoints(state) {
  const size = state.mapSize;
  const pts = [];
  for (let y = SEARCH_STEP / 2; y < size; y += SEARCH_STEP) {
    for (let x = SEARCH_STEP / 2; x < size; x += SEARCH_STEP) pts.push({ x, y });
  }
  return pts;
}

/**
 * Head for the nearest waypoint whose tile hasn't been seen yet (memory.map, kept by observe),
 * preferring ones no other unit is heading to. Starting from home, nearest-first sweeps our own
 * side before the enemy's. Once everything has been seen, cycles through the waypoints.
 */
export function exploreUnknown(state, memory, u, waypoints) {
  const size = state.mapSize;
  const unseen = (p) => !memory.map || memory.map[p.y * size + p.x] === "?";
  const alive = new Set(state.myUnits.map((o) => o.id));
  memory.seek = memory.seek || {};
  for (const k of Object.keys(memory.seek)) if (!alive.has(Number(k)) || Number(k) === u.id) delete memory.seek[k];
  const open = waypoints.filter(unseen);
  if (open.length === 0) return explore(state, memory, u, waypoints);
  const taken = new Set(Object.values(memory.seek).map((p) => p.x + "," + p.y));
  const free = open.filter((p) => !taken.has(p.x + "," + p.y));
  const pool = free.length ? free : open;
  pool.sort((a, b) => manhattan(a, u) - manhattan(b, u) || a.y - b.y || a.x - b.x);
  memory.seek[u.id] = pool[0];
  return go(state, memory, u, pool[0]);
}

/** Worker that fetches crystal: searches the map until a crystal node is known. */
export function crystalWorkerAct(state, memory, u) {
  const node = assignNode(state, memory, u, "crystal", 4);
  if (node || u.cargo.energy + u.cargo.crystal > 0) {
    if (memory.seek) delete memory.seek[u.id];
    return workerAct(state, memory, u, node);
  }
  return exploreUnknown(state, memory, u, searchWaypoints(state));
}

export function explore(state, memory, u, waypoints) {
  memory.wp = memory.wp || {};
  let i = memory.wp[u.id] || 0;
  if (distance(u, waypoints[i % waypoints.length]) <= 1) i++;
  memory.wp[u.id] = i;
  return go(state, memory, u, waypoints[i % waypoints.length]);
}

/**
 * Fighter: attack the best adjacent enemy, otherwise advance on `target`.
 * `prefer` = "units" (default) or "base".
 */
export function fighterAct(state, memory, u, target, prefer = "units") {
  const adj = state.visibleEnemies.filter((e) => distance(u, e) <= 1);
  if (adj.length) {
    const rank = (e) => {
      if (prefer === "base" && e.kind === "base") return -1;
      if (e.kind === "unit") return e.type === "fighter" ? 0 : 1;
      if (e.kind === "structure") return e.type === "turret" ? 2 : 4;
      return 3;
    };
    adj.sort((a, b) => rank(a) - rank(b) || a.hp - b.hp || a.id - b.id);
    return { type: "attack", unitId: u.id, targetId: adj[0].id };
  }
  return target ? go(state, memory, u, target) : null;
}

export function nearestEnemyUnit(state, from, filter) {
  return nearest(from, state.visibleEnemies, (e) => e.kind === "unit" && (!filter || filter(e)));
}

export { enemyBasePos };
