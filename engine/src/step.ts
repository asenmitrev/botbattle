import { BUILD_TYPES, CONFIG, UNIT_TYPES, UPGRADE_TYPES, type BuildType, type UnitType, type UpgradeType } from "./config.js";
import { chebyshev, DIRS, DIR_ORDER_P1, DIR_ORDER_P2, dist2, distanceField, inBounds } from "./geometry.js";
import {
  cargoCapacity,
  cloneState,
  computeScore,
  findSpawnTile,
  makeUnit,
  occupancy,
  unitSpeed,
  zoneCenter,
  zoneRadius,
} from "./state.js";
import { TILE, type Action, type Dir, type GameEvent, type GameState, type MatchResult, type PlayerId, type StepResult, type Unit } from "./types.js";
import { computeVisibility } from "./vision.js";

type UnitAction = Extract<Action, { unitId: number }>;

interface Intents {
  unit: Map<number, UnitAction>;
  spawn: Extract<Action, { type: "spawn" }> | null;
  upgrades: UpgradeType[];
}

const PLAYERS: readonly PlayerId[] = [1, 2];

/**
 * Advance the simulation by one tick. Pure: the input state is not mutated.
 * `actionsP1` / `actionsP2` are untrusted values straight from the bots.
 */
export function step(prev: GameState, actionsP1: unknown, actionsP2: unknown): StepResult {
  if (prev.result) throw new Error("match is already over");
  const state = cloneState(prev);
  const events: GameEvent[] = [];

  // Phase 1: collect & validate actions.
  const intents: [Intents, Intents] = [
    collectIntents(state, 1, actionsP1, events),
    collectIntents(state, 2, actionsP2, events),
  ];

  // Phase 2: upgrades & spawns.
  for (const p of PLAYERS) applyUpgrades(state, p, intents[p - 1]!, events);
  for (const p of PLAYERS) applySpawn(state, p, intents[p - 1]!, events);

  // Phase 3: movement.
  resolveMovement(prev, state, intents, events);

  // Phase 4: harvest, deposit, build.
  resolveHarvest(state, intents, events);
  resolveDeposit(state, intents, events);
  resolveBuild(state, intents, events);

  // Phase 5: combat.
  resolveCombat(state, intents, events);

  // Phase 6: remove dead, check bases.
  removeDead(state, events);
  const previousHp = new Map(prev.bases.map((b) => [b.id, b.hp]));
  for (const b of state.bases) {
    if (b.hp <= 0 && (previousHp.get(b.id) ?? CONFIG.base.hp) > 0) {
      events.push({ type: "base_destroyed", player: b.owner, baseId: b.id });
      events.push({ type: "death", id: b.id, kind: "base", owner: b.owner, x: b.x, y: b.y });
    }
  }
  const dead1 = !state.bases.some((b) => b.owner === 1 && b.hp > 0);
  const dead2 = !state.bases.some((b) => b.owner === 2 && b.hp > 0);
  if (dead1 || dead2) {
    const result = dead1 && dead2 ? endOfGameResult(state) : finishResult(state, dead1 ? 2 : 1, "base_destroyed");
    return finish(state, result, events);
  }

  // Phase 7: node regen, zone damage.
  for (const n of state.nodes) {
    const nc = CONFIG.nodes[n.type];
    if (nc.regen > 0) n.amount = Math.min(nc.max, n.amount + nc.regen);
  }
  applyZone(state, events);

  // Phase 8: vision is derived from state (see vision.ts), nothing stored.
  if (state.tick + 1 >= CONFIG.match.maxTicks) return finish(state, endOfGameResult(state), events);
  state.tick++;
  return { state, events };
}

function finish(state: GameState, result: MatchResult, events: GameEvent[]): StepResult {
  state.tick++;
  result.tick = state.tick;
  state.result = result;
  events.push({ type: "game_over", result });
  return { state, events };
}

function scores(state: GameState): [number, number] {
  return [computeScore(state, 1), computeScore(state, 2)];
}

