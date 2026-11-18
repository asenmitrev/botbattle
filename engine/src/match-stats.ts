// Match statistics derived from a match's events: kills and losses (with attribution), spawns, builds,
// upgrades, economy, damage and errors per player. Pure bookkeeping over GameEvents; it never changes rules.
// (Unit/structure stat lookups live in stats.ts; this file is about what happened in one match.)
//
// Kill attribution. Death events don't name a killer, so it is derived from the same tick's damage events,
// using the engine's phase order (combat → remove dead → bases → zone damage → remove dead):
//   1. If the victim took zone damage earlier in the tick, the zone dealt the killing blow: the zone gets the
//      kill and no player is credited. (Anything killed in combat is removed before the zone phase, so a
//      victim with zone damage that tick survived combat.)
//   2. Otherwise all hits land at once in combat, so there is no single "last hit". The kill goes to the
//      attacker (unit or turret) that dealt the most damage to the victim that tick; ties go to the attacker
//      whose attack came first in the event order (the engine resolves unit attacks by unit ID, then turrets).
//   3. If no damage to the victim was recorded that tick (shouldn't happen), the killer is "unknown".
// Damage dealt on earlier ticks doesn't earn kill credit; it shows up in the damage totals.

import { CONFIG, type BuildType, type NodeType, type Race, type StructureType, type UnitType, type UpgradeType } from "./config.js";
import type { Replay } from "./replay.js";
import { createInitialState } from "./state.js";
import { buildSpec, isUnitType } from "./stats.js";
import type { Cargo, GameEvent, GameState, PlayerId } from "./types.js";

/** What can die: a unit, a structure or a base. */
export type VictimType = UnitType | StructureType | "base";
/** What can deal damage: a unit type, a structure type (turrets), a base (the Tumor Cell), or the shrinking zone. */
export type DamageSource = UnitType | StructureType | "base" | "zone";
/** Who gets a kill: a damage source, or "unknown" when no damage to the victim was recorded that tick. */
export type KillerType = DamageSource | "unknown";

export type Count<K extends string> = Partial<Record<K, number>>;
/** victim type → killer type → count. Only non-zero entries are present. */
export type KillMatrix = Partial<Record<VictimType, Count<KillerType>>>;

export interface PlayerMatchStats {
  /** Enemy entities this player destroyed, by victim type and by which of this player's entity types got the kill. */
  kills: KillMatrix;
  /** This player's entities that were destroyed, by victim type and by killer (enemy unit/turret type, or "zone"). */
  losses: KillMatrix;
  spawned: Count<UnitType>;
  built: Count<BuildType>;
  /** Upgrades bought, in order, with the tick they were bought on. */
  upgrades: { upgrade: UpgradeType; tick: number }[];
  harvested: Cargo;
  deposited: Cargo;
  /** Resources spent on spawns, builds and upgrades. */
  spent: Cargo;
  /** Damage this player's entities dealt, by the attacker's type. */
  damageDealt: Count<DamageSource>;
  /** Damage this player's entities took, by the attacker's type (or "zone"). */
  damageTaken: Count<DamageSource>;
  /** Damage this player dealt, by the type of entity it hit. */
  damageDealtTo: Count<VictimType>;
  invalidActions: number;
  /** invalid_action count per reason. */
  invalidReasons: Record<string, number>;
  /** Ticks on which the bot failed (bot_error runner events). */
  botErrors: number;
  /** Most living units at once. */
  peakUnits: number;
  /** Most living combat units (types with damage > 0) at once. */
  peakArmy: number;
  /** Tick of this player's first kill, or null. */
  firstKillTick: number | null;
}

export interface MatchStats {
  /** Number of ticks whose events are included (stats describe the state after tick `ticks - 1`). */
  ticks: number;
  /** First tick on which any entity damaged an enemy, or null. */
  firstContactTick: number | null;
  /** First tick on which anything was destroyed (by a player or the zone), or null. */
  firstDeathTick: number | null;
  players: [PlayerMatchStats, PlayerMatchStats];
}

interface Entity {
  owner: PlayerId;
  type: VictimType;
}

