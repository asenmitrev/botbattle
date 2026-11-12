import { CONFIG } from "./config.js";
import { ReplayRecorder, type Replay } from "./replay.js";
import { createInitialState } from "./state.js";
import { forfeit, step } from "./step.js";
import type { GameEvent, GameState, PlayerId } from "./types.js";
import { buildBotView, type BotState } from "./vision.js";

/** Result of asking a bot for its actions this tick. */
export interface BotTurn {
  actions: unknown;
  /** Set when the bot failed this tick (exception, timeout, bad memory). Actions are then ignored. */
  error?: string;
}

/**
 * Anything that can play: plain in-process modules (Milestone 1) or sandboxed isolates (Milestone 2).
 * Controllers own their bot's memory.
 */
export interface BotController {
  name: string;
  turn(view: BotState): BotTurn | Promise<BotTurn>;
  dispose?(): void | Promise<void>;
}

export interface MatchOptions {
  seed: number;
  /** Consecutive failures before forfeit. */
  maxConsecutiveFailures?: number;
  onTick?: (state: GameState, events: GameEvent[]) => void;
}

export interface MatchOutcome {
  state: GameState;
  replay: Replay;
}

export async function runMatch(bots: [BotController, BotController], opts: MatchOptions): Promise<MatchOutcome> {
  const maxFail = opts.maxConsecutiveFailures ?? CONFIG.bot.maxConsecutiveFailures;
  let state = createInitialState(opts.seed);
  const rec = new ReplayRecorder(opts.seed, [bots[0].name, bots[1].name], state);
  const failures = [0, 0];

  while (!state.result) {
    const runnerEvents: GameEvent[] = [];
    const actions: [unknown, unknown] = [[], []];
    for (const p of [1, 2] as const) {
      const view = buildBotView(state, p);
      let turn: BotTurn;
      try {
        turn = await bots[p - 1]!.turn(view);
      } catch (e) {
        turn = { actions: [], error: errorMessage(e) };
      }
      if (turn.error !== undefined) {
        failures[p - 1]!++;
        runnerEvents.push({ type: "bot_error", player: p, message: turn.error.slice(0, 500) });
      } else {
        failures[p - 1] = 0;
        actions[p - 1] = turn.actions;
      }
    }
    const before = state;
    const res = step(state, actions[0], actions[1]);
    rec.record(before, actions, res.events, runnerEvents);
    state = res.state;
    opts.onTick?.(state, [...runnerEvents, ...res.events]);

    if (!state.result) {
      const f1 = failures[0]! >= maxFail;
      const f2 = failures[1]! >= maxFail;
      if (f1 !== f2) {
        const loser: PlayerId = f1 ? 1 : 2;
        rec.markForfeit(loser, state.tick);
        state = forfeit(state, loser).state;
      }
      // Both failing: play continues (both idle) until normal end.
    }
  }
  if (state.tick > CONFIG.match.maxTicks) throw new Error("tick overflow");
  return { state, replay: rec.finish(state) };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
