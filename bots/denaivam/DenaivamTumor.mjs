// DenaivamTumor — a Tumor-race test bot (rules 4.0.0, local only). One file, imports only "arena",
// so it can be pasted into the Playground editor or run from the CLI.
//
// Plan:
//   1. Stem Cells gather energy at home; a few fetch crystal and search the map for it.
//   2. A Stem Cell grows a Tumor Cell next to each crystal node we find (short trips, more spawn points),
//      and another near the map center before the zone shrinks.
//   3. Upgrades: Photosynthesis → Toxic → Tumor Speed → Freedom.
//   4. A Purification Cell guards home. Immune Cells defend inside their 8-tile leash, then attack in a pack once
//      Freedom is bought.
//   5. Siege push: a Tumor Cell grows ~12 tiles from the enemy base and Siege Cells go up beside it.
import { distance, enemyBasePos, inSafeZone, pathTo, rememberMap, UPGRADE_COSTS } from "arena";

export const race = "tumor";

const ENERGY_WORKERS = 7;
const CRYSTAL_WORKERS = 3;
const MAX_CRYSTAL_TUMORS = 2;
const CENTER_TUMOR_TICK = 320;
const SIEGE_TICK = 180;
const SIEGE_CELLS = 2;
const ATTACK_SIZE = 10;
const RETREAT_SIZE = 3;
const DEFENSE_RADIUS = 10;
/** Upgrades in order: [name, Immune Cells needed before buying it]. Army comes before upgrades. */
const UPGRADE_ORDER = [
  ["photosynthesis", 0],
  ["toxic", 4],
  ["tumorSpeed", 6],
  ["freedom", 8],
];
const COST = { stemCell: 25, immuneCell: 15, tumorCell: 75, purificationCell: 50, siegeCell: 75 };