function emptyPlayer(): PlayerMatchStats {
  return {
    kills: {},
    losses: {},
    spawned: {},
    built: {},
    upgrades: [],
    harvested: { energy: 0, crystal: 0 },
    deposited: { energy: 0, crystal: 0 },
    spent: { energy: 0, crystal: 0 },
    damageDealt: {},
    damageTaken: {},
    damageDealtTo: {},
    invalidActions: 0,
    invalidReasons: {},
    botErrors: 0,
    peakUnits: 0,
    peakArmy: 0,
    firstKillTick: null,
  };
}

function inc<K extends string>(c: Count<K>, k: K, n = 1): void {
  c[k] = (c[k] ?? 0) + n;
}

function incMatrix(m: KillMatrix, victim: VictimType, killer: KillerType): void {
  inc((m[victim] ??= {}), killer);
}

const isArmy = (type: UnitType) => CONFIG.units[type].damage > 0;

/** Sum of a count (or of one row of a kill matrix). */
export function countTotal(c: Count<string> | undefined): number {
  let n = 0;
  for (const v of Object.values(c ?? {})) n += v ?? 0;
  return n;
}

/** Sum of a kill matrix, optionally limited to victims of the given types. */
export function matrixTotal(m: KillMatrix, victims?: readonly VictimType[]): number {
  let n = 0;
  for (const [v, row] of Object.entries(m) as [VictimType, Count<KillerType>][]) if (!victims || victims.includes(v)) n += countTotal(row);
  return n;
}

/**
 * Accumulates match statistics tick by tick. Feed it every tick's events in order (engine events plus
 * runner events such as bot_error); `snapshot()` returns the stats so far.
 */
export class MatchStatsTracker {
  private readonly entities = new Map<number, Entity>();
  private readonly races: [Race, Race];
  private readonly alive: [Map<UnitType, number>, Map<UnitType, number>] = [new Map(), new Map()];
  private readonly s: MatchStats = { ticks: 0, firstContactTick: null, firstDeathTick: null, players: [emptyPlayer(), emptyPlayer()] };

  constructor(initial: GameState) {
    this.races = [initial.players[0].race, initial.players[1].race];
    for (const u of initial.units) this.addUnit(u.id, u.owner, u.type);
    for (const st of initial.structures) this.entities.set(st.id, { owner: st.owner, type: st.type });
    for (const b of initial.bases) this.entities.set(b.id, { owner: b.owner, type: "base" });
    this.updatePeaks();
  }

  /** Number of ticks added so far. */
  get ticks(): number {
    return this.s.ticks;
  }

  /** Add the events of the next tick (`tick` is the tick being resolved, as in TickRecord.tick). */
  add(tick: number, events: readonly GameEvent[]): void {
    const s = this.s;
    const pl = (p: PlayerId) => s.players[p - 1]!;
    // Damage taken this tick: victim id → attacker id → damage, plus whether the zone hit it.
    const hits = new Map<number, { zone: boolean; by: Map<number, number> }>();
    const hitsOn = (id: number) => {
      let h = hits.get(id);
      if (!h) hits.set(id, (h = { zone: false, by: new Map() }));
      return h;
    };

    for (const e of events) {
      switch (e.type) {
        case "spawn": {
          this.addUnit(e.unitId, e.player, e.unit);
          inc(pl(e.player).spawned, e.unit);
          const c = CONFIG.units[e.unit];
          this.spend(e.player, c.costEnergy, c.costCrystal);
          break;
        }
        case "build": {
          this.entities.set(e.structureId, { owner: e.player, type: e.structure });
          inc(pl(e.player).built, e.structure);
          const c = buildSpec(e.structure, this.races[e.player - 1]!);
          this.spend(e.player, c.costEnergy, c.costCrystal);
          break;
        }
        case "transform": {
          // The unit leaves (not a death) and a base appears, paid like a build.
          const unit = this.entities.get(e.unitId);
          if (unit && isUnitType(unit.type)) {
            const m = this.alive[e.player - 1]!;
            m.set(unit.type, (m.get(unit.type) ?? 1) - 1);
          }
          this.entities.delete(e.unitId);
          this.entities.set(e.baseId, { owner: e.player, type: "base" });
          inc(pl(e.player).built, "base");
          const c = buildSpec("base", this.races[e.player - 1]!);
          this.spend(e.player, c.costEnergy, c.costCrystal);
          break;
        }
        case "upgrade": {
          pl(e.player).upgrades.push({ upgrade: e.upgrade, tick });
          const c = CONFIG.upgrades[e.upgrade];
          this.spend(e.player, c.costEnergy, c.costCrystal);
          break;
        }
        case "harvest":
          pl(e.player).harvested[e.resource as NodeType] += e.amount;
          break;
        case "deposit":
          pl(e.player).deposited.energy += e.energy;
          pl(e.player).deposited.crystal += e.crystal;
          break;
        case "attack": {
          const by = this.entities.get(e.attackerId);
          const victim = this.entities.get(e.targetId);
          if (by) {
            const source = by.type;
            inc(pl(by.owner).damageDealt, source, e.damage);
            if (victim) {
              inc(pl(by.owner).damageDealtTo, victim.type, e.damage);
              inc(pl(victim.owner).damageTaken, source, e.damage);
            }
            if (e.damage > 0 && s.firstContactTick === null) s.firstContactTick = tick;
          }
          const h = hitsOn(e.targetId).by;
          h.set(e.attackerId, (h.get(e.attackerId) ?? 0) + e.damage);
          break;
        }
        case "zone_damage": {
          const victim = this.entities.get(e.targetId);
          if (victim) inc(pl(victim.owner).damageTaken, "zone", e.damage);
          hitsOn(e.targetId).zone = true;
          break;
        }
        case "death":
          this.death(tick, e.id, e.owner, hits.get(e.id));
          break;
        case "invalid_action": {
          const p = pl(e.player);
          p.invalidActions++;
          p.invalidReasons[e.reason] = (p.invalidReasons[e.reason] ?? 0) + 1;
          break;
        }
        case "bot_error":
          pl(e.player).botErrors++;
          break;
        default:
          break;
      }
    }
    this.updatePeaks();
    s.ticks++;
  }