function unitCounts(state: GameState): [number, number] {
  const c: [number, number] = [0, 0];
  for (const u of state.units) c[u.owner - 1]++;
  return c;
}

/** Time limit or both players lost all bases: living units, then score, then draw. */
function endOfGameResult(state: GameState): MatchResult {
  const s = scores(state);
  const n = unitCounts(state);
  if (n[0] !== n[1]) return { winner: n[0] > n[1] ? 1 : 2, reason: "units", scores: s, units: n, tick: state.tick };
  const winner = s[0] > s[1] ? 1 : s[1] > s[0] ? 2 : "draw";
  return { winner, reason: "score", scores: s, units: n, tick: state.tick };
}

function finishResult(state: GameState, winner: PlayerId, reason: MatchResult["reason"]): MatchResult {
  return { winner, reason, scores: scores(state), units: unitCounts(state), tick: state.tick };
}

/** Declare a forfeit (used by runners; not part of normal step resolution). */
export function forfeit(prev: GameState, loser: PlayerId): StepResult {
  const state = cloneState(prev);
  const result = finishResult(state, loser === 1 ? 2 : 1, "forfeit");
  state.result = result;
  return { state, events: [{ type: "game_over", result }] };
}

// ============================================================ phase 1

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function collectIntents(state: GameState, player: PlayerId, raw: unknown, events: GameEvent[]): Intents {
  const intents: Intents = { unit: new Map(), spawn: null, upgrades: [] };
  const invalid = (action: unknown, reason: string) => events.push({ type: "invalid_action", player, action, reason });
  if (raw === undefined || raw === null) return intents;
  if (!Array.isArray(raw)) {
    invalid(null, "bot returned a non-array");
    return intents;
  }
  const bc = CONFIG.bot;
  let list = raw as unknown[];
  if (list.length > bc.maxActionsPerTick) {
    invalid(null, `too many actions (${list.length}), only the first ${bc.maxActionsPerTick} are used`);
    list = list.slice(0, bc.maxActionsPerTick);
  }
  const size = state.map.size;
  const units = new Map<number, Unit>();
  for (const u of state.units) if (u.owner === player) units.set(u.id, u);
  let logs = 0;
  let marks = 0;

  for (const a of list) {
    if (!a || typeof a !== "object" || typeof (a as { type?: unknown }).type !== "string") {
      invalid(sanitize(a), "malformed action");
      continue;
    }
    const act = a as Record<string, unknown>;
    switch (act.type) {
      case "log": {
        if (++logs > bc.maxLogsPerTick) break;
        events.push({ type: "log", player, text: String(act.text).slice(0, bc.maxLogLength) });
        break;
      }
      case "mark": {
        if (!isInt(act.x) || !isInt(act.y) || !inBounds(size, act.x, act.y)) {
          invalid(sanitize(act), "mark position out of bounds");
          break;
        }
        if (++marks > bc.maxMarksPerTick) break;
        events.push({
          type: "mark",
          player,
          x: act.x,
          y: act.y,
          color: typeof act.color === "string" ? act.color.slice(0, 32) : "",
          label: typeof act.label === "string" ? act.label.slice(0, 64) : "",
        });
        break;
      }
      case "spawn": {
        if (!UNIT_TYPES.includes(act.unit as UnitType)) invalid(sanitize(act), "unknown unit type");
        else if (act.baseId !== undefined && (!isInt(act.baseId) || !state.bases.some((b) => b.id === act.baseId && b.owner === player && b.hp > 0))) {
          invalid(sanitize(act), "no such living base (or not yours)");
        } else if (intents.spawn !== null) invalid(sanitize(act), "only one spawn per tick");
        else intents.spawn = { type: "spawn", unit: act.unit as UnitType, ...(act.baseId !== undefined ? { baseId: act.baseId as number } : {}) };
        break;
      }
      case "upgrade": {
        const up = act.upgrade as UpgradeType;
        if (!UPGRADE_TYPES.includes(up)) invalid(sanitize(act), "unknown upgrade");
        else if (intents.upgrades.includes(up)) invalid(sanitize(act), "duplicate upgrade");
        else intents.upgrades.push(up);
        break;
      }
      case "move":
      case "moveTo":
      case "harvest":
      case "deposit":
      case "attack":
      case "build": {
        const reason = validateUnitAction(act, units, size);
        if (reason) {
          invalid(sanitize(act), reason);
          break;
        }
        const id = act.unitId as number;
        if (intents.unit.has(id)) {
          invalid(sanitize(act), "unit already has an action this tick");
          break;
        }
        intents.unit.set(id, normalizeUnitAction(act));
        break;
      }
      default:
        invalid(sanitize(act), "unknown action type");
    }
  }
  return intents;
}

