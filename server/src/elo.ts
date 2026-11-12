/** Elo rating math. Ratings are stored as floats; display rounded. */

export const ELO = {
  initial: 1200,
  kProvisional: 40,
  kEstablished: 24,
  /** A bot is provisional until it has played this many games since its last submitted version. */
  provisionalGames: 10,
};

/** Expected score of A against B. */
export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

export function kFactor(gamesSinceVersion: number): number {
  return gamesSinceVersion < ELO.provisionalGames ? ELO.kProvisional : ELO.kEstablished;
}

/**
 * New ratings after one game. `scoreA` is 1 (A won), 0.5 (draw) or 0 (A lost).
 * Each side uses its own K (provisional bots move faster), so the update is not always zero-sum.
 */
export function updateElo(ra: number, rb: number, scoreA: number, kA: number, kB: number): [number, number] {
  const ea = expectedScore(ra, rb);
  return [ra + kA * (scoreA - ea), rb + kB * (1 - scoreA - (1 - ea))];
}
