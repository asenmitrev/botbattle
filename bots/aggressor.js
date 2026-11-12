// Aggressor: lean economy, rush crystal, then fighters in waves. The army first seizes the crystal
// field in the center (starving the enemy of fighters), then assaults the enemy base in force.
// Self-contained (no imports) so it can be pasted into the playground.

const ENERGY_WORKERS = 3;
const CRYSTAL_WORKERS = 3;
const SQUAD_SIZE = 4; // first wave leaves when this many fighters are ready
const ASSAULT_SIZE = 7; // army size that triggers the base assault
const ASSAULT_TICK = 230; // ...or this tick with at least 4 fighters
const HOME_TURRETS = 2;

/** @type {import("./lib/api").OnTick} */
export function onTick(state, memory) {
  const actions = [];
  const N = state.mapSize - 1;
  const base = state.myBase;
  const enemyBase = { x: N - base.x, y: N - base.y };
  const center = { x: Math.round(state.zone.x), y: Math.round(state.zone.y) };
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const manh = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const late = state.tick >= state.zone.shrinkStartTick - 5;

  // ---------------------------------------------------------------- memory
  memory.nodes = memory.nodes || {};
  for (const n of state.visibleNodes) memory.nodes[n.id] = { id: n.id, type: n.type, x: n.x, y: n.y, amount: n.amount };
  memory.role = memory.role || {};
  const last = memory.last || {};
  memory.last = {};
  memory.wp = memory.wp || {};

  /** moveTo with a sidestep when the unit didn't move last tick (crowds gridlock otherwise). */
  const go = (u, p) => {
    const prev = last[u.id];
    memory.last[u.id] = { x: u.x, y: u.y };
    if (prev && prev.x === u.x && prev.y === u.y && (state.tick + u.id) % 3 !== 0) {
      return { type: "move", unitId: u.id, dir: "NESW"[(state.tick + u.id) % 4] };
    }
    return { type: "moveTo", unitId: u.id, x: p.x, y: p.y };
  };
  const nodesOf = (type) => Object.values(memory.nodes).filter((n) => n.type === type && n.amount >= 5);

  const workers = state.myUnits.filter((u) => u.type === "worker");
  const fighters = state.myUnits.filter((u) => u.type === "fighter");

  // ---------------------------------------------------------------- roles & spending
  const count = (r) => workers.filter((u) => memory.role[u.id] === r).length;
  for (const u of workers) {
    if (!memory.role[u.id]) memory.role[u.id] = count("energy") < ENERGY_WORKERS ? "energy" : "crystal";
  }
  if (!late && workers.length < ENERGY_WORKERS + CRYSTAL_WORKERS && state.energy >= 50) {
    actions.push({ type: "spawn", unit: "worker" });
  } else if (state.energy >= 60 && state.crystal >= 15) {
    actions.push({ type: "spawn", unit: "fighter" });
  }
  // Weapons (+50% damage) as soon as there is an army; armor once the army is established.
  if (!state.upgrades.weapons && fighters.length >= 3 && state.crystal >= 40) {
    actions.push({ type: "upgrade", upgrade: "weapons" });
  } else if (state.upgrades.weapons && !state.upgrades.armor && fighters.length >= 5 && state.crystal >= 40) {
    actions.push({ type: "upgrade", upgrade: "armor" });
  }

  // Surplus energy (crystal is the real bottleneck) buys home turrets.
  const turrets = state.myStructures.filter((x) => x.type === "turret");
  let builder = null;
  if (!late && turrets.length < HOME_TURRETS && state.energy >= 220 && state.tick >= 50) {
    const taken = new Set();
    for (const t of state.visibleTiles) if (t.type !== "floor") taken.add(t.x + "," + t.y);
    for (const o of [...state.myUnits, ...state.myStructures, ...state.visibleEnemies, base]) taken.add(o.x + "," + o.y);
    const near = (p) => Object.values(memory.nodes).some((n) => cheb(n, p) <= 1);
    // Sites 3 tiles out from the base, toward the center, spaced apart.
    const sites = [];
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const p = { x: base.x + dx, y: base.y + dy };
        if (cheb(p, base) !== 3 || p.x < 0 || p.y < 0 || p.x > N || p.y > N || taken.has(p.x + "," + p.y) || near(p)) continue;
        if (turrets.some((t) => cheb(t, p) < 3)) continue;
        sites.push(p);
      }
    sites.sort((a, b) => manh(a, center) - manh(b, center) || a.y - b.y || a.x - b.x);
    const site = sites[0];
    if (site) {
      builder = workers.filter((w) => memory.role[w.id] === "energy").sort((a, b) => manh(a, site) - manh(b, site) || a.id - b.id)[0];
      if (builder) {
        const d = cheb(builder, site);
        actions.push(d === 1 ? { type: "build", unitId: builder.id, structure: "turret", x: site.x, y: site.y } : go(builder, d === 0 ? base : site));
      }
    }
  }

  // ---------------------------------------------------------------- workers
  const exploreCenter = [
    center,
    { x: center.x + (base.x < center.x ? -5 : 5), y: center.y + (base.y < center.y ? -5 : 5) },
    { x: center.x - 6, y: center.y + 6 },
    { x: center.x + 6, y: center.y - 6 },
  ];
  const assigned = {};
  const inZone = (p, margin) => {
    const dx = p.x - state.zone.x;
    const dy = p.y - state.zone.y;
    return dx * dx + dy * dy <= (state.zone.nextRadius - margin) ** 2;
  };
  for (const u of workers) {
    if (u === builder) continue;
    const carried = u.cargo.energy + u.cargo.crystal;
    if (late && !inZone(u, 3)) {
      // The zone is coming: bank cargo if home, then shelter near the center.
      actions.push(carried > 0 && cheb(u, base) === 1 ? { type: "deposit", unitId: u.id } : go(u, center));
      continue;
    }
    const type = memory.role[u.id] === "crystal" ? "crystal" : "energy";
    const choices = nodesOf(type).sort((a, b) => (assigned[a.id] || 0) - (assigned[b.id] || 0) || manh(a, base) - manh(b, base));
    const node = choices[0];
    if (node) assigned[node.id] = (assigned[node.id] || 0) + 1;
    const ticksLeft = state.maxTicks - state.tick;
    if (carried >= u.cargoCapacity || (carried > 0 && (!node || ticksLeft < manh(u, base) + 3))) {
      actions.push(cheb(u, base) === 1 ? { type: "deposit", unitId: u.id } : go(u, base));
    } else if (node) {
      actions.push(cheb(u, node) === 1 ? { type: "harvest", unitId: u.id, nodeId: node.id } : go(u, node));
    } else if (type === "crystal") {
      // Crystal not found yet: sweep the center.
      let i = memory.wp[u.id] || 0;
      if (cheb(u, exploreCenter[i % exploreCenter.length]) <= 2) i++;
      memory.wp[u.id] = i;
      actions.push(go(u, exploreCenter[i % exploreCenter.length]));
    }
  }

  // ---------------------------------------------------------------- fighters
  const enemies = state.visibleEnemies;
  const enemyUnits = enemies.filter((e) => e.kind === "unit");
  // Waves: new fighters gather at the rally point; once SQUAD_SIZE are there they all go together.
  const rally = { x: Math.round((base.x * 2 + center.x) / 3), y: Math.round((base.y * 2 + center.y) / 3) };
  const alive = new Set(fighters.map((f) => f.id));
  memory.wave = (memory.wave || []).filter((id) => alive.has(id));
  const home = fighters.filter((f) => !memory.wave.includes(f.id));
  const atRally = home.filter((f) => cheb(f, rally) <= 3);
  if (atRally.length >= SQUAD_SIZE || (memory.wave.length > 0 && atRally.length >= 2) || late) {
    for (const f of atRally) memory.wave.push(f.id);
  }

  // Objective: hold the crystal field (fights on neutral ground), then assault the base.
  const wave = fighters.filter((f) => memory.wave.includes(f.id));
  const crystals = Object.values(memory.nodes).filter((n) => n.type === "crystal");
  const hold = crystals.length
    ? {
        x: Math.round(crystals.reduce((t, n) => t + n.x, 0) / crystals.length),
        y: Math.round(crystals.reduce((t, n) => t + n.y, 0) / crystals.length),
      }
    : center;
  if (!memory.assault && (wave.length >= ASSAULT_SIZE || (state.tick >= ASSAULT_TICK && wave.length >= 4))) memory.assault = true;
  if (memory.assault && wave.length <= 1 && state.tick < ASSAULT_TICK) memory.assault = false;
  const objective = memory.assault ? enemyBase : hold;
  // Cohesion: the rear of the wave sets the pace.
  const rear = Math.max(0, ...wave.map((f) => manh(f, objective)));

  // Fighters first (they hit back), then turrets, then workers/scouts, then the base, walls last.
  const rank = (e) => (e.kind === "unit" ? (e.type === "fighter" ? 0 : 2) : e.type === "turret" ? 1 : e.kind === "base" ? 3 : 4);
  const intruder = enemyUnits.filter((e) => cheb(e, base) <= 9).sort((a, b) => cheb(a, base) - cheb(b, base))[0];
  for (const u of fighters) {
    // 1. Hit the best adjacent target: fighters, then workers, then turrets, then the base. Focus low HP.
    const adj = enemies.filter((e) => cheb(e, u) <= 1).sort((a, b) => rank(a) - rank(b) || a.hp - b.hp || a.id - b.id);
    if (adj.length) {
      actions.push({ type: "attack", unitId: u.id, targetId: adj[0].id });
      continue;
    }
    // 2. Close in on nearby enemy units (wider net while holding the center, tight while assaulting).
    const reach = memory.wave.includes(u.id) && !memory.assault ? 6 : 3;
    const prey = enemyUnits.filter((e) => cheb(e, u) <= reach && (reach === 3 || cheb(e, hold) <= 9)).sort((a, b) => cheb(a, u) - cheb(b, u) || a.hp - b.hp || a.id - b.id)[0];
    if (prey) {
      actions.push(go(u, prey));
      continue;
    }
    const inWave = memory.wave.includes(u.id);
    if (!inWave) {
      // 3. Home guard: defend the base, otherwise gather at the rally point.
      actions.push(go(u, intruder || rally));
      continue;
    }
    // 4. Wave: advance, but front-runners hold until the rear catches up.
    if (wave.length > 1 && manh(u, objective) < rear - 4) continue;
    actions.push(go(u, objective));
  }
  return actions;
}
