/**
 * Botcoin: play money per owner key (wallet id = sha256 of the browser owner key, the same `ownerHash`
 * bots carry). Coins pay for extra bots, extra versions and priority (boost) games, and can be staked
 * on a bot's next N rated games. Wins pay a little back. Pure bookkeeping over `EconomyData`, which lives
 * inside ladder.json so results and coins are saved in one atomic write.
 */
import { expectedScore } from "./elo.js";
import type { MatchRecord } from "./store.js";

export const ECON = {
  startingGrant: 100,
  dailyStipend: 20,
  winPayout: 0.1,
  drawPayout: 0.01,
  /** One boost = one pair of games (both sides, one seed). */
  boostPairCost: 5,
  maxBoostPairsQueued: 10,
  /** The first bot an owner submits is free (it opens the wallet); every further bot costs this. */
  newBotCost: 30,
  /** One free new version per bot per UTC day; further versions that day cost this. */
  updateCost: 5,
  betMinStake: 5,
  betMaxStake: 500,
  betGames: [4, 10, 20] as readonly number[],
  /** Bet payout = stake × clamp(actual / expected, 0, maxBetMultiplier). */
  maxBetMultiplier: 3,
  ledgerSize: 50,
  settledBetsKept: 200,
} as const;

export type LedgerKind = "grant" | "stipend" | "win" | "draw" | "boost" | "bet" | "payout" | "refund" | "submit" | "admin";

export interface LedgerEntry {
  at: string;
  delta: number;
  kind: LedgerKind;
  ref?: string;
  /** Consecutive entries of the same kind and ref (e.g. win payouts) are merged; this counts them. */
  count?: number;
}

export interface Wallet {
  balance: number;
  createdAt: string;
  lastStipendDay: string | null;
  /** Newest last. */
  ledger: LedgerEntry[];
}

export interface BetGame {
  matchId: string;
  /** 1 win, 0.5 draw, 0 loss. */
  result: number;
  /** Elo expected score going into the game. */
  expected: number;
}

export interface Bet {
  id: string;
  /** ownerHash of the wallet that staked. */
  owner: string;
  botId: string;
  botName: string;
  stake: number;
  games: number;
  placedAt: string;
  counted: BetGame[];
  settledAt?: string;
  payout?: number;
  /** "settled" by playing out, or "refunded" (bot deleted, season reset). */
  outcome?: "settled" | "refunded";
}

export interface EconomyData {
  wallets: Record<string, Wallet>;
  /** Open bets plus the most recent settled ones. */
  bets: Bet[];
  nextBet: number;
}

export function emptyEconomy(): EconomyData {
  return { wallets: {}, bets: [], nextBet: 1 };
}

export class EconomyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Coins are kept to the cent; rounding after every change keeps float error from piling up. */
export const cents = (x: number): number => Math.round(x * 100) / 100;

/** UTC day key, e.g. "2026-11-13". */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function betPayout(stake: number, counted: readonly BetGame[]): number {
  const expected = counted.reduce((s, g) => s + g.expected, 0);
  const actual = counted.reduce((s, g) => s + g.result, 0);
  if (expected <= 0) return stake;
  return Math.round(stake * Math.min(ECON.maxBetMultiplier, Math.max(0, actual / expected)));
}

export class Economy {
  constructor(readonly data: EconomyData, private readonly now: () => Date = () => new Date()) {}

  wallet(owner: string): Wallet | undefined {
    return this.data.wallets[owner];
  }

  /** Open a wallet with the starting grant. Returns true if it was created. */
  ensureWallet(owner: string): boolean {
    if (this.data.wallets[owner]) return false;
    this.data.wallets[owner] = { balance: 0, createdAt: this.now().toISOString(), lastStipendDay: null, ledger: [] };
    this.credit(owner, ECON.startingGrant, "grant");
    return true;
  }

  credit(owner: string, amount: number, kind: LedgerKind, ref?: string): void {
    const w = this.data.wallets[owner];
    if (!w || amount === 0) return;
    w.balance = cents(w.balance + amount);
    this.log(w, amount, kind, ref);
  }

  /** Take coins or throw 402. Nothing changes on failure. */
  debit(owner: string, amount: number, kind: LedgerKind, ref?: string): void {
    const w = this.data.wallets[owner];
    if (!w) throw new EconomyError(402, "no botcoin wallet: submit a bot first");
    if (amount <= 0) return;
    if (w.balance < amount) throw new EconomyError(402, `not enough botcoin: costs ${amount}, you have ${w.balance}`);
    w.balance = cents(w.balance - amount);
    this.log(w, -amount, kind, ref);
  }

  private log(w: Wallet, delta: number, kind: LedgerKind, ref?: string): void {
    const at = this.now().toISOString();
    const last = w.ledger[w.ledger.length - 1];
    if (last && (kind === "win" || kind === "draw") && last.kind === kind && last.ref === ref) {
      last.delta = cents(last.delta + delta);
      last.count = (last.count ?? 1) + 1;
      last.at = at;
      return;
    }
    w.ledger.push({ at, delta, kind, ...(ref ? { ref } : {}) });
    if (w.ledger.length > ECON.ledgerSize) w.ledger.splice(0, w.ledger.length - ECON.ledgerSize);
  }