function validateUnitAction(a: Record<string, unknown>, units: Map<number, Unit>, size: number): string | null {
  if (!isInt(a.unitId)) return "missing unitId";
  const u = units.get(a.unitId);
  if (!u) return "no such unit (or not yours)";
  const spec = CONFIG.units[u.type];
  switch (a.type) {
    case "move":
      return a.dir === "N" || a.dir === "S" || a.dir === "E" || a.dir === "W" ? null : "bad dir";
    case "moveTo":
      return isInt(a.x) && isInt(a.y) && inBounds(size, a.x, a.y) ? null : "target out of bounds";
    case "harvest":
      if (spec.harvest <= 0) return `${u.type} cannot harvest`;
      return isInt(a.nodeId) ? null : "missing nodeId";
    case "deposit":
      return spec.carry > 0 ? null : `${u.type} cannot carry`;
    case "attack":
      if (spec.damage <= 0) return `${u.type} cannot attack`;
      return isInt(a.targetId) ? null : "missing targetId";
    case "build":
      if (u.type !== "worker") return `${u.type} cannot build`;
      if (!BUILD_TYPES.includes(a.structure as BuildType)) return "unknown structure";
      return isInt(a.x) && isInt(a.y) && inBounds(size, a.x, a.y) ? null : "build position out of bounds";
  }
  return "unknown action type";
}

/** Copy only known fields so stored intents never alias bot objects. */
function normalizeUnitAction(a: Record<string, unknown>): UnitAction {
  const unitId = a.unitId as number;
  switch (a.type) {
    case "move":
      return { type: "move", unitId, dir: a.dir as Dir };
    case "moveTo":
      return { type: "moveTo", unitId, x: a.x as number, y: a.y as number };
    case "harvest":
      return { type: "harvest", unitId, nodeId: a.nodeId as number };
    case "deposit":
      return { type: "deposit", unitId };
    case "attack":
      return { type: "attack", unitId, targetId: a.targetId as number };
    default:
      return { type: "build", unitId, structure: a.structure as BuildType, x: a.x as number, y: a.y as number };
  }
}

/** JSON-safe, size-bounded copy of an arbitrary bot value for event logs. */
function sanitize(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    return s.length > 300 ? s.slice(0, 300) + "…" : JSON.parse(s);
  } catch {
    return String(v).slice(0, 300);
  }
}

// ============================================================ phase 2

function applyUpgrades(state: GameState, player: PlayerId, intents: Intents, events: GameEvent[]): void {
  const p = state.players[player - 1]!;
  for (const up of intents.upgrades) {
    const cost = CONFIG.upgrades[up].costCrystal;
    const action = { type: "upgrade", upgrade: up };
    if (p.upgrades[up]) events.push({ type: "invalid_action", player, action, reason: "already purchased" });
    else if (p.crystal < cost) events.push({ type: "invalid_action", player, action, reason: "not enough crystal" });
    else {
      p.crystal -= cost;
      p.upgrades[up] = true;
      events.push({ type: "upgrade", player, upgrade: up });
    }
  }
}

