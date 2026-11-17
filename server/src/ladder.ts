import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MatchResult } from "@arena/engine";
import type { BotSource } from "@arena/sandbox";
import { botSeed, inProcessRunner, type MatchRun, type MatchRunner, type MatchSpec } from "./match-runner.js";
import { ELO, kFactor, updateElo } from "./elo.js";
import { dayKey, ECON, Economy, emptyEconomy, newBotPrice, publicBet, resultFor } from "./economy.js";
import { HttpError } from "./errors.js";
import type { BotRecord, LadderData, LadderStore, MatchRecord } from "./store.js";

export const NAME_RE = /^[A-Za-z0-9_-]{2,24}$/;
export const MAX_CODE_BYTES = 100 * 1024;
/** Browser-generated owner key: random hex, kept in the browser's localStorage. */
export const OWNER_RE = /^[0-9a-f]{32,128}$/;

/** Who is asking: a bot's own token and/or the owner key of the browser that submitted it. */
export interface Credentials {
  token?: string | undefined;
  owner?: string | undefined;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  name: string;
  elo: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  highScore: number | null;
  highScoreMatch: string | null;
  version: number;
  provisional: boolean;
  house: boolean;
  lastPlayedAt: string | null;
  /** Open botcoin bet on this bot, if any. */
  openBet: { stake: number; games: number; played: number } | null;
}

export class SubmitError extends HttpError {}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Wallet id (= ownerHash) of a browser owner key. Throws 400 on a malformed key. */
function walletId(owner: string): string {
  if (!OWNER_RE.test(owner)) throw new SubmitError(400, "bad owner key");
  return sha256(owner);
}

/** Field checks every submission must pass before anything else is looked at. Throws 400. */
export function validateSubmission(name: string, code: string, owner: string | undefined): void {
  if (owner !== undefined && !OWNER_RE.test(owner)) throw new SubmitError(400, "owner must be 32-128 hex characters");
  if (!NAME_RE.test(name)) throw new SubmitError(400, "name must be 2-24 characters: letters, digits, _ or -");
  validateCode(code);
}

/** Bot code must be non-empty and at most MAX_CODE_BYTES. Throws 400. */
export function validateCode(code: string): void {
  if (!code.trim()) throw new SubmitError(400, "code is empty");
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) throw new SubmitError(400, `code exceeds ${MAX_CODE_BYTES} bytes`);
}

export type SubmitQuote = { cost: number; wallet: string | null; balance: number; freeUpdate: boolean };

export class Ladder {
  readonly data: LadderData;
  /** Match index cap; replays of older matches are deleted. */
  maxMatches = 2000;

  /** How matches are played: in-process by default; the server swaps in a worker pool. */
  runner: MatchRunner = inProcessRunner;

  /** Clock for stipends and free daily updates. Injectable for tests. */
  now: () => Date = () => new Date();

  readonly economy: Economy;

  constructor(readonly store: LadderStore) {
    this.data = store.load();
    this.data.economy ??= emptyEconomy();
    this.economy = new Economy(this.data.economy, () => this.now());
  }

  /**
   * What submitting `name` would cost, and from which wallet. New bots get pricier through the season (see
   * newBotPrice). Each bot gets one free version per UTC day,
   * then ECON.updateCost. Bots with no owner key on record (legacy token-only) are free.
   */
  quoteSubmit(name: string, owner: string | undefined): SubmitQuote {
    const existing = this.byName(name);
    const h = existing?.ownerHash ?? (owner && OWNER_RE.test(owner) ? sha256(owner) : null);
    if (!h) return { cost: 0, wallet: null, balance: 0, freeUpdate: false };
    const w = this.economy.wallet(h);
    const balance = w?.balance ?? 0;
    if (existing) {
      const freeUpdate = existing.lastFreeUpdateDay !== dayKey(this.now());
      // A legacy owner without a wallet gets one (and the grant) on this submission, so it can pay.
      return { cost: freeUpdate ? 0 : ECON.updateCost, wallet: h, balance: w ? balance : ECON.startingGrant, freeUpdate };
    }
    return { cost: this.nextNewBotCost(h), wallet: h, balance: w ? balance : ECON.startingGrant, freeUpdate: false };
  }

