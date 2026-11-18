import { CONFIG, CONFIG_VERSION, type Race } from "./config.js";
import { hashState } from "./hash.js";
import { cloneState, createInitialState } from "./state.js";
import { forfeit, step } from "./step.js";
import type { GameEvent, GameState, MatchResult, PlayerId } from "./types.js";

export const REPLAY_FORMAT = "bot-arena-replay";
export const REPLAY_FORMAT_VERSION = 1;

export interface TickRecord {
  /** Tick being resolved (state.tick before the step). */
  tick: number;
  /** Exactly what was passed to step() for each player (after runner-side failures became []). */
  actions: [unknown, unknown];
  /** Engine events produced by this step. */
  events: GameEvent[];
  /** Runner-side events (bot errors, timeouts). Not reproduced by re-simulation. */
  runnerEvents?: GameEvent[];
}

export interface Replay {
  format: typeof REPLAY_FORMAT;
  formatVersion: number;
  configVersion: string;
  config: typeof CONFIG;
  seed: number;
  bots: [string, string];
  /** Each player's race (the initial state depends on it). */
  races: [Race, Race];
  ticks: TickRecord[];
  /** Full-state snapshots every CONFIG.replay.snapshotEvery ticks (state *before* that tick), plus tick 0. */
  snapshots: { tick: number; state: GameState }[];
  /** Set when a runner ended the match outside step() (e.g. forfeit). */
  forfeit?: { loser: PlayerId; afterTick: number };
  result: MatchResult | null;
  finalStateHash: string;
}

export class ReplayRecorder {
  private replay: Replay;
  constructor(seed: number, bots: [string, string], initial: GameState) {
    this.replay = {
      format: REPLAY_FORMAT,
      formatVersion: REPLAY_FORMAT_VERSION,
      configVersion: CONFIG_VERSION,
      config: CONFIG,
      seed,
      bots,
      races: [initial.players[0].race, initial.players[1].race],
      ticks: [],
      snapshots: [{ tick: initial.tick, state: cloneState(initial) }],
      result: null,
      finalStateHash: "",
    };
  }
  record(before: GameState, actions: [unknown, unknown], events: GameEvent[], runnerEvents: GameEvent[] = []): void {
    if (before.tick > 0 && before.tick % CONFIG.replay.snapshotEvery === 0) {
      this.replay.snapshots.push({ tick: before.tick, state: cloneState(before) });
    }
    const rec: TickRecord = { tick: before.tick, actions: jsonCopy(actions), events };
    if (runnerEvents.length) rec.runnerEvents = runnerEvents;
    this.replay.ticks.push(rec);
  }
  markForfeit(loser: PlayerId, afterTick: number): void {
    this.replay.forfeit = { loser, afterTick };
  }
  finish(final: GameState): Replay {
    this.replay.result = final.result;
    this.replay.finalStateHash = hashState(final);
    return this.replay;
  }
}

function jsonCopy<T>(v: T): T {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? (null as T) : JSON.parse(s);
  } catch {
    return null as T;
  }
}

/**
 * Re-simulate a replay from its seed and recorded actions.
 * `untilTick` stops early (state before that tick), using the nearest snapshot to seek.
 */
export function simulateReplay(replay: Replay, untilTick?: number): GameState {
  if (replay.configVersion !== CONFIG_VERSION) {
    throw new Error(`replay config version ${replay.configVersion} != engine ${CONFIG_VERSION}`);
  }
  let state: GameState;
  let from = 0;
  if (untilTick !== undefined) {
    const snap = [...replay.snapshots].reverse().find((s) => s.tick <= untilTick);
    state = snap ? cloneState(snap.state) : createInitialState(replay.seed, replay.races);
    from = snap ? snap.tick : 0;
  } else {
    state = createInitialState(replay.seed, replay.races);
  }
  for (const rec of replay.ticks) {
    if (rec.tick < from) continue;
    if (untilTick !== undefined && rec.tick >= untilTick) break;
    state = step(state, rec.actions[0], rec.actions[1]).state;
    if (state.result) break;
  }
  if (replay.forfeit && untilTick === undefined && !state.result && state.tick === replay.forfeit.afterTick) {
    state = forfeit(state, replay.forfeit.loser).state;
  }
  return state;
}

export function verifyReplay(replay: Replay): { ok: boolean; expected: string; actual: string } {
  const actual = hashState(simulateReplay(replay));
  return { ok: actual === replay.finalStateHash, expected: replay.finalStateHash, actual };
}
