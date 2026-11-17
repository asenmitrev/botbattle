import {
  CONFIG_VERSION,
  computeScore,
  createInitialState,
  hashState,
  step,
  forfeit,
  type GameEvent,
  type GameState,
  type PlayerId,
  type Replay,
} from "@arena/engine";

export interface Series {
  score: [number[], number[]];
  units: [number[], number[]];
  energy: [number[], number[]];
}

/**
 * A replay fully re-simulated in the browser. states[t] is the state *before* tick t
 * resolves (states[0] = initial); eventsAt(t) are the events that produced states[t].
 * All states are precomputed (a 500-tick match takes a few ms), so seeking is instant.
 */
export class ReplayModel {
  readonly states: GameState[] = [];
  readonly series: Series;
  readonly verified: boolean;

  constructor(readonly replay: Replay) {
    if (replay.configVersion !== CONFIG_VERSION) {
      throw new Error(`Replay was recorded under rules ${replay.configVersion}; this viewer plays ${CONFIG_VERSION}, so it can't be shown.`);
    }
    let s = createInitialState(replay.seed);
    this.states.push(s);
    for (const rec of replay.ticks) {
      s = step(s, rec.actions[0], rec.actions[1]).state;
      this.states.push(s);
      if (s.result) break;
    }
    if (replay.forfeit && !s.result) {
      s = forfeit(s, replay.forfeit.loser).state;
      this.states[this.states.length - 1] = s;
    }
    this.verified = hashState(s) === replay.finalStateHash;
    const mk = (): [number[], number[]] => [[], []];
    this.series = { score: mk(), units: mk(), energy: mk() };
    for (const st of this.states) {
      for (const p of [1, 2] as PlayerId[]) {
        this.series.score[p - 1]!.push(computeScore(st, p));
        this.series.units[p - 1]!.push(st.units.filter((u) => u.owner === p).length);
        this.series.energy[p - 1]!.push(st.players[p - 1]!.energy);
      }
    }
  }

  get lastIndex(): number {
    return this.states.length - 1;
  }

  eventsAt(t: number): GameEvent[] {
    if (t <= 0) return [];
    const rec = this.replay.ticks[t - 1];
    return rec ? [...(rec.runnerEvents ?? []), ...rec.events] : [];
  }
}