  private ownedBots(wallet: string): BotRecord[] {
    return this.data.bots.filter((b) => !b.house && b.ownerHash && safeEqualHex(wallet, b.ownerHash));
  }

  /** New bots this wallet submitted this season. */
  private botsThisSeason(wallet: string): number {
    return this.economy.wallet(wallet)?.botsThisSeason ?? 0;
  }

  private nextNewBotCost(wallet: string): number {
    return newBotPrice(this.botsThisSeason(wallet), this.ownedBots(wallet).length > 0);
  }

  private balanceOf(wallet: string | null): number | null {
    return wallet ? (this.economy.wallet(wallet)?.balance ?? null) : null;
  }

  /** Ensure the credentials own a user bot that is linked to a wallet; returns the wallet id. */
  spender(botId: string, cred: Credentials): { bot: BotRecord; wallet: string } {
    const b = this.bot(botId);
    if (!b) throw new SubmitError(404, "no such bot");
    if (b.house) throw new SubmitError(403, `"${b.name}" is a house bot`);
    if (!this.owns(b, cred)) throw new SubmitError(403, `"${b.name}" isn't yours`);
    if (!b.ownerHash) throw new SubmitError(403, "this bot isn't linked to a browser wallet yet: open the leaderboard in the browser that owns it");
    this.economy.ensureWallet(b.ownerHash);
    return { bot: b, wallet: b.ownerHash };
  }

  /** Wallet summary for an owner key. Opens the wallet (with the starting grant) on a browser's first visit. */
  walletView(owner: string) {
    const h = walletId(owner);
    if (this.economy.ensureWallet(h)) this.save();
    const w = this.economy.wallet(h);
    const today = dayKey(this.now());
    const bots = this.ownedBots(h).map((b) => ({ id: b.id, name: b.name, nextUpdateCost: b.lastFreeUpdateDay !== today ? 0 : ECON.updateCost }));
    const botIds = new Set(bots.map((b) => b.id));
    return {
      exists: !!w,
      balance: w?.balance ?? 0,
      stipendAvailable: this.economy.stipendAvailable(h),
      ledger: [...(w?.ledger ?? [])].reverse(),
      nextNewBotCost: this.nextNewBotCost(h),
      bots,
      bets: this.data.economy!.bets.filter((b) => b.owner === h || botIds.has(b.botId)).slice(-20).reverse().map(publicBet),
      prices: ECON,
    };
  }

  claimStipend(owner: string) {
    this.economy.claimStipend(walletId(owner));
    this.save();
    return this.walletView(owner);
  }

  placeBet(botId: string, cred: Credentials, stake: number, games: number) {
    const { bot, wallet } = this.spender(botId, cred);
    const bet = this.economy.placeBet(wallet, bot.id, bot.name, stake, games);
    this.save();
    return { bet: publicBet(bet), balance: this.economy.wallet(wallet)!.balance };
  }

  /** Charge for `pairs` boost pairs (the caller queues the games). */
  chargeBoost(botId: string, cred: Credentials, pairs: number): { bot: BotRecord; balance: number } {
    const { bot, wallet } = this.spender(botId, cred);
    this.economy.debit(wallet, pairs * ECON.boostPairCost, "boost", bot.name);
    this.save();
    return { bot, balance: this.economy.wallet(wallet)!.balance };
  }

  /**
   * Charge for one unrated test game against `opponentId` and hand back its source (which stays on the
   * server). Free against house bots and your own bots, whose code you can already see.
   */
  chargeTestGame(owner: string, opponentId: string): { wallet: string; opponent: BotRecord; src: BotSource; free: boolean; cost: number; balance: number } {
    const h = walletId(owner);
    const opp = this.bot(opponentId);
    if (!opp) throw new SubmitError(404, "no such bot");
    this.economy.ensureWallet(h);
    const free = opp.house || this.owns(opp, { owner });
    const cost = free ? 0 : ECON.testGameCost;
    const src = this.source(opp);
    if (cost) {
      this.economy.debit(h, cost, "test", opp.name);
      this.save();
    }
    return { wallet: h, opponent: opp, src, free, cost, balance: this.economy.wallet(h)!.balance };
  }

