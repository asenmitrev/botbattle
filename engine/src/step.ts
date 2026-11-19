import { BUILD_TYPES, CONFIG, type BuildType, type UpgradeType } from "./config.js";
import { chebyshev, DIRS, DIR_ORDER_P1, DIR_ORDER_P2, dist2, distanceField, inBounds } from "./geometry.js";
import { cloneState, computeScore, findSpawnTile, makeUnit, occupancy, ownedUpgradesFor, raceOf, zoneCenter, zoneRadius } from "./state.js";
import {
  attackRange, baseSpec, buildSpec, cargoCapacity, hasUpgradeType, isUnitType, leash, maxHp, passiveEnergy, placementRange, raceCanBuild,
  raceHasUnit, raceHasUpgrade, turretImmune, unitSpeed,
} from "./stats.js";
import { TILE, type Action, type Base, type Dir, type GameEvent, type GameState, type MatchResult, type PlayerId, type Pos, type StepResult, type Structure, type Unit } from "./types.js";
import { computeVisibility } from "./vision.js";

type UnitAction = Extract<Action, { unitId: number }>;

interface Intents {
  unit: Map<number, UnitAction>;
  spawn: Extract<Action, { type: "spawn" }> | null;
  /** Upgrade types to buy, in action order. */
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
    if (b.hp <= 0 && (previousHp.get(b.id) ?? 1) > 0) {
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

  // Phase 7: node regen, passive income, healing, zone damage.
  for (const n of state.nodes) {
    const nc = CONFIG.nodes[n.type];
    if (nc.regen > 0) n.amount = Math.min(nc.max, n.amount + nc.regen);
  }
  for (const p of state.players) p.energy += passiveEnergy(p.upgrades);
  applyHealing(state, events);
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

/** A bot action as received: an object with a string `type`, every other field unchecked. */
type RawAction = Record<string, unknown> & { type: string };

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isRawAction(v: unknown): v is RawAction {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** `a.x`, `a.y` are integers on the map. */
function onMap(a: RawAction, size: number): a is RawAction & Pos {
  return isInt(a.x) && isInt(a.y) && inBounds(size, a.x, a.y);
}

const isDir = (v: unknown): v is Dir => typeof v === "string" && Object.hasOwn(DIRS, v);

/**
 * Unit actions: each entry checks one raw action for the unit it names and returns the normalized action
 * (only known fields, so stored intents never alias bot objects) or the reason it is invalid. Ownership and
 * one-action-per-unit are checked by the caller.
 */
const UNIT_ACTIONS: { [K in UnitAction["type"]]: (a: RawAction, u: Unit, size: number) => Extract<UnitAction, { type: K }> | string } = {
  move: (a, u) => (isDir(a.dir) ? { type: "move", unitId: u.id, dir: a.dir } : "bad dir"),
  moveTo: (a, u, size) => (onMap(a, size) ? { type: "moveTo", unitId: u.id, x: a.x, y: a.y } : "target out of bounds"),
  harvest: (a, u) => {
    if (CONFIG.units[u.type].harvest <= 0) return `${u.type} cannot harvest`;
    return isInt(a.nodeId) ? { type: "harvest", unitId: u.id, nodeId: a.nodeId } : "missing nodeId";
  },
  deposit: (_a, u) => (CONFIG.units[u.type].carry > 0 ? { type: "deposit", unitId: u.id } : `${u.type} cannot carry`),
  attack: (a, u) => {
    if (CONFIG.units[u.type].damage <= 0) return `${u.type} cannot attack`;
    return isInt(a.targetId) ? { type: "attack", unitId: u.id, targetId: a.targetId } : "missing targetId";
  },
  transform: (_a, u) => (CONFIG.units[u.type].canTransform ? { type: "transform", unitId: u.id } : `${u.type} cannot transform`),
  build: (a, u, size) => {
    if (!CONFIG.units[u.type].canBuild) return `${u.type} cannot build`;
    const structure = a.structure;
    if (typeof structure !== "string" || !BUILD_TYPES.includes(structure as BuildType)) return "unknown structure";
    return onMap(a, size) ? { type: "build", unitId: u.id, structure: structure as BuildType, x: a.x, y: a.y } : "build position out of bounds";
  },
};

interface CollectContext {
  state: GameState;
  player: PlayerId;
  intents: Intents;
  events: GameEvent[];
  /** Per-tick counters for the capped actions. */
  logs: number;
  marks: number;
  invalid(action: unknown, reason: string): void;
}

/** Actions that don't belong to a unit. Each records its own intent or event. */
const PLAYER_ACTIONS: Record<string, (a: RawAction, c: CollectContext) => void> = {
  log(a, c) {
    if (++c.logs > CONFIG.bot.maxLogsPerTick) return;
    c.events.push({ type: "log", player: c.player, text: String(a.text).slice(0, CONFIG.bot.maxLogLength) });
  },
  mark(a, c) {
    if (!onMap(a, c.state.map.size)) return c.invalid(a, "mark position out of bounds");
    if (++c.marks > CONFIG.bot.maxMarksPerTick) return;
    const color = typeof a.color === "string" ? a.color.slice(0, 32) : "";
    const label = typeof a.label === "string" ? a.label.slice(0, 64) : "";
    c.events.push({ type: "mark", player: c.player, x: a.x, y: a.y, color, label });
  },
  spawn(a, c) {
    if (typeof a.unit !== "string" || !isUnitType(a.unit)) return c.invalid(a, "unknown unit type");
    if (!raceHasUnit(raceOf(c.state, c.player), a.unit)) return c.invalid(a, `${a.unit} is not a unit of your race`);
    const baseId = a.baseId;
    if (baseId !== undefined && !(isInt(baseId) && c.state.bases.some((b) => b.id === baseId && b.owner === c.player && b.hp > 0))) {
      return c.invalid(a, "no such living base (or not yours)");
    }
    if (c.intents.spawn !== null) return c.invalid(a, "only one spawn per tick");
    c.intents.spawn = { type: "spawn", unit: a.unit, ...(baseId !== undefined ? { baseId } : {}) };
  },
  upgrade(a, c) {
    if (typeof a.upgrade !== "string" || !hasUpgradeType(a.upgrade)) return c.invalid(a, "unknown upgrade");
    if (!raceHasUpgrade(raceOf(c.state, c.player), a.upgrade)) return c.invalid(a, `${a.upgrade} is not an upgrade of your race`);
    if (c.intents.upgrades.includes(a.upgrade)) return c.invalid(a, "duplicate upgrade");
    c.intents.upgrades.push(a.upgrade);
  },
};

function collectIntents(state: GameState, player: PlayerId, raw: unknown, events: GameEvent[]): Intents {
  const intents: Intents = { unit: new Map(), spawn: null, upgrades: [] };
  const c: CollectContext = {
    state,
    player,
    intents,
    events,
    logs: 0,
    marks: 0,
    invalid: (action, reason) => events.push({ type: "invalid_action", player, action: sanitize(action), reason }),
  };
  if (raw === undefined || raw === null) return intents;
  if (!Array.isArray(raw)) {
    c.invalid(null, "bot returned a non-array");
    return intents;
  }
  const max = CONFIG.bot.maxActionsPerTick;
  if (raw.length > max) c.invalid(null, `too many actions (${raw.length}), only the first ${max} are used`);
  const units = new Map<number, Unit>();
  for (const u of state.units) if (u.owner === player) units.set(u.id, u);

  for (const a of raw.slice(0, max) as unknown[]) {
    if (!isRawAction(a)) {
      c.invalid(a, "malformed action");
      continue;
    }
    if (Object.hasOwn(PLAYER_ACTIONS, a.type)) {
      PLAYER_ACTIONS[a.type]!(a, c);
      continue;
    }
    if (!Object.hasOwn(UNIT_ACTIONS, a.type)) {
      c.invalid(a, "unknown action type");
      continue;
    }
    const u = isInt(a.unitId) ? units.get(a.unitId) : undefined;
    if (!u) {
      c.invalid(a, isInt(a.unitId) ? "no such unit (or not yours)" : "missing unitId");
      continue;
    }
    const parsed = UNIT_ACTIONS[a.type as UnitAction["type"]](a, u, state.map.size);
    if (typeof parsed === "string") c.invalid(a, parsed);
    else if (intents.unit.has(u.id)) c.invalid(a, "unit already has an action this tick");
    else intents.unit.set(u.id, parsed);
  }
  return intents;
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
    const action = { type: "upgrade", upgrade: up };
    const fail = (reason: string) => events.push({ type: "invalid_action", player, action, reason });
    const cost = CONFIG.upgrades[up];
    if (p.upgrades.includes(up)) fail("already upgraded");
    else if (p.energy < cost.costEnergy || p.crystal < cost.costCrystal) fail("not enough resources");
    else {
      p.energy -= cost.costEnergy;
      p.crystal -= cost.costCrystal;
      p.upgrades.push(up);
      // Applies at once to everything of its type the player has; later spawns/builds start with it.
      const target = CONFIG.upgrades[up].appliesTo;
      for (const e of [...state.units, ...state.structures]) {
        if (e.owner !== player || e.type !== target || e.upgrades.includes(up)) continue;
        const before = maxHp(e);
        e.upgrades.push(up);
        e.hp += maxHp(e) - before;
      }
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
  const maxSpeed = state.units.reduce((max, u) => Math.max(max, unitSpeed(u)), 0);

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

  // Leashed units: distance (Chebyshev) to the nearest living friendly base at the start of movement.
  const homes: [Base[], Base[]] = [
    state.bases.filter((b) => b.owner === 1 && b.hp > 0),
    state.bases.filter((b) => b.owner === 2 && b.hp > 0),
  ];
  const homeDist = (owner: PlayerId, x: number, y: number) => homes[owner - 1]!.reduce((d, b) => Math.min(d, chebyshev(b, { x, y })), Infinity);

  const noPath = new Set<number>();
  for (let sub = 1; sub <= maxSpeed; sub++) {
    // Desired destination per mover, in ID order.
    const target = new Map<number, number>();
    const byId = new Map<number, Unit>();
    for (const u of state.units) {
      byId.set(u.id, u);
      if (unitSpeed(u) < sub) continue;
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
      const limit = leash(u);
      if (limit !== Infinity) {
        const d = homeDist(u.owner, nx, ny);
        if (d > limit && d > homeDist(u.owner, u.x, u.y)) continue; // past the leash, and not heading back
      }
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
      const cap = cargoCapacity(unit.type);
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
  type Act = Extract<UnitAction, { type: "build" | "transform" }>;
  type Req = { unit: Unit; act: Act; tile: number; structure: BuildType; x: number; y: number };
  const perPlayer: [Req[], Req[]] = [[], []];
  for (const u of state.units) {
    const act = intents[u.owner - 1]!.unit.get(u.id);
    if (act?.type === "transform") {
      // The unit becomes a base where it stands: no adjacency, occupancy or distance limit.
      perPlayer[u.owner - 1]!.push({ unit: u, act, tile: u.y * size + u.x, structure: "base", x: u.x, y: u.y });
      continue;
    }
    if (act?.type !== "build") continue;
    const fail = (reason: string) => events.push({ type: "invalid_action", player: u.owner, action: act, reason });
    const race = raceOf(state, u.owner);
    const tile = act.y * size + act.x;
    if (!raceCanBuild(race, act.structure)) {
      fail(`${act.structure} is not a building your race can build`);
      continue;
    }
    if (chebyshev(u, act) !== 1) {
      fail("build tile not adjacent to worker");
      continue;
    }
    if (occ[tile]) {
      fail("build tile not empty");
      continue;
    }
    const range = placementRange(act.structure, race, state.players[u.owner - 1]!.upgrades);
    if (Number.isFinite(range) && !state.bases.some((b) => b.owner === u.owner && b.hp > 0 && chebyshev(act, b) <= range)) {
      fail(`${act.structure} must be within ${range} tiles of base`);
      continue;
    }
    const list = perPlayer[u.owner - 1]!;
    if (list.some((r) => r.tile === tile)) {
      fail("another of your workers is building on this tile");
      continue;
    }
    list.push({ unit: u, act, tile, structure: act.structure, x: act.x, y: act.y });
  }
  const tiles1 = new Set(perPlayer[0].map((r) => r.tile));
  const tiles2 = new Set(perPlayer[1].map((r) => r.tile));
  const transformed = new Set<number>();
  for (const p of PLAYERS) {
    const other = p === 1 ? tiles2 : tiles1;
    const pl = state.players[p - 1]!;
    for (const r of perPlayer[p - 1]!) {
      if (other.has(r.tile)) {
        events.push({ type: "invalid_action", player: p, action: r.act, reason: "both players built on the same tile" });
        continue;
      }
      const spec = buildSpec(r.structure, pl.race);
      if (pl.energy < spec.costEnergy || pl.crystal < spec.costCrystal) {
        events.push({ type: "invalid_action", player: p, action: r.act, reason: "not enough resources" });
        continue;
      }
      pl.energy -= spec.costEnergy;
      pl.crystal -= spec.costCrystal;
      const id = state.nextId++;
      if (r.structure === "base") {
        state.bases.push({ id, owner: p, x: r.x, y: r.y, hp: spec.hp });
      } else {
        const upgrades = ownedUpgradesFor(state, p, r.structure);
        state.structures.push({ id, owner: p, type: r.structure, x: r.x, y: r.y, hp: maxHp({ type: r.structure, upgrades }), upgrades });
      }
      if (r.act.type === "transform") {
        transformed.add(r.unit.id);
        events.push({ type: "transform", player: p, unitId: r.unit.id, baseId: id, x: r.x, y: r.y });
      } else {
        events.push({ type: "build", player: p, unitId: r.unit.id, structureId: id, structure: r.structure, x: r.x, y: r.y });
      }
    }
  }
  // A transformed unit is gone (its cargo with it); it isn't a death.
  if (transformed.size) state.units = state.units.filter((u) => !transformed.has(u.id));
}

// ============================================================ phase 5

function resolveCombat(state: GameState, intents: [Intents, Intents], events: GameEvent[]): void {
  type Target = { id: number; owner: PlayerId; x: number; y: number; hp: number; isUnit: boolean };
  const targets = new Map<number, Target>();
  for (const u of state.units) targets.set(u.id, { id: u.id, owner: u.owner, x: u.x, y: u.y, hp: u.hp, isUnit: true });
  for (const s of state.structures) targets.set(s.id, { id: s.id, owner: s.owner, x: s.x, y: s.y, hp: s.hp, isUnit: false });
  for (const b of state.bases) if (b.hp > 0) targets.set(b.id, { id: b.id, owner: b.owner, x: b.x, y: b.y, hp: b.hp, isUnit: false });

  const damage = new Map<number, number>();
  const hit = (attackerId: number, t: Target, dmg: number) => {
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
    if (chebyshev(u, t) > attackRange(u)) {
      fail("target out of range");
      continue;
    }
    hit(u.id, t, CONFIG.units[u.type].damage);
  }

  // Automatic attacks: the lowest-HP valid target in range, ties to the lowest ID.
  const lowest = <T extends { id: number; hp: number }>(list: Iterable<T>, ok: (t: T) => boolean): T | null => {
    let best: T | null = null;
    for (const t of list) if (ok(t) && (!best || t.hp < best.hp || (t.hp === best.hp && t.id < best.id))) best = t;
    return best;
  };
  const enemyUnit = (from: Pos & { owner: PlayerId }, range: number, skipImmune: boolean) =>
    lowest(state.units, (u) => u.owner !== from.owner && chebyshev(u, from) <= range && !(skipImmune && turretImmune(u)));
  const buildings = [...targets.values()].filter((t) => !t.isUnit);

  for (const s of state.structures) {
    const sc = CONFIG.structures[s.type];
    if (sc.damage <= 0 || sc.targets === "none") continue;
    if (sc.targets === "units") {
      const best = enemyUnit(s, sc.range, true); // skips units immune to building attacks
      if (best) hit(s.id, targets.get(best.id)!, sc.damage);
    } else {
      const best = lowest(buildings, (t) => t.owner !== s.owner && chebyshev(t, s) <= sc.range);
      if (best) hit(s.id, best, sc.damage);
    }
  }
  // Bases that shoot (the Tumor Cell) hit the lowest-HP enemy unit in range. Like turrets, they skip units
  // immune to building attacks (upgraded fighters).
  for (const b of state.bases) {
    const bs = baseSpec(raceOf(state, b.owner));
    if (b.hp <= 0 || bs.damage <= 0) continue;
    const best = enemyUnit(b, bs.range, true);
    if (best) hit(b.id, targets.get(best.id)!, bs.damage);
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

/**
 * Healing structures restore HP to every friendly unit, structure and living base within range, up to its
 * max HP. Heals don't stack: each target is healed once per tick, by the in-range healer that heals most
 * (ties to the lowest ID), however many healers reach it.
 */
function applyHealing(state: GameState, events: GameEvent[]): void {
  type Healable = { id: number; owner: PlayerId; x: number; y: number; hp: number };
  const healers = state.structures.filter((s) => CONFIG.structures[s.type].heal > 0).sort((a, b) => a.id - b.id);
  if (!healers.length) return;
  const all: { e: Healable; max: number }[] = [
    ...state.units.map((u) => ({ e: u as Healable, max: maxHp(u) })),
    ...state.structures.map((x: Structure) => ({ e: x as Healable, max: maxHp(x) })),
    ...state.bases.filter((b) => b.hp > 0).map((b) => ({ e: b as Healable, max: baseSpec(raceOf(state, b.owner)).hp })),
  ].sort((a, b) => a.e.id - b.e.id);
  for (const { e, max } of all) {
    if (e.hp >= max) continue;
    let best: Structure | null = null;
    for (const h of healers) {
      if (h.owner !== e.owner || chebyshev(e, h) > CONFIG.structures[h.type].range) continue;
      if (!best || CONFIG.structures[h.type].heal > CONFIG.structures[best.type].heal) best = h;
    }
    if (!best) continue;
    const amount = Math.min(CONFIG.structures[best.type].heal, max - e.hp);
    e.hp += amount;
    events.push({ type: "heal", healerId: best.id, targetId: e.id, amount });
  }
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