export function onTick(state, memory) {
  const actions = [];
  observe(state, memory);
  const stems = state.myUnits.filter((u) => u.type === "stemCell");
  const immune = state.myUnits.filter((u) => u.type === "immuneCell");
  const tumors = state.myBases;
  const home = state.myBase;
  const enemyBase = enemyBasePos(state);
  const zoneMid = { x: Math.round(state.zone.x), y: Math.round(state.zone.y) };
  // The exact center can be a wall: aim at the nearest open tile to it.
  const center = (memory.center = freeTileNear(state, memory, zoneMid, 0) || memory.center || zoneMid);
  const late = state.tick >= state.zone.shrinkStartTick - 10;
  const bank = { energy: state.energy, crystal: state.crystal };
  const used = new Set(); // units that already have an action this tick

  // ---------------------------------------------------------------- upgrades
  for (const [up, army] of UPGRADE_ORDER) {
    if (state.myUpgrades[up]) continue;
    const cost = UPGRADE_COSTS[up];
    if (immune.length >= army && bank.crystal >= cost.crystal && bank.energy >= cost.energy) {
      actions.push({ type: "upgrade", upgrade: up });
      bank.crystal -= cost.crystal;
      bank.energy -= cost.energy;
    }
    break; // buy strictly in order
  }

  // ---------------------------------------------------------------- roles
  memory.role = memory.role || {};
  const alive = new Set(stems.map((u) => u.id));
  for (const id of Object.keys(memory.role)) if (!alive.has(Number(id))) delete memory.role[id];
  const count = (r) => stems.filter((u) => memory.role[u.id] === r).length;
  for (const u of stems) {
    if (memory.role[u.id]) continue;
    memory.role[u.id] = count("energy") >= 3 && count("crystal") < CRYSTAL_WORKERS ? "crystal" : "energy";
  }

  // ---------------------------------------------------------------- where to grow a Tumor Cell
  memory.grown = memory.grown || 0;
  const near = (p, r) => tumors.some((t) => distance(t, p) <= r);
  let seedSite = null;
  let seedKind = null;
  if (!late && state.tick >= CENTER_TUMOR_TICK && !near(center, 5)) {
    seedSite = freeTileNear(state, memory, center, 1);
    seedKind = "center";
  } else if (!late && state.tick >= SIEGE_TICK && state.myUpgrades.tumorSpeed && !memory.siegeTumor) {
    // ~12 tiles from the enemy base on the straight line home → enemy: Siege Cells fit between.
    const d = Math.max(Math.abs(enemyBase.x - home.x), Math.abs(enemyBase.y - home.y));
    const k = Math.max(0, (d - 12) / d);
    seedSite = freeTileNear(state, memory, { x: home.x + (enemyBase.x - home.x) * k, y: home.y + (enemyBase.y - home.y) * k }, 0);
    seedKind = "siege";
  } else if (!late && memory.grown < MAX_CRYSTAL_TUMORS) {
    const crystal = knownNodes(memory, "crystal").filter((n) => !near(n, 6)).sort((a, b) => distance(a, home) - distance(b, home) || a.id - b.id)[0];
    if (crystal) {
      seedSite = freeTileNear(state, memory, crystal, 2);
      seedKind = "crystal";
    }
  }
  if (seedSite && count("seed") === 0 && stems.length >= 4) {
    const s = stems.filter((u) => memory.role[u.id] === "energy").sort((a, b) => distance(a, seedSite) - distance(b, seedSite) || a.id - b.id)[0];
    if (s) memory.role[s.id] = "seed";
  }
  for (const u of stems) {
    if (memory.role[u.id] !== "seed") continue;
    used.add(u.id);
    if (!seedSite) {
      memory.role[u.id] = "energy";
      used.delete(u.id);
    } else if (distance(u, seedSite) === 0) {
      if (bank.energy >= COST.tumorCell) {
        actions.push({ type: "transform", unitId: u.id });
        bank.energy -= COST.tumorCell;
        if (seedKind === "crystal") memory.grown++;
        if (seedKind === "siege") memory.siegeTumor = { x: u.x, y: u.y };
      }
    } else {
      actions.push(go(state, memory, u, seedSite));
    }
  }
  // Forget the siege Tumor Cell once it dies, so we grow another.
  if (memory.siegeTumor && !tumors.some((t) => t.x === memory.siegeTumor.x && t.y === memory.siegeTumor.y) && state.tick % 25 === 0) {
    memory.siegeTumor = null;
  }

  // ---------------------------------------------------------------- spawning (one per tick)
  const wantStems = late ? 0 : ENERGY_WORKERS + CRYSTAL_WORKERS + (seedSite ? 1 : 0);
  if (stems.length < wantStems && bank.energy >= COST.stemCell) {
    actions.push({ type: "spawn", unit: "stemCell", baseId: home.id });
    bank.energy -= COST.stemCell;
  } else if (state.myUpgrades.photosynthesis && bank.crystal >= COST.immuneCell + nextUpgradeReserve(state, immune.length) && state.myUnits.length < state.unitCap) {
    // Spawn at the Tumor Cell nearest the enemy so the army gathers forward.
    const front = tumors.slice().sort((a, b) => distance(a, enemyBase) - distance(b, enemyBase) || a.id - b.id)[0];
    actions.push({ type: "spawn", unit: "immuneCell", baseId: front.id });
    bank.crystal -= COST.immuneCell;
  }

  // ---------------------------------------------------------------- buildings
  const mine = (t) => state.myStructures.filter((s) => s.type === t);
  const jobs = [];
  if (!late && state.tick >= 35 && mine("purificationCell").length === 0) {
    const toward = { x: Math.sign(enemyBase.x - home.x), y: Math.sign(enemyBase.y - home.y) };
    const site = freeTileNear(state, memory, { x: home.x + toward.x * 2, y: home.y + toward.y * 2 }, 0);
    if (site) jobs.push({ structure: "purificationCell", site });
  }
  if (!late && memory.siegeTumor && mine("siegeCell").length < SIEGE_CELLS) {
    // Within 6 of the enemy base, as close to our siege Tumor Cell as possible.
    const st = memory.siegeTumor;
    const d = Math.max(Math.abs(enemyBase.x - st.x), Math.abs(enemyBase.y - st.y));
    const k = Math.max(0, (d - 5) / Math.max(1, d));
    const site = freeTileNear(state, memory, { x: st.x + (enemyBase.x - st.x) * k, y: st.y + (enemyBase.y - st.y) * k }, 0, (p) => distance(p, st) <= 16);
    if (site) jobs.push({ structure: "siegeCell", site });
  }
  for (const job of jobs.slice(0, 1)) {
    if (bank.energy < COST[job.structure]) break;
    const builder = stems
      .filter((u) => !used.has(u.id) && memory.role[u.id] === "energy")
      .sort((a, b) => distance(a, job.site) - distance(b, job.site) || a.id - b.id)[0];
    if (!builder) break;
    used.add(builder.id);
    const d = distance(builder, job.site);
    if (d === 1) {
      actions.push({ type: "build", unitId: builder.id, structure: job.structure, x: job.site.x, y: job.site.y });
      bank.energy -= COST[job.structure];
    } else if (d === 0) actions.push(go(state, memory, builder, home));
    else actions.push(go(state, memory, builder, job.site));
  }

  // ---------------------------------------------------------------- Stem Cells: gather
  for (const u of stems) {
    if (used.has(u.id)) continue;
    if (late && !inSafeZone(state, u, 4)) {
      const t = nearestOf(u, tumors);
      if (u.cargo.energy + u.cargo.crystal > 0 && t && distance(u, t) === 1) actions.push({ type: "deposit", unitId: u.id });
      else actions.push(go(state, memory, u, center));
      continue;
    }
    const a = gather(state, memory, u, memory.role[u.id] === "crystal" ? "crystal" : "energy");
    if (a) actions.push(a);
  }

  // ---------------------------------------------------------------- Immune Cells
  const threat = closestEnemyUnit(state, tumors, DEFENSE_RADIUS);
  if (!memory.attacking && state.myUpgrades.freedom && immune.length >= ATTACK_SIZE) memory.attacking = true;
  if (memory.attacking && immune.length <= RETREAT_SIZE) memory.attacking = false;
  const front = tumors.slice().sort((a, b) => distance(a, enemyBase) - distance(b, enemyBase) || a.id - b.id)[0] || home;
  // Idle Immune Cells wait 4 tiles in front of the forward Tumor Cell, never on top of it: a crowd around a
  // Tumor Cell blocks the Stem Cells that deposit there.
  const fd = Math.max(1, distance(front, enemyBase));
  const rally = { x: Math.round(front.x + ((enemyBase.x - front.x) * 4) / fd), y: Math.round(front.y + ((enemyBase.y - front.y) * 4) / fd) };
  const targets = state.visibleEnemies;
  for (const u of immune) {
    const inRange = targets.filter((e) => distance(u, e) <= u.range);
    if (inRange.length) {
      // Units first (the dangerous ones), then bases, then other buildings; lowest HP first.
      const rank = (e) => (e.kind === "unit" ? (e.type === "worker" || e.type === "stemCell" ? 1 : 0) : e.kind === "base" ? 2 : 3);
      inRange.sort((a, b) => rank(a) - rank(b) || a.hp - b.hp || a.id - b.id);
      actions.push({ type: "attack", unitId: u.id, targetId: inRange[0].id });
      continue;
    }
    let target;
    if (threat) target = threat;
    else if (memory.attacking) target = knownEnemyBase(memory) || enemyBase;
    else target = rally;
    if (late && !inSafeZone(state, u, 1)) target = center;
    actions.push(go(state, memory, u, target));
  }

  return actions;
}