  /** Give a test game's coins back (the server failed to play it). */
  refundTestGame(wallet: string, cost: number, opponentName: string): void {
    if (!cost) return;
    this.economy.credit(wallet, cost, "refund", opponentName);
    this.save();
  }

  recentBets(limit: number) {
    return this.data.economy!.bets.slice(-limit).reverse().map(publicBet);
  }

  save(): void {
    this.store.save(this.data);
  }

  bot(id: string): BotRecord | undefined {
    return this.data.bots.find((b) => b.id === id);
  }

  byName(name: string): BotRecord | undefined {
    const n = name.toLowerCase();
    return this.data.bots.find((b) => b.name.toLowerCase() === n);
  }

  /** Register (or refresh) a house bot backed by a file in bots/. Keeps its rating across restarts. */
  registerHouseBot(name: string, file: string): BotRecord {
    let b = this.byName(name);
    if (b && !b.house) throw new Error(`a user bot already uses the house name ${name}`);
    if (!b) {
      b = newRecord(`house-${name}`, name, true);
      this.data.bots.push(b);
    }
    b.file = file;
    this.save();
    return b;
  }

  /** True if the credentials prove ownership of a user bot (its token, or the owner key that submitted it). */
  owns(b: BotRecord, cred: Credentials): boolean {
    if (b.house) return false;
    if (cred.token && b.tokenHash && safeEqualHex(sha256(cred.token), b.tokenHash)) return true;
    return !!(cred.owner && OWNER_RE.test(cred.owner) && b.ownerHash && safeEqualHex(sha256(cred.owner), b.ownerHash));
  }

  /** Bot ids owned by this owner key. Each `claims` entry whose token matches links that bot to the key (migrates token-only bots). */
  mine(owner: string, claims: { id: string; token: string }[] = []): string[] {
    const h = walletId(owner);
    let changed = false;
    for (const c of claims) {
      const b = this.bot(c.id);
      if (b && !b.house && b.ownerHash !== h && this.owns(b, { token: c.token })) {
        b.ownerHash = h;
        this.economy.ensureWallet(h);
        changed = true;
      }
    }
    if (changed) this.save();
    return this.ownedBots(h).map((b) => b.id);
  }

  /**
   * Everything `submit` checks before changing anything: fields, that the name is free or yours, and that you
   * can pay. Changes nothing. Returns the bot being updated (if any) and the price.
   */
  checkSubmit(name: string, code: string, cred: Credentials): { existing: BotRecord | undefined; quote: SubmitQuote } {
    validateSubmission(name, code, cred.owner);
    const existing = this.byName(name);
    if (existing?.house) throw new SubmitError(403, `"${existing.name}" is a house bot name`);
    if (existing && !this.owns(existing, cred)) {
      throw new SubmitError(403, `"${existing.name}" is taken; updating it requires its token`);
    }
    const quote = this.quoteSubmit(name, cred.owner);
    if (quote.cost > quote.balance) {
      throw new SubmitError(
        402,
        `not enough botcoin: ${existing ? "another version today" : "a new bot"} costs ${quote.cost}, you have ${quote.balance}`,
        { cost: quote.cost, balance: quote.balance },
      );
    }
    return { existing, quote };
  }

