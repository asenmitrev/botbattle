// Economy first, a scout, crystal, turrets and upgrades; defends, then attacks in force after ~tick 200.
import {
  assignNode,
  crystalWorkerAct,
  enemyBasePos,
  explore,
  exploreUnknown,
  fighterAct,
  go,
  knownNodes,
  nearestEnemyUnit,
  observe,
  searchWaypoints,
  workerAct,
} from "./lib/common.js";
import { distance, inSafeZone, manhattan } from "./lib/helpers.js";

const ENERGY_WORKERS = 8;
const CRYSTAL_WORKERS = 3;
const TURRETS = 2;
const ATTACK_TICK = 200;
const ATTACK_SIZE = 6;
const DEFENSE_RADIUS = 10;

/** @type {import("./lib/api").OnTick} */
export function onTick(state, memory) {
  observe(state, memory);
  memory.role = memory.role || {};
  const actions = [];
  const mine = (t) => state.myUnits.filter((u) => u.type === t);
  const workers = mine("worker");
  const fighters = mine("fighter");
  const scouts = mine("scout");
  const turrets = state.myStructures.filter((s) => s.type === "turret");
  const base = state.myBase;
  const enemyBase = enemyBasePos(state);
  const center = { x: Math.round(state.zone.x), y: Math.round(state.zone.y) };
  const late = state.tick >= state.zone.shrinkStartTick - 10;

  // ---- roles
  const roleCount = (r) => workers.filter((u) => memory.role[u.id] === r).length;
  for (const u of workers) {
    if (memory.role[u.id]) continue;
    memory.role[u.id] = roleCount("energy") >= 3 && roleCount("crystal") < CRYSTAL_WORKERS ? "crystal" : "energy";
  }

  // ---- spending (one spawn per tick; upgrades are independent)
  let energy = state.energy;
  let crystal = state.crystal;
  const wantTurret = turrets.length < TURRETS && state.tick >= 40 && !late;
  const reserve = wantTurret ? 100 : 0;
  const spawn = (unit, e, c) => {
    actions.push({ type: "spawn", unit });
    energy -= e;
    crystal -= c;
  };
  if (!late && workers.length < ENERGY_WORKERS + CRYSTAL_WORKERS && energy >= 50 + (workers.length >= 5 ? reserve : 0)) {
    spawn("worker", 50, 0);
  } else if (!late && scouts.length < 1 && state.tick >= 15 && energy >= 30) {
    spawn("scout", 30, 0);
  } else if (fighters.length + 0 < state.unitCap && energy >= 60 + reserve && crystal >= 15) {
    // Once we have a few fighters, keep enough crystal to make them all turret-immune.
    const savingFor = fighters.length >= 3 && !state.myUpgrades.fighter;
    if (!savingFor || crystal >= 15 + 20) spawn("fighter", 60, 15);
  }
  // Upgrades are per type: one purchase covers every current and future fighter/scout.
  if (fighters.length >= 3 && !state.myUpgrades.fighter && crystal >= 20) {
    actions.push({ type: "upgrade", upgrade: "fighter" });
    crystal -= 20;
  }
  if (scouts.length > 0 && !state.myUpgrades.scout && crystal >= 15) {
    actions.push({ type: "upgrade", upgrade: "scout" });
    crystal -= 15;
  }

  // ---- turret building
  memory.sites = memory.sites || pickTurretSites(state, memory, TURRETS);
  let builder = null;
  if (wantTurret && energy >= 100) {
    const site = memory.sites.find((s) => !state.myStructures.some((x) => x.x === s.x && x.y === s.y));
    if (site) {
      builder = workers
        .filter((u) => memory.role[u.id] === "energy")
        .sort((a, b) => manhattan(a, site) - manhattan(b, site) || a.id - b.id)[0];
      if (builder) {
        const d = distance(builder, site);
        if (d === 1) actions.push({ type: "build", unitId: builder.id, structure: "turret", x: site.x, y: site.y });
        else if (d === 0) actions.push(go(state, memory, builder, base));
        else actions.push(go(state, memory, builder, site));
      }
    }
  }

  // ---- workers
  for (const u of workers) {
    if (u === builder) continue;
    if (late && !inSafeZone(state, u, 4)) {
      // Bank what we carry if we are home, otherwise head for the safe zone.
      if (u.cargo.energy + u.cargo.crystal > 0 && distance(u, base) === 1) actions.push({ type: "deposit", unitId: u.id });
      else actions.push(go(state, memory, u, center));
      continue;
    }
    const a =
      memory.role[u.id] === "crystal"
        ? crystalWorkerAct(state, memory, u)
        : workerAct(state, memory, u, assignNode(state, memory, u, "energy", 3));
    if (a) actions.push(a);
  }

  // ---- scouts: find crystal (it can be anywhere), then watch the enemy approach from the center
  for (const u of scouts) {
    if (late && !inSafeZone(state, u, 3)) {
      actions.push(go(state, memory, u, center));
      continue;
    }
    if (knownNodes(memory, "crystal").length === 0) {
      actions.push(exploreUnknown(state, memory, u, searchWaypoints(state)));
      continue;
    }
    if (memory.seek) delete memory.seek[u.id];
    const wps = [center, { x: Math.round((center.x + enemyBase.x) / 2), y: Math.round((center.y + enemyBase.y) / 2) }, center];
    actions.push(explore(state, memory, u, wps));
  }

  // ---- fighters
  const threat = nearestEnemyUnit(state, base, (e) => distance(e, base) <= DEFENSE_RADIUS);
  if (!memory.attacking && state.tick >= ATTACK_TICK && fighters.length >= ATTACK_SIZE) memory.attacking = true;
  if (memory.attacking && fighters.length <= 2) memory.attacking = false;
  const rally = { x: Math.round((base.x * 2 + center.x) / 3), y: Math.round((base.y * 2 + center.y) / 3) };
  for (const u of fighters) {
    let target;
    const close = nearestEnemyUnit(state, u, (e) => distance(e, u) <= 4);
    if (close) target = close;
    else if (threat && !memory.attacking) target = threat;
    else if (memory.attacking) target = enemyBase;
    else target = late ? center : rally;
    if (late && !inSafeZone(state, u, 1) && !close) target = center;
    const a = fighterAct(state, memory, u, target, memory.attacking ? "base" : "units");
    if (a) actions.push(a);
  }
  return actions;
}

/** Free floor tiles 3 steps from base, toward the enemy, not next to nodes. */
function pickTurretSites(state, memory, n) {
  const size = state.mapSize;
  const base = state.myBase;
  const enemy = enemyBasePos(state);
  const map = memory.map || "";
  const cands = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = base.x + dx;
      const y = base.y + dy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 3) continue;
      if (x < 0 || y < 0 || x >= size || y >= size || map[y * size + x] !== ".") continue;
      let nearNode = false;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const c = map[(y + oy) * size + (x + ox)];
          if (c === "E" || c === "C") nearNode = true;
        }
      if (nearNode) continue;
      cands.push({ x, y });
    }
  }
  cands.sort((a, b) => manhattan(a, enemy) - manhattan(b, enemy) || a.y - b.y || a.x - b.x);
  const out = [];
  for (const c of cands) {
    if (out.every((o) => distance(o, c) >= 3)) out.push(c);
    if (out.length >= n) break;
  }
  return out;
}