// ==================================================================== helpers

/** Crystal kept back for the next upgrade once the army is big enough for it, so Immune Cells don't eat it all. */
function nextUpgradeReserve(state, armySize) {
  const next = UPGRADE_ORDER.find(([up]) => !state.myUpgrades[up]);
  return next && armySize >= next[1] ? UPGRADE_COSTS[next[0]].crystal : 0;
}

function observe(state, memory) {
  rememberMap(state, memory);
  memory.nodes = memory.nodes || {};
  for (const n of state.visibleNodes) memory.nodes[n.id] = { id: n.id, type: n.type, x: n.x, y: n.y, amount: n.amount };
  memory.enemyBases = memory.enemyBases || {};
  for (const e of state.visibleEnemies) if (e.kind === "base") memory.enemyBases[e.id] = { x: e.x, y: e.y };
  // Forget enemy bases we can see are gone.
  const visible = new Set(state.visibleTiles.map((t) => t.y * state.mapSize + t.x));
  const seen = new Set(state.visibleEnemies.filter((e) => e.kind === "base").map((e) => e.id));
  for (const [id, b] of Object.entries(memory.enemyBases)) if (visible.has(b.y * state.mapSize + b.x) && !seen.has(Number(id))) delete memory.enemyBases[id];
  memory.last = memory.last || {};
  memory.stuck = memory.stuck || {};
  for (const u of state.myUnits) {
    const p = memory.last[u.id];
    memory.stuck[u.id] = p && p.x === u.x && p.y === u.y ? (memory.stuck[u.id] || 0) + 1 : 0;
  }
  memory.last = {};
  memory.assign = memory.assign || {};
  const alive = new Set(state.myUnits.map((u) => u.id));
  for (const k of Object.keys(memory.assign)) if (!alive.has(Number(k))) delete memory.assign[k];
  for (const k of Object.keys(memory.stuck)) if (!alive.has(Number(k))) delete memory.stuck[k];
}

function knownEnemyBase(memory) {
  return Object.values(memory.enemyBases || {})[0] || null;
}

function knownNodes(memory, type) {
  return Object.values(memory.nodes || {}).filter((n) => n.type === type && n.amount >= 5);
}

function nearestOf(p, list) {
  let best = null;
  for (const x of list) if (!best || distance(p, x) < distance(p, best) || (distance(p, x) === distance(p, best) && x.id < best.id)) best = x;
  return best;
}