  /**
   * Create or update a user bot. Validation of the code (sandbox init) is the caller's job.
   * Returns the record and, for a new bot, the plaintext token (never stored).
   */
  submit(
    name: string,
    code: string,
    cred: Credentials,
  ): { bot: BotRecord; token: string | null; created: boolean; cost: number; balance: number | null } {
    const { token, owner } = cred;
    // Botcoin: check the price before changing anything, then open the wallet if needed and pay.
    const { existing, quote } = this.checkSubmit(name, code, { token, owner });
    const pay = (botName: string) => {
      if (!quote.wallet) return;
      this.economy.ensureWallet(quote.wallet);
      this.economy.debit(quote.wallet, quote.cost, "submit", botName);
    };
    if (existing) {
      if (owner && !existing.ownerHash) existing.ownerHash = sha256(owner);
      pay(existing.name);
      if (quote.freeUpdate) existing.lastFreeUpdateDay = dayKey(this.now());
      existing.version++;
      existing.gamesSinceVersion = 0;
      this.store.saveCode(existing.id, code);
      this.save();
      return { bot: existing, token: null, created: false, cost: quote.cost, balance: this.balanceOf(quote.wallet) };
    }
    const plain = randomBytes(32).toString("hex");
    const b = newRecord(`b${randomBytes(6).toString("hex")}`, name, false);
    b.tokenHash = sha256(plain);
    if (owner) b.ownerHash = sha256(owner);
    if (quote.wallet) {
      const n = this.botsThisSeason(quote.wallet); // read before pay() may open the wallet
      pay(name);
      this.economy.wallet(quote.wallet)!.botsThisSeason = n + 1;
    }
    this.store.saveCode(b.id, code);
    this.data.bots.push(b);
    this.save();
    return { bot: b, token: plain, created: true, cost: quote.cost, balance: this.balanceOf(quote.wallet) };
  }

  /**
   * Delete a user bot (owner token required). Its code file goes; match history and replays stay
   * (match records embed names), so opponents' histories still render.
   */
  deleteBot(id: string, c: Credentials): BotRecord {
    const b = this.bot(id);
    if (!b) throw new SubmitError(404, "no such bot");
    if (b.house) throw new SubmitError(403, `"${b.name}" is a house bot`);
    if (!this.owns(b, c)) {
      throw new SubmitError(403, `deleting "${b.name}" requires its token or owner key`);
    }
    this.data.bots.splice(this.data.bots.indexOf(b), 1);
    this.economy.refundBets(b.id);
    this.store.deleteCode(b.id);
    this.save();
    return b;
  }

  nextSeed(): number {
    const s = this.data.nextSeed++;
    this.save();
    return s;
  }

  private matchSpec(a: BotRecord, b: BotRecord, seed: number): MatchSpec {
    return {
      seed,
      bots: [
        { src: this.source(a), rngSeed: botSeed(seed, 1) },
        { src: this.source(b), rngSeed: botSeed(seed, 2) },
      ],
    };
  }

  /** Rated and unrated games share one counter, so ids never collide. */
  private newMatchId(prefix: string): string {
    return `${prefix}${String(this.data.nextMatch++).padStart(7, "0")}`;
  }

  private source(b: BotRecord): BotSource {
    if (b.file) return { file: b.file, name: b.name };
    const code = this.store.loadCode(b.id);
    if (code === null) throw new Error(`missing code for ${b.id}`);
    return { source: code, name: b.name };
  }

  /**
   * Play one rated game: p1 vs p2 on `seed`. Records result, Elo, high scores and the replay.
   * Returns null (nothing recorded) if either bot was deleted while the game was being set up or played.
   * Several games may be in flight at once: results are applied one at a time, as each finishes.
   */
  async playGame(p1Id: string, p2Id: string, seed: number): Promise<MatchRecord | null> {
    const a = this.bot(p1Id);
    const b = this.bot(p2Id);
    if (!a || !b) throw new Error("unknown bot");
    const versions = [a.version, b.version] as const;
    const gone = () => this.bot(a.id) !== a || this.bot(b.id) !== b;
    let outcome: MatchRun;
    try {
      outcome = await this.runner(this.matchSpec(a, b, seed));
    } catch (e) {
      if (gone()) return null; // e.g. its code file vanished mid-setup
      throw e;
    }
    if (gone()) return null;
    const res = outcome.result;
    const id = this.newMatchId("m");
    const scoreA = resultFor(res.winner, 1);
    // A version bump during the game: the result still counts, but against the new version's provisional counter.
    const [ea, eb] = updateElo(a.elo, b.elo, scoreA, kFactor(a.gamesSinceVersion), kFactor(b.gamesSinceVersion));
    const at = new Date().toISOString();
    const rec: MatchRecord = {
      id,
      at,
      seed,
      p1: { id: a.id, name: a.name, version: versions[0], eloBefore: a.elo, eloAfter: ea, score: res.scores[0] },
      p2: { id: b.id, name: b.name, version: versions[1], eloBefore: b.elo, eloAfter: eb, score: res.scores[1] },
      winner: res.winner,
      reason: res.reason,
      tick: res.tick,
    };
    outcome.replay.bots = [a.name, b.name];
    this.store.saveReplay(id, outcome.replay);
    apply(a, ea, scoreA, res.scores[0], id, at);
    apply(b, eb, 1 - scoreA, res.scores[1], id, at);
    this.economy.recordGame(rec);
    this.data.matches.push(rec);
    while (this.data.matches.length > this.maxMatches) {
      const old = this.data.matches.shift()!;
      this.store.deleteReplay(old.id);
    }
    this.save();
    return rec;
  }