function applySpawn(state: GameState, player: PlayerId, intents: Intents, events: GameEvent[]): void {
  const action = intents.spawn;
  if (!action) return;
  const type = action.unit;
  const p = state.players[player - 1]!;
  const spec = CONFIG.units[type];
  const fail = (reason: string) => events.push({ type: "invalid_action", player, action, reason });
  const count = state.units.reduce((n, u) => n + (u.owner === player ? 1 : 0), 0);
  if (count >= CONFIG.match.unitCap) return void fail("unit cap reached");
  if (p.energy < spec.costEnergy || p.crystal < spec.costCrystal) return void fail("not enough resources");
  const tile = findSpawnTile(state, player, undefined, action.baseId);
  if (!tile) return void fail("no free tile next to base");
  p.energy -= spec.costEnergy;
  p.crystal -= spec.costCrystal;
  const u = makeUnit(state, player, type, tile);
  state.units.push(u);
  events.push({ type: "spawn", player, unitId: u.id, unit: type, x: u.x, y: u.y });
}

// ============================================================ phase 3

/**
 * Simultaneous movement in sub-steps. Sub-step k moves every unit with speed >= k.
 * Within a sub-step: moves into static obstacles fail; 2+ units targeting the
 * same tile all fail; a unit moving into an occupied tile succeeds only if the
 * occupant successfully moves away; cycles (including swaps) all fail.
 */
function resolveMovement(prev: GameState, state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  const size = state.map.size;
  const staticOcc = occupancy(state, false);
  const maxSpeed = state.units.reduce((max, u) => Math.max(max, unitSpeed(state, u.owner, u.type)), 0);

  // moveTo distance fields, cached per (player, target) for this tick. Paths use
  // terrain, bases and the structures the player could see at the start of the tick.
  const fieldCache = new Map<string, Int32Array>();
  const pathBlock: [Uint8Array, Uint8Array] = [pathBlocking(prev, 1), pathBlocking(prev, 2)];
  const field = (player: PlayerId, tx: number, ty: number) => {
    const key = `${player}:${tx},${ty}`;
    let f = fieldCache.get(key);
    if (!f) {
      const blocked = pathBlock[player - 1]!;
      f = distanceField(size, { x: tx, y: ty }, (i) => !blocked[i]);
      fieldCache.set(key, f);
    }
    return f;
  };

  const noPath = new Set<number>();
  for (let sub = 1; sub <= maxSpeed; sub++) {
    // Desired destination per mover, in ID order.
    const target = new Map<number, number>();
    const byId = new Map<number, Unit>();
    for (const u of state.units) {
      byId.set(u.id, u);
      if (unitSpeed(state, u.owner, u.type) < sub) continue;
      const act = intents[u.owner - 1]!.unit.get(u.id);
      if (!act || (act.type !== "move" && act.type !== "moveTo")) continue;
      let dir: Dir | null;
      if (act.type === "move") dir = act.dir;
      else {
        dir = stepToward(field(u.owner, act.x, act.y), size, u, u.owner === 1 ? DIR_ORDER_P1 : DIR_ORDER_P2, pathBlock[u.owner - 1]!);
        if (dir === null && !(u.x === act.x && u.y === act.y) && field(u.owner, act.x, act.y)[u.y * size + u.x] === -1) noPath.add(u.id);
      }
      if (!dir) continue;
      const nx = u.x + DIRS[dir].x;
      const ny = u.y + DIRS[dir].y;
      if (!inBounds(size, nx, ny) || staticOcc[ny * size + nx]) continue;
      target.set(u.id, ny * size + nx);
    }

    const contested = new Map<number, number>();
    for (const t of target.values()) contested.set(t, (contested.get(t) ?? 0) + 1);
    const occupant = new Map<number, number>();
    for (const u of state.units) occupant.set(u.y * size + u.x, u.id);

    // 0 unknown, 1 visiting, 2 ok, 3 fail
    const st = new Map<number, number>();
    const resolve = (id: number): boolean => {
      const s = st.get(id) ?? 0;
      if (s === 2) return true;
      if (s === 3 || s === 1) return false;
      const t = target.get(id);
      if (t === undefined) return false;
      if (contested.get(t)! > 1) {
        st.set(id, 3);
        return false;
      }
      st.set(id, 1);
      const occ = occupant.get(t);
      const ok = occ === undefined || resolve(occ);
      st.set(id, ok ? 2 : 3);
      return ok;
    };
    const ids = [...target.keys()].sort((a, b) => a - b);
    const winners = ids.filter((id) => resolve(id));
    for (const id of winners) {
      const u = byId.get(id)!;
      const t = target.get(id)!;
      u.x = t % size;
      u.y = (t - u.x) / size;
    }
  }
  for (const id of [...noPath].sort((a, b) => a - b)) {
    const u = state.units.find((x) => x.id === id);
    if (!u) continue;
    events.push({ type: "invalid_action", player: u.owner, action: intents[u.owner - 1]!.unit.get(id) ?? null, reason: "no path to target" });
  }
}

