import fs from "node:fs";
import path from "node:path";
import type { Replay } from "@arena/engine";
import type { EconomyData } from "./economy.js";

export interface BotRecord {
  id: string;
  name: string;
  house: boolean;
  version: number;
  /** sha256 of the owner token (user bots only). */
  tokenHash: string | null;
  /** sha256 of the browser-generated owner key that submitted/claimed it (user bots; absent on old records). */
  ownerHash?: string | null;
  /** House bots: absolute path of the bot file. User bots: null (code lives in the store). */
  file: string | null;
  elo: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Games since the current version was submitted (drives provisional K). */
  gamesSinceVersion: number;
  highScore: number | null;
  highScoreMatch: string | null;
  createdAt: string;
  lastPlayedAt: string | null;
  /** UTC day this bot last used its free daily version update (botcoin). */
  lastFreeUpdateDay?: string | null;
}

export interface MatchSide {
  id: string;
  name: string;
  version: number;
  eloBefore: number;
  eloAfter: number;
  score: number;
}

export interface MatchRecord {
  id: string;
  at: string;
  seed: number;
  p1: MatchSide;
  p2: MatchSide;
  winner: 1 | 2 | "draw";
  reason: string;
  tick: number;
}

export interface LadderData {
  formatVersion: 1;
  nextSeed: number;
  nextMatch: number;
  bots: BotRecord[];
  /** Most recent last. Capped (see Ladder.maxMatches). */
  matches: MatchRecord[];
  /** Botcoin wallets and bets (absent in older files). */
  economy?: EconomyData;
}

export function emptyLadder(): LadderData {
  return { formatVersion: 1, nextSeed: 1, nextMatch: 1, bots: [], matches: [] };
}

/** Persistence boundary. The default implementation is JSON files on disk. */
export interface LadderStore {
  load(): LadderData;
  save(data: LadderData): void;
  saveCode(botId: string, code: string): void;
  loadCode(botId: string): string | null;
  deleteCode(botId: string): void;
  saveReplay(matchId: string, replay: Replay): void;
  loadReplay(matchId: string): Replay | null;
  deleteReplay(matchId: string): void;
}

/** Write a file atomically: temp file in the same directory, then rename over the target. */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * data/ladder.json        bots, match index, counters
 * data/bots/<id>.js       current code of each user bot
 * data/replays/<id>.json  full replays
 */
export class JsonFileStore implements LadderStore {
  readonly ladderFile: string;
  private readonly botsDir: string;
  private readonly replaysDir: string;

  constructor(readonly dir: string) {
    this.ladderFile = path.join(dir, "ladder.json");
    this.botsDir = path.join(dir, "bots");
    this.replaysDir = path.join(dir, "replays");
    fs.mkdirSync(this.botsDir, { recursive: true });
    fs.mkdirSync(this.replaysDir, { recursive: true });
  }

  load(): LadderData {
    if (!fs.existsSync(this.ladderFile)) return emptyLadder();
    const data = JSON.parse(fs.readFileSync(this.ladderFile, "utf8")) as LadderData;
    if (data.formatVersion !== 1) throw new Error(`unsupported ladder format ${String(data.formatVersion)}`);
    return data;
  }

  save(data: LadderData): void {
    writeFileAtomic(this.ladderFile, JSON.stringify(data));
  }

  private safe(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`bad id ${id}`);
    return id;
  }

  saveCode(botId: string, code: string): void {
    writeFileAtomic(path.join(this.botsDir, `${this.safe(botId)}.js`), code);
  }

  loadCode(botId: string): string | null {
    const f = path.join(this.botsDir, `${this.safe(botId)}.js`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  }

  deleteCode(botId: string): void {
    fs.rmSync(path.join(this.botsDir, `${this.safe(botId)}.js`), { force: true });
  }

  saveReplay(matchId: string, replay: Replay): void {
    writeFileAtomic(path.join(this.replaysDir, `${this.safe(matchId)}.json`), JSON.stringify(replay));
  }

  loadReplay(matchId: string): Replay | null {
    if (!SAFE_ID.test(matchId)) return null;
    const f = path.join(this.replaysDir, `${matchId}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Replay) : null;
  }

  deleteReplay(matchId: string): void {
    fs.rmSync(path.join(this.replaysDir, `${this.safe(matchId)}.json`), { force: true });
  }
}