  /**
   * Play one unrated game (playoffs): nothing about the bots changes. The replay is saved under
   * `<prefix><counter>`, sharing the match counter so ids never collide with rated matches.
   */
  async playExhibition(p1Id: string, p2Id: string, seed: number, prefix = "x"): Promise<{ id: string; result: MatchResult }> {
    const a = this.bot(p1Id);
    const b = this.bot(p2Id);
    if (!a || !b) throw new Error("unknown bot");
    const outcome = await this.runner(this.matchSpec(a, b, seed));
    const id = this.newMatchId(prefix);
    outcome.replay.bots = [a.name, b.name];
    this.store.saveReplay(id, outcome.replay);
    this.save();
    return { id, result: outcome.result };
  }

  leaderboard(): LeaderboardRow[] {
    return [...this.data.bots]
      .sort((x, y) => y.elo - x.elo || x.name.localeCompare(y.name))
      .map((b, i) => ({
        rank: i + 1,
        id: b.id,
        name: b.name,
        elo: Math.round(b.elo),
        games: b.games,
        wins: b.wins,
        losses: b.losses,
        draws: b.draws,
        highScore: b.highScore,
        highScoreMatch: b.highScoreMatch,
        version: b.version,
        provisional: b.gamesSinceVersion < ELO.provisionalGames,
        house: b.house,
        lastPlayedAt: b.lastPlayedAt,
        openBet: openBet(this.economy.openBet(b.id)),
      }));
  }

  /** Best single-game score on the whole ladder. */
  topScore(): { botId: string; name: string; score: number; matchId: string } | null {
    let best: BotRecord | null = null;
    for (const b of this.data.bots) if (b.highScore !== null && (!best || b.highScore > best.highScore!)) best = b;
    return best ? { botId: best.id, name: best.name, score: best.highScore!, matchId: best.highScoreMatch! } : null;
  }

  recentMatches(botId: string, limit: number) {
    const out = [];
    for (let i = this.data.matches.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.data.matches[i]!;
      if (m.p1.id === botId || m.p2.id === botId) out.push(publicMatch(m));
    }
    return out;
  }
}

export function publicMatch(m: MatchRecord) {
  const side = (s: MatchRecord["p1"]) => ({
    id: s.id,
    name: s.name,
    version: s.version,
    eloBefore: Math.round(s.eloBefore),
    eloAfter: Math.round(s.eloAfter),
    score: s.score,
  });
  return { id: m.id, at: m.at, seed: m.seed, p1: side(m.p1), p2: side(m.p2), winner: m.winner, reason: m.reason, tick: m.tick };
}

function openBet(b: { stake: number; games: number; counted: unknown[] } | undefined): LeaderboardRow["openBet"] {
  return b ? { stake: b.stake, games: b.games, played: b.counted.length } : null;
}

function apply(b: BotRecord, elo: number, result: number, score: number, matchId: string, at: string): void {
  b.elo = elo;
  b.games++;
  b.gamesSinceVersion++;
  if (result === 1) b.wins++;
  else if (result === 0) b.losses++;
  else b.draws++;
  if (b.highScore === null || score > b.highScore) {
    b.highScore = score;
    b.highScoreMatch = matchId;
  }
  b.lastPlayedAt = at;
}

function newRecord(id: string, name: string, house: boolean): BotRecord {
  return {
    id,
    name,
    house,
    version: 1,
    tokenHash: null,
    file: null,
    elo: ELO.initial,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    gamesSinceVersion: 0,
    highScore: null,
    highScoreMatch: null,
    createdAt: new Date().toISOString(),
    lastPlayedAt: null,
  };
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