/** Static obstacles for pathfinding from a player's point of view. */
function pathBlocking(state: GameState, player: PlayerId): Uint8Array {
  const size = state.map.size;
  const vis = computeVisibility(state, player);
  const b = new Uint8Array(size * size);
  for (let i = 0; i < b.length; i++) if (state.map.tiles[i] !== TILE.floor) b[i] = 1;
  for (const base of state.bases) {
    if (base.hp > 0 && (base.owner === player || vis[base.y * size + base.x])) b[base.y * size + base.x] = 1;
  }
  for (const s of state.structures) {
    const i = s.y * size + s.x;
    if (s.owner === player || vis[i]) b[i] = 1;
  }
  return b;
}

/** Next direction along a shortest path, or null if already there / adjacent to a blocked target / unreachable. */
function stepToward(field: Int32Array, size: number, u: Unit, order: readonly Dir[], blocked: Uint8Array): Dir | null {
  const here = field[u.y * size + u.x]!;
  if (here <= 0) return null;
  let best: Dir | null = null;
  let bestD = here;
  for (const d of order) {
    const nx = u.x + DIRS[d].x;
    const ny = u.y + DIRS[d].y;
    if (!inBounds(size, nx, ny)) continue;
    const i = ny * size + nx;
    const nd = field[i]!;
    if (nd < 0 || nd >= bestD || blocked[i]) continue;
    best = d;
    bestD = nd;
  }
  return best;
}

// ============================================================ phase 4

function resolveHarvest(state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  const nodes = new Map(state.nodes.map((n) => [n.id, n]));
  type Req = { unit: Unit; act: Extract<UnitAction, { type: "harvest" }> };
  const byNode = new Map<number, Req[]>();
  for (const u of state.units) {
    const act = intents[u.owner - 1]!.unit.get(u.id);
    if (act?.type !== "harvest") continue;
    const node = nodes.get(act.nodeId);
    const fail = (reason: string) => events.push({ type: "invalid_action", player: u.owner, action: act, reason });
    if (!node) {
      fail("no such node");
      continue;
    }
    if (chebyshev(u, node) !== 1) {
      fail("not adjacent to node");
      continue;
    }
    let list = byNode.get(node.id);
    if (!list) byNode.set(node.id, (list = []));
    list.push({ unit: u, act });
  }
  // Contested nodes: the player who goes first alternates by tick parity, then unit ID order.
  const first: PlayerId = state.tick % 2 === 0 ? 1 : 2;
  for (const nodeId of [...byNode.keys()].sort((a, b) => a - b)) {
    const node = nodes.get(nodeId)!;
    const reqs = byNode.get(nodeId)!.sort((a, b) => {
      if (a.unit.owner !== b.unit.owner) return a.unit.owner === first ? -1 : 1;
      return a.unit.id - b.unit.id;
    });
    for (const { unit, act } of reqs) {
      const cap = cargoCapacity(state, unit.owner, unit.type);
      const space = cap - unit.cargo.energy - unit.cargo.crystal;
      const amount = Math.min(CONFIG.units[unit.type].harvest, space, node.amount);
      if (amount <= 0) {
        events.push({ type: "invalid_action", player: unit.owner, action: act, reason: space <= 0 ? "cargo full" : "node depleted" });
        continue;
      }
      node.amount -= amount;
      unit.cargo[node.type] += amount;
      events.push({ type: "harvest", player: unit.owner, unitId: unit.id, nodeId: node.id, resource: node.type, amount });
    }
  }
}