  stipendAvailable(owner: string): boolean {
    const w = this.data.wallets[owner];
    return !!w && w.lastStipendDay !== dayKey(this.now());
  }

  claimStipend(owner: string): void {
    const w = this.data.wallets[owner];
    if (!w) throw new EconomyError(404, "no botcoin wallet: submit a bot first");
    const today = dayKey(this.now());
    if (w.lastStipendDay === today) throw new EconomyError(409, "today's stipend is already claimed");
    w.lastStipendDay = today;
    this.credit(owner, ECON.dailyStipend, "stipend");
  }

  openBet(botId: string): Bet | undefined {
    return this.data.bets.find((b) => b.botId === botId && !b.settledAt);
  }

  placeBet(owner: string, botId: string, botName: string, stake: number, games: number): Bet {
    if (!Number.isInteger(stake) || stake < ECON.betMinStake || stake > ECON.betMaxStake) {
      throw new EconomyError(400, `stake must be a whole number from ${ECON.betMinStake} to ${ECON.betMaxStake}`);
    }
    if (!ECON.betGames.includes(games)) throw new EconomyError(400, `games must be one of ${ECON.betGames.join(", ")}`);
    if (this.openBet(botId)) throw new EconomyError(409, "this bot already has an open bet");
    const id = `bet${this.data.nextBet}`;
    this.debit(owner, stake, "bet", botName);
    this.data.nextBet++;
    const bet: Bet = { id, owner, botId, botName, stake, games, placedAt: this.now().toISOString(), counted: [] };
    this.data.bets.push(bet);
    return bet;
  }

  /**
   * A rated game finished: pay the owners for wins/draws and advance (and maybe settle) open bets.
   * `owners` maps each side's bot id to its ownerHash (null for house or unlinked bots).
   */
  recordGame(m: MatchRecord, owners: { p1: string | null; p2: string | null }): void {
    const sides = [
      { me: m.p1, opp: m.p2, owner: owners.p1, result: m.winner === "draw" ? 0.5 : m.winner === 1 ? 1 : 0 },
      { me: m.p2, opp: m.p1, owner: owners.p2, result: m.winner === "draw" ? 0.5 : m.winner === 2 ? 1 : 0 },
    ];
    for (const s of sides) {
      if (s.owner) {
        if (s.result === 1) this.credit(s.owner, ECON.winPayout, "win", s.me.name);
        else if (s.result === 0.5) this.credit(s.owner, ECON.drawPayout, "draw", s.me.name);
      }
      const bet = this.openBet(s.me.id);
      if (!bet) continue;
      bet.counted.push({ matchId: m.id, result: s.result, expected: expectedScore(s.me.eloBefore, s.opp.eloBefore) });
      if (bet.counted.length >= bet.games) {
        bet.payout = betPayout(bet.stake, bet.counted);
        bet.settledAt = this.now().toISOString();
        bet.outcome = "settled";
        this.credit(bet.owner, bet.payout, "payout", bet.botName);
      }
    }
    this.pruneBets();
  }

  /** Refund open bets (one bot, or all of them with no id). */
  refundBets(botId?: string): number {
    let n = 0;
    for (const b of this.data.bets) {
      if (b.settledAt || (botId !== undefined && b.botId !== botId)) continue;
      b.settledAt = this.now().toISOString();
      b.payout = b.stake;
      b.outcome = "refunded";
      this.credit(b.owner, b.stake, "refund", b.botName);
      n++;
    }
    this.pruneBets();
    return n;
  }

  private pruneBets(): void {
    const settled = this.data.bets.filter((b) => b.settledAt);
    const drop = settled.length - ECON.settledBetsKept;
    if (drop <= 0) return;
    const gone = new Set(settled.slice(0, drop));
    this.data.bets = this.data.bets.filter((b) => !gone.has(b));
  }
}

/** Public view of a bet (no owner hash). */
export function publicBet(b: Bet) {
  const expected = b.counted.reduce((s, g) => s + g.expected, 0);
  const actual = b.counted.reduce((s, g) => s + g.result, 0);
  return {
    id: b.id,
    botId: b.botId,
    botName: b.botName,
    stake: b.stake,
    games: b.games,
    played: b.counted.length,
    actual,
    expected: Math.round(expected * 100) / 100,
    placedAt: b.placedAt,
    settledAt: b.settledAt ?? null,
    payout: b.payout ?? null,
    outcome: b.outcome ?? null,
  };
}

/**
 * Season reset: wallets carry over, open bets are refunded and the bet history is cleared.
 * Call it on the economy of the ladder.json that seeds the new season.
 */
export function resetEconomyForSeason(data: EconomyData, now: () => Date = () => new Date()): EconomyData {
  new Economy(data, now).refundBets();
  return { wallets: data.wallets, bets: [], nextBet: data.nextBet };
}
