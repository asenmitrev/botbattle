import fs from "node:fs";
import path from "node:path";
import type { Ladder } from "./ladder.js";
import { writeFileAtomic } from "./store.js";

/**
 * End-of-season playoff: the top bots by Elo play a single-elimination bracket (1v8, 4v5, 2v7, 3v6),
 * every series GAMES_PER_SERIES games long, alternating sides. Games are unrated; their replays are kept
 * with the season (ids `p…`), and the result is stored as `playoff.json` in the archived season.
 */
export const PLAYOFF = { size: 8, gamesPerSeries: 5 } as const;

export interface PlayoffEntrant {
  id: string;
  name: string;
  /** 1 = top of the ladder. */
  seed: number;
  elo: number;
}

export interface PlayoffGame {
  id: string;
  seed: number;
  /** Bot ids by side. */
  p1: string;
  p2: string;
  winner: 1 | 2 | "draw";
  scores: [number, number];
  reason: string;
  tick: number;
}

export interface PlayoffSeries {
  round: number;
  a: PlayoffEntrant | null;
  b: PlayoffEntrant | null;
  games: PlayoffGame[];
  aWins: number;
  bWins: number;
  draws: number;
  /** Total game score of each side across the series (first tiebreak). */
  aScore: number;
  bScore: number;
  winner: string | null;
  status: "waiting" | "playing" | "done" | "bye";
}

export interface Playoff {
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  gamesPerSeries: number;
  entrants: PlayoffEntrant[];
  /** rounds[0] = first round … last = final. */
  rounds: PlayoffSeries[][];
  champion: PlayoffEntrant | null;
  /** The archived season this playoff closed (set once the ladder is archived). */
  seasonId: string | null;
  error?: string;
}

/** Standard bracket order: [1, 8, 4, 5, 2, 7, 3, 6] for 8, so seeds 1 and 2 can only meet in the final. */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

function emptySeries(round: number, a: PlayoffEntrant | null, b: PlayoffEntrant | null): PlayoffSeries {
  return { round, a, b, games: [], aWins: 0, bWins: 0, draws: 0, aScore: 0, bScore: 0, winner: null, status: "waiting" };
}

/** Seed a bracket from the leaderboard: the top `PLAYOFF.size` bots that played this season. Null if fewer than 2. */
export function createPlayoff(ladder: Ladder, now = new Date()): Playoff | null {
  const entrants = ladder
    .leaderboard()
    .filter((r) => r.games > 0)
    .slice(0, PLAYOFF.size)
    .map((r, i) => ({ id: r.id, name: r.name, seed: i + 1, elo: r.elo }));
  if (entrants.length < 2) return null;
  let size = 2;
  while (size < entrants.length) size *= 2;
  const order = bracketOrder(size);
  const bySeed = (s: number) => entrants[s - 1] ?? null;
  const first: PlayoffSeries[] = [];
  for (let i = 0; i < order.length; i += 2) first.push(emptySeries(0, bySeed(order[i]!), bySeed(order[i + 1]!)));
  const rounds = [first];
  for (let n = first.length / 2, r = 1; n >= 1; n /= 2, r++) rounds.push(Array.from({ length: n }, () => emptySeries(r, null, null)));
  return {
    status: "running",
    startedAt: now.toISOString(),
    finishedAt: null,
    gamesPerSeries: PLAYOFF.gamesPerSeries,
    entrants,
    rounds,
    champion: null,
    seasonId: null,
  };
}

/** Series winner: more wins, then more total score, then the better seed. */
export function decideSeries(s: PlayoffSeries): PlayoffEntrant {
  const { a, b } = s;
  if (!a || !b) return (a ?? b)!;
  if (s.aWins !== s.bWins) return s.aWins > s.bWins ? a : b;
  if (s.aScore !== s.bScore) return s.aScore > s.bScore ? a : b;
  return a.seed < b.seed ? a : b;
}

export interface RunPlayoffOptions {
  /** Called after every change (a game finished, a series decided), e.g. to persist or push to viewers. */
  onUpdate?: (p: Playoff) => void;
  /** Attempts per game when the runner itself fails (a crashed worker). Bot errors are part of the game. */
  attempts?: number;
}

/** Play the whole bracket. Series in the same round run side by side; games inside a series run in order. */
export async function runPlayoff(p: Playoff, ladder: Ladder, opts: RunPlayoffOptions = {}): Promise<Playoff> {
  const update = () => opts.onUpdate?.(p);
  const attempts = Math.max(1, opts.attempts ?? 2);

  async function playSeries(s: PlayoffSeries): Promise<void> {
    if (!s.a || !s.b) {
      s.status = "bye";
      s.winner = (s.a ?? s.b)?.id ?? null;
      return;
    }
    s.status = "playing";
    update();
    for (let g = 0; g < p.gamesPerSeries; g++) {
      // Alternate sides; the better seed starts as player 1.
      const [p1, p2] = g % 2 === 0 ? [s.a, s.b] : [s.b, s.a];
      const seed = ladder.nextSeed();
      let lastErr: unknown;
      let game: Awaited<ReturnType<Ladder["playExhibition"]>> | null = null;
      for (let t = 0; t < attempts && !game; t++) {
        try {
          game = await ladder.playExhibition(p1.id, p2.id, seed, "p");
        } catch (e) {
          lastErr = e;
        }
      }
      if (!game) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      const { result } = game;
      s.games.push({ id: game.id, seed, p1: p1.id, p2: p2.id, winner: result.winner, scores: [result.scores[0], result.scores[1]], reason: result.reason, tick: result.tick });
      const aIs1 = p1.id === s.a.id;
      s.aScore += result.scores[aIs1 ? 0 : 1];
      s.bScore += result.scores[aIs1 ? 1 : 0];
      if (result.winner === "draw") s.draws++;
      else if ((result.winner === 1) === aIs1) s.aWins++;
      else s.bWins++;
      update();
    }
    s.winner = decideSeries(s).id;
    s.status = "done";
    update();
  }

  const entrant = (id: string | null) => p.entrants.find((e) => e.id === id) ?? null;
  for (let r = 0; r < p.rounds.length; r++) {
    await Promise.all(p.rounds[r]!.map(playSeries));
    const next = p.rounds[r + 1];
    if (!next) break;
    p.rounds[r]!.forEach((s, i) => {
      const slot = next[i >> 1]!;
      if (i % 2 === 0) slot.a = entrant(s.winner);
      else slot.b = entrant(s.winner);
    });
    // The better seed is always "a" (player 1 in the first game).
    for (const s of next) if (s.a && s.b && s.b.seed < s.a.seed) [s.a, s.b] = [s.b, s.a];
    update();
  }
  p.champion = entrant(p.rounds.at(-1)![0]!.winner);
  p.status = "done";
  p.finishedAt = new Date().toISOString();
  update();
  return p;
}

export const PLAYOFF_FILE = "playoff.json";

export function savePlayoff(dir: string, p: Playoff): void {
  writeFileAtomic(path.join(dir, PLAYOFF_FILE), JSON.stringify(p));
}

export function loadPlayoff(dir: string): Playoff | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PLAYOFF_FILE), "utf8")) as Playoff;
  } catch {
    return null;
  }
}