  /** A deep copy of the stats so far. */
  snapshot(): MatchStats {
    return JSON.parse(JSON.stringify(this.s)) as MatchStats;
  }

  private addUnit(id: number, owner: PlayerId, type: UnitType): void {
    this.entities.set(id, { owner, type });
    const m = this.alive[owner - 1]!;
    m.set(type, (m.get(type) ?? 0) + 1);
  }

  private spend(p: PlayerId, energy: number, crystal: number): void {
    const sp = this.s.players[p - 1]!.spent;
    sp.energy += energy;
    sp.crystal += crystal;
  }

  private death(tick: number, id: number, owner: PlayerId, hit: { zone: boolean; by: Map<number, number> } | undefined): void {
    this.s.firstDeathTick ??= tick;
    const victim = this.entities.get(id);
    if (!victim) return; // not something this tracker saw appear; can't classify it
    const type = victim.type;
    if (isUnitType(type)) {
      const m = this.alive[owner - 1]!;
      m.set(type, (m.get(type) ?? 1) - 1);
    }
    const loser = this.s.players[owner - 1]!;
    if (hit?.zone) return void incMatrix(loser.losses, type, "zone");
    let killerId: number | null = null;
    let best = -1;
    for (const [attackerId, dmg] of hit?.by ?? []) {
      if (dmg > best) {
        best = dmg;
        killerId = attackerId;
      }
    }
    const killer = killerId === null ? undefined : this.entities.get(killerId);
    if (!killer) return void incMatrix(loser.losses, type, "unknown");
    incMatrix(loser.losses, type, killer.type);
    const winner = this.s.players[killer.owner - 1]!;
    incMatrix(winner.kills, type, killer.type);
    winner.firstKillTick ??= tick;
  }

  private updatePeaks(): void {
    for (const p of [1, 2] as PlayerId[]) {
      let units = 0;
      let army = 0;
      for (const [type, n] of this.alive[p - 1]!) {
        units += n;
        if (isArmy(type)) army += n;
      }
      const ps = this.s.players[p - 1]!;
      ps.peakUnits = Math.max(ps.peakUnits, units);
      ps.peakArmy = Math.max(ps.peakArmy, army);
    }
  }
}

/** Stats for a whole replay, or for its first `ticks` ticks. */
export function matchStats(replay: Replay, ticks = replay.ticks.length): MatchStats {
  const tracker = new MatchStatsTracker(replay.snapshots[0]?.state ?? createInitialState(replay.seed, replay.races));
  for (const rec of replay.ticks.slice(0, ticks)) tracker.add(rec.tick, [...(rec.runnerEvents ?? []), ...rec.events]);
  return tracker.snapshot();
}