function resolveDeposit(state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  for (const u of state.units) {
    const act = intents[u.owner - 1]!.unit.get(u.id);
    if (act?.type !== "deposit") continue;
    if (!state.bases.some((b) => b.owner === u.owner && b.hp > 0 && chebyshev(u, b) === 1)) {
      events.push({ type: "invalid_action", player: u.owner, action: act, reason: "not adjacent to base" });
      continue;
    }
    const { energy, crystal } = u.cargo;
    if (energy + crystal === 0) {
      events.push({ type: "invalid_action", player: u.owner, action: act, reason: "cargo empty" });
      continue;
    }
    const p = state.players[u.owner - 1]!;
    p.energy += energy;
    p.crystal += crystal;
    u.cargo = { energy: 0, crystal: 0 };
    events.push({ type: "deposit", player: u.owner, unitId: u.id, energy, crystal });
  }
}

function resolveBuild(state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  const size = state.map.size;
  const occ = occupancy(state, true);
  type Req = { unit: Unit; act: Extract<UnitAction, { type: "build" }>; tile: number };
  const perPlayer: [Req[], Req[]] = [[], []];
  for (const u of state.units) {
    const act = intents[u.owner - 1]!.unit.get(u.id);
    if (act?.type !== "build") continue;
    const fail = (reason: string) => events.push({ type: "invalid_action", player: u.owner, action: act, reason });
    const tile = act.y * size + act.x;
    if (chebyshev(u, act) !== 1) {
      fail("build tile not adjacent to worker");
      continue;
    }
    if (occ[tile]) {
      fail("build tile not empty");
      continue;
    }
    const sc = act.structure === "base" ? CONFIG.base : CONFIG.structures[act.structure];
    if (Number.isFinite(sc.maxDistFromBase) && !state.bases.some((b) => b.owner === u.owner && b.hp > 0 && chebyshev(act, b) <= sc.maxDistFromBase)) {
      fail(`${act.structure} must be within ${sc.maxDistFromBase} tiles of base`);
      continue;
    }
    const list = perPlayer[u.owner - 1]!;
    if (list.some((r) => r.tile === tile)) {
      fail("another of your workers is building on this tile");
      continue;
    }
    list.push({ unit: u, act, tile });
  }
  const tiles1 = new Set(perPlayer[0].map((r) => r.tile));
  const tiles2 = new Set(perPlayer[1].map((r) => r.tile));
  for (const p of PLAYERS) {
    const other = p === 1 ? tiles2 : tiles1;
    const pl = state.players[p - 1]!;
    for (const r of perPlayer[p - 1]!) {
      if (other.has(r.tile)) {
        events.push({ type: "invalid_action", player: p, action: r.act, reason: "both players built on the same tile" });
        continue;
      }
      const spec = r.act.structure === "base" ? CONFIG.base : CONFIG.structures[r.act.structure];
      const cost = spec.costEnergy;
      if (pl.energy < cost) {
        events.push({ type: "invalid_action", player: p, action: r.act, reason: "not enough energy" });
        continue;
      }
      pl.energy -= cost;
      const id = state.nextId++;
      if (r.act.structure === "base") {
        state.bases.push({ id, owner: p, x: r.act.x, y: r.act.y, hp: spec.hp });
      } else {
        state.structures.push({ id, owner: p, type: r.act.structure, x: r.act.x, y: r.act.y, hp: spec.hp });
      }
      events.push({ type: "build", player: p, unitId: r.unit.id, structureId: id, structure: r.act.structure, x: r.act.x, y: r.act.y });
    }
  }
}

