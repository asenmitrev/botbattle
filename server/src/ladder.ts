import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BotSource } from "@arena/sandbox";
import { inProcessRunner, type MatchRun, type MatchRunner } from "./match-runner.js";
import { ELO, kFactor, updateElo } from "./elo.js";
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
}

export class SubmitError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Ladder {
  readonly data: LadderData;
  /** Match index cap; replays of older matches are deleted. */
  maxMatches = 2000;

  /** How matches are played: in-process by default; the server swaps in a worker pool. */
  runner: MatchRunner = inProcessRunner;

  constructor(readonly store: LadderStore) {
    this.data = store.load();
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

  /**
   * Create or update a user bot. Validation of the code (sandbox init) is the caller's job.
   * Returns the record and, for a new bot, the plaintext token (never stored).
   */
  /** True if the credentials prove ownership of a user bot (its token, or the owner key that submitted it). */
  owns(b: BotRecord, cred: Credentials): boolean {
    if (b.house) return false;
    if (cred.token && b.tokenHash && safeEqualHex(sha256(cred.token), b.tokenHash)) return true;
    return !!(cred.owner && OWNER_RE.test(cred.owner) && b.ownerHash && safeEqualHex(sha256(cred.owner), b.ownerHash));
  }

  /** Bot ids owned by this owner key. Each `claims` entry whose token matches links that bot to the key (migrates token-only bots). */
  mine(owner: string, claims: { id: string; token: string }[] = []): string[] {
    if (!OWNER_RE.test(owner)) throw new SubmitError(400, "bad owner key");
    const h = sha256(owner);
    let changed = false;
    for (const c of claims) {
      const b = this.bot(c.id);
      if (b && !b.house && b.ownerHash !== h && this.owns(b, { token: c.token })) {
        b.ownerHash = h;
        changed = true;
      }
    }
    if (changed) this.save();
    return this.data.bots.filter((b) => !b.house && b.ownerHash && safeEqualHex(h, b.ownerHash)).map((b) => b.id);
  }

  submit(name: string, code: string, cred: string | undefined | Credentials): { bot: BotRecord; token: string | null; created: boolean } {
    const { token, owner } = typeof cred === "object" ? cred : { token: cred, owner: undefined };
    if (owner !== undefined && !OWNER_RE.test(owner)) throw new SubmitError(400, "bad owner key");
    if (!NAME_RE.test(name)) throw new SubmitError(400, "name must be 2-24 characters: letters, digits, _ or -");
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) throw new SubmitError(400, `code exceeds ${MAX_CODE_BYTES} bytes`);
    const existing = this.byName(name);
    if (existing?.house) throw new SubmitError(403, `"${existing.name}" is a house bot name`);
    if (existing) {
      if (!this.owns(existing, { token, owner })) {
        throw new SubmitError(403, `"${existing.name}" is taken; updating it requires its token`);
      }
      if (owner && !existing.ownerHash) existing.ownerHash = sha256(owner);
      existing.version++;
      existing.gamesSinceVersion = 0;
      this.store.saveCode(existing.id, code);
      this.save();
      return { bot: existing, token: null, created: false };
    }
    const plain = randomBytes(32).toString("hex");
    const b = newRecord(`b${randomBytes(6).toString("hex")}`, name, false);
    b.tokenHash = sha256(plain);
    if (owner) b.ownerHash = sha256(owner);
    this.store.saveCode(b.id, code);
    this.data.bots.push(b);
    this.save();
    return { bot: b, token: plain, created: true };
  }

  /**
   * Delete a user bot (owner token required). Its code file goes; match history and replays stay
   * (match records embed names), so opponents' histories still render.
   */
  deleteBot(id: string, cred: string | undefined | Credentials): BotRecord {
    const c: Credentials = typeof cred === "object" ? cred : { token: cred };
    const b = this.bot(id);
    if (!b) throw new SubmitError(404, "no such bot");
    if (b.house) throw new SubmitError(403, `"${b.name}" is a house bot`);
    if (!this.owns(b, c)) {
      throw new SubmitError(403, `deleting "${b.name}" requires its token or owner key`);
    }
    this.data.bots.splice(this.data.bots.indexOf(b), 1);
    this.store.deleteCode(b.id);
    this.save();
    return b;
  }

  nextSeed(): number {
    const s = this.data.nextSeed++;
    this.save();
    return s;
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
      outcome = await this.runner({
        seed,
        bots: [
          { src: this.source(a), rngSeed: (seed * 2 + 1) >>> 0 },
          { src: this.source(b), rngSeed: (seed * 2 + 2) >>> 0 },
        ],
      });
    } catch (e) {
      if (gone()) return null; // e.g. its code file vanished mid-setup
      throw e;
    }
    if (gone()) return null;
    const res = outcome.result;
    const id = `m${String(this.data.nextMatch++).padStart(7, "0")}`;
    const scoreA = res.winner === "draw" ? 0.5 : res.winner === 1 ? 1 : 0;
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
    this.data.matches.push(rec);
    while (this.data.matches.length > this.maxMatches) {
      const old = this.data.matches.shift()!;
      this.store.deleteReplay(old.id);
    }
    this.save();
    return rec;
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