/** Move toward a target; when blocked, re-path around units, then wiggle. */
function go(state, memory, u, target) {
  memory.last[u.id] = { x: u.x, y: u.y };
  const to = { x: Math.round(target.x), y: Math.round(target.y) };
  const stuck = memory.stuck[u.id] || 0;
  if (stuck >= 2) {
    const avoid = [...state.myUnits.filter((o) => o.id !== u.id), ...state.visibleEnemies.filter((e) => e.kind === "unit")];
    const path = pathTo(state, u, to, { map: memory.map, avoid });
    if (path.length && stuck < 6) return { type: "move", unitId: u.id, dir: path[0].dir };
    return { type: "move", unitId: u.id, dir: "NESW"[(u.id + state.tick) % 4] };
  }
  return { type: "moveTo", unitId: u.id, x: to.x, y: to.y };
}

/** Harvest from an assigned node of `type` and deposit at the nearest Tumor Cell; search if none is known. */
function gather(state, memory, u, type) {
  const carried = u.cargo.energy + u.cargo.crystal;
  const node = assignNode(state, memory, u, type);
  const drop = nearestOf(u, state.myBases) || state.myBase;
  const ticksLeft = state.maxTicks - state.tick;
  if (carried >= u.cargoCapacity || (carried > 0 && !node) || (carried > 0 && ticksLeft <= distance(u, drop) + 3)) {
    if (distance(u, drop) === 1) return { type: "deposit", unitId: u.id };
    return go(state, memory, u, drop);
  }
  if (!node) return type === "crystal" ? explore(state, memory, u) : gather(state, memory, u, "crystal");
  if (distance(u, node) === 1) return { type: "harvest", unitId: u.id, nodeId: node.id };
  return go(state, memory, u, node);
}

function assignNode(state, memory, u, type) {
  const cur = memory.assign[u.id] && memory.nodes[memory.assign[u.id]];
  if (cur && cur.type === type && cur.amount >= 5) return cur;
  const load = {};
  for (const id of Object.values(memory.assign)) load[id] = (load[id] || 0) + 1;
  const cap = type === "energy" ? 2 : 3;
  const options = knownNodes(memory, type)
    .filter((n) => (load[n.id] || 0) < cap)
    .map((n) => ({ n, key: [(load[n.id] || 0), distance(n, nearestOf(n, state.myBases) || state.myBase), distance(n, u), n.id] }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.key[3] - b.key[3]);
  if (!options.length) {
    delete memory.assign[u.id];
    return null;
  }
  memory.assign[u.id] = options[0].n.id;
  return options[0].n;
}

/**
 * Crystal can be anywhere: visit unseen points of an 8-tile grid, closest to home first (so our own half
 * is searched before the enemy's), spreading searchers over different points.
 */
function explore(state, memory, u) {
  const size = state.mapSize;
  const map = memory.map || "";
  const home = state.startingBase;
  memory.seek = memory.seek || {};
  const alive = new Set(state.myUnits.map((o) => o.id));
  for (const k of Object.keys(memory.seek)) if (!alive.has(Number(k)) || Number(k) === u.id) delete memory.seek[k];
  const taken = new Set(Object.values(memory.seek).map((p) => p.x + "," + p.y));
  let best = null;
  let bestKey = null;
  for (let y = 4; y < size; y += 8) {
    for (let x = 4; x < size; x += 8) {
      if (map[y * size + x] !== "?") continue;
      const p = { x, y };
      const key = [taken.has(x + "," + y) ? 1 : 0, Math.abs(x - home.x) + Math.abs(y - home.y), distance(u, p)];
      const better = !bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])));
      if (better) {
        best = p;
        bestKey = key;
      }
    }
  }
  if (best) memory.seek[u.id] = best;
  return go(state, memory, u, best || memory.center || { x: Math.round(state.zone.x), y: Math.round(state.zone.y) });
}

/** A known, empty floor tile at Chebyshev distance `min`..min+4 from `p` (closest first), or null. */
function freeTileNear(state, memory, p, min, ok = () => true) {
  const size = state.mapSize;
  const map = memory.map || "";
  const cx = Math.round(p.x);
  const cy = Math.round(p.y);
  const taken = new Set([...state.myBases, ...state.myStructures, ...state.visibleEnemies.filter((e) => e.kind !== "unit")].map((o) => o.y * size + o.x));
  for (let r = min; r <= min + 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const i = y * size + x;
        if (map[i] !== "." || taken.has(i) || !ok({ x, y })) continue;
        return { x, y };
      }
    }
  }
  return null;
}

function closestEnemyUnit(state, around, radius) {
  let best = null;
  let bestD = Infinity;
  for (const e of state.visibleEnemies) {
    if (e.kind !== "unit") continue;
    for (const t of around) {
      const d = distance(e, t);
      if (d <= radius && (d < bestD || (d === bestD && e.id < best.id))) {
        best = e;
        bestD = d;
      }
    }
  }
  return best;
}