// ============================================================ phase 5

function resolveCombat(state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  type Target = { id: number; owner: PlayerId; x: number; y: number; hp: number; isUnit: boolean };
  const targets = new Map<number, Target>();
  for (const u of state.units) targets.set(u.id, { id: u.id, owner: u.owner, x: u.x, y: u.y, hp: u.hp, isUnit: true });
  for (const s of state.structures) targets.set(s.id, { id: s.id, owner: s.owner, x: s.x, y: s.y, hp: s.hp, isUnit: false });
  for (const b of state.bases) if (b.hp > 0) targets.set(b.id, { id: b.id, owner: b.owner, x: b.x, y: b.y, hp: b.hp, isUnit: false });

  const damage = new Map<number, number>();
  const hit = (attackerId: number, t: Target, raw: number) => {
    let dmg = raw;
    if (t.isUnit && state.players[t.owner - 1]!.upgrades.armor) {
      const a = CONFIG.upgrades.armor;
      dmg = Math.max(a.minDamage, dmg - a.damageReduction);
    }
    damage.set(t.id, (damage.get(t.id) ?? 0) + dmg);
    events.push({ type: "attack", attackerId, targetId: t.id, damage: dmg });
  };

  for (const u of state.units) {
    const act = intents[u.owner - 1]!.unit.get(u.id);
    if (act?.type !== "attack") continue;
    const t = targets.get(act.targetId);
    const fail = (reason: string) => events.push({ type: "invalid_action", player: u.owner, action: act, reason });
    if (!t) {
      fail("no such target");
      continue;
    }
    if (t.owner === u.owner) {
      fail("cannot attack own entity");
      continue;
    }
    const spec = CONFIG.units[u.type];
    if (chebyshev(u, t) > spec.range) {
      fail("target out of range");
      continue;
    }
    const bonus = u.type === "fighter" && state.players[u.owner - 1]!.upgrades.weapons ? CONFIG.upgrades.weapons.fighterDamageBonus : 0;
    hit(u.id, t, spec.damage + bonus);
  }

  for (const s of state.structures) {
    const sc = CONFIG.structures[s.type];
    if (sc.damage <= 0) continue;
    let best: Unit | null = null;
    for (const u of state.units) {
      if (u.owner === s.owner || chebyshev(u, s) > sc.range) continue;
      if (!best || u.hp < best.hp || (u.hp === best.hp && u.id < best.id)) best = u;
    }
    if (best) hit(s.id, targets.get(best.id)!, sc.damage);
  }

  for (const u of state.units) u.hp -= damage.get(u.id) ?? 0;
  for (const s of state.structures) s.hp -= damage.get(s.id) ?? 0;
  for (const b of state.bases) b.hp = Math.max(0, b.hp - (damage.get(b.id) ?? 0));
}

// ============================================================ phases 6-7

function removeDead(state: GameState, events: GameEvent[]): void {
  for (const u of state.units) if (u.hp <= 0) events.push({ type: "death", id: u.id, kind: "unit", owner: u.owner, x: u.x, y: u.y });
  for (const s of state.structures) if (s.hp <= 0) events.push({ type: "death", id: s.id, kind: "structure", owner: s.owner, x: s.x, y: s.y });
  state.units = state.units.filter((u) => u.hp > 0);
  state.structures = state.structures.filter((s) => s.hp > 0);
}

function applyZone(state: GameState, events: GameEvent[]): void {
  const r = zoneRadius(state.tick);
  if (r >= CONFIG.zone.initialRadius) return;
  const c = zoneCenter(state);
  const r2 = r * r;
  const dmg = CONFIG.zone.damage;
  for (const e of [...state.units, ...state.structures].sort((a, b) => a.id - b.id)) {
    if (dist2(e, c) <= r2) continue;
    e.hp -= dmg;
    events.push({ type: "zone_damage", targetId: e.id, damage: dmg });
  }
  removeDead(state, events);
}
