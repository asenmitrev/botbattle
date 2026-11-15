import fs from "node:fs";
import path from "node:path";
import { emptyEconomy, resetEconomyForSeason } from "./economy.js";
import { ELO } from "./elo.js";
import { Ladder } from "./ladder.js";
import { loadPlayoff, type Playoff } from "./playoff.js";
import { JsonFileStore, type BotRecord, type LadderData, type LadderStore } from "./store.js";

/**
 * Past seasons = backups of the data dir that sit next to it, named `<data>-backup-YYYYMMDD-HHMMSS`
 * (what a ladder reset leaves behind). They are served read-only; season numbers are chronological.
 */
export interface SeasonInfo {
  id: string;
  number: number;
  /** When the season was archived (from the folder name). */
  endedAt: string;
  /** Oldest match still in the archive (the match list is capped, so this can be later than the real start). */
  firstMatchAt: string | null;
  lastMatchAt: string | null;
  bots: number;
  matches: number;
  /** The playoff winner when the season ended with a playoff, else the top of the final standings. */
  champion: { name: string; elo: number; playoff?: boolean } | null;
  hasPlayoff: boolean;
}

const ID_RE = /^\d{8}-\d{6}$/;

/** Bots that finish a season below this Elo (as the leaderboard shows it, rounded) are removed when the next season starts. */
export const SEASON_MIN_ELO = 1200;

/** Read-only view of one archived season: only the Ladder's query methods are ever used on it. */
class ArchivedStore extends JsonFileStore {
  override save(): void {
    throw new Error("archived season is read-only");
  }
  override saveCode(): void {
    throw new Error("archived season is read-only");
  }
  override saveReplay(): void {
    throw new Error("archived season is read-only");
  }
  override deleteReplay(): void {
    throw new Error("archived season is read-only");
  }
}

export class Seasons {
  private readonly parent: string;
  private readonly prefix: string;
  private readonly cache = new Map<string, { mtimeMs: number; ladder: Ladder; store: ArchivedStore; info: Omit<SeasonInfo, "number">; dir: string }>();

  constructor(dataDir: string) {
    const abs = path.resolve(dataDir);
    this.parent = path.dirname(abs);
    this.prefix = `${path.basename(abs)}-backup-`;
  }

  private ids(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.parent);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith(this.prefix) && ID_RE.test(n.slice(this.prefix.length)))
      .filter((n) => fs.existsSync(path.join(this.parent, n, "ladder.json")))
      .map((n) => n.slice(this.prefix.length))
      .sort();
  }

  private open(id: string) {
    if (!ID_RE.test(id)) return null;
    const dir = path.join(this.parent, this.prefix + id);
    const file = path.join(dir, "ladder.json");
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit;
    const store = new ArchivedStore(dir);
    const ladder = new Ladder(store);
    const data = store.load();
    const board = ladder.leaderboard();
    const top = board[0];
    const playoff = loadPlayoff(dir);
    const pc = playoff?.status === "done" && playoff.champion ? playoff.champion : null;
    const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)!;
    const info = {
      id,
      endedAt: new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).toISOString(),
      firstMatchAt: data.matches[0]?.at ?? null,
      lastMatchAt: data.matches.at(-1)?.at ?? null,
      bots: data.bots.length,
      matches: data.matches.length,
      champion: pc
        ? { name: pc.name, elo: board.find((r) => r.id === pc.id)?.elo ?? pc.elo, playoff: true }
        : top && top.games > 0
          ? { name: top.name, elo: top.elo }
          : null,
      hasPlayoff: !!playoff,
    };
    const entry = { mtimeMs, ladder, store, info, dir };
    this.cache.set(id, entry);
    return entry;
  }

  list(): SeasonInfo[] {
    const out: SeasonInfo[] = [];
    for (const id of this.ids()) {
      const s = this.open(id);
      if (s) out.push({ ...s.info, number: out.length + 1 });
    }
    return out;
  }

  get(id: string): { ladder: Ladder; store: LadderStore; dir: string } | null {
    return this.ids().includes(id) ? this.open(id) : null;
  }

  /** The playoff that closed this season, if it ended with one. */
  playoff(id: string): Playoff | null {
    const s = this.get(id);
    const p = s ? loadPlayoff(s.dir) : null;
    return p ? { ...p, seasonId: id } : null;
  }

  /** The newest archived season's playoff, if it had one. */
  latestPlayoff(): Playoff | null {
    const last = this.ids().at(-1);
    return last ? this.playoff(last) : null;
  }
}

/**
 * Start a new season. The data dir is renamed to `<data>-backup-YYYYMMDD-HHMMSS` (local time, which is how
 * Seasons reads it), so nothing is copied and old replays stay with the archive. A fresh data dir is then
 * written with every bot carried over:
 * - Each bot keeps its code, name, tokens and owner and goes back to 1200 Elo with no games.
 * - Match history and replays start empty.
 * - Botcoin wallets carry over, and open bets are refunded.
 * Bots that finished the season below `minElo` (default SEASON_MIN_ELO), judged on the ending season's Elo
 * before the reset, are left behind: they stay in the archive, code, matches and replays included.
 * The ladder server must be stopped first, or it will overwrite the new ladder.json with its in-memory state.
 */
export function startNewSeason(
  dataDir: string,
  now: Date = new Date(),
  opts: { minElo?: number } = {},
): { archive: string; id: string; bots: number; minElo: number; dropped: { name: string; elo: number }[]; refundedBets: number } {
  const minElo = opts.minElo ?? SEASON_MIN_ELO;
  const abs = path.resolve(dataDir);
  const ladderFile = path.join(abs, "ladder.json");
  if (!fs.existsSync(ladderFile)) throw new Error(`no ladder.json in ${abs}`);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const archive = `${abs}-backup-${stamp}`;
  if (fs.existsSync(archive)) throw new Error(`${archive} already exists`);

  const old = new JsonFileStore(abs).load();
  const openBets = (old.economy?.bets ?? []).filter((b) => !b.settledAt).length;
  const economy = resetEconomyForSeason(old.economy ?? emptyEconomy(), () => now);
  fs.renameSync(abs, archive);

  const fresh = new JsonFileStore(abs); // creates data/, bots/, replays/
  const oldStore = new JsonFileStore(archive);
  // Compare the Elo the leaderboard shows (rounded): a bot listed at 1200 isn't "below 1200".
  const keep = (b: BotRecord) => Math.round(b.elo) >= minElo;
  const dropped = old.bots.filter((b) => !keep(b)).map((b) => ({ name: b.name, elo: Math.round(b.elo) }));
  const bots: BotRecord[] = old.bots.filter(keep).map((b) => {
    if (!b.house) {
      const code = oldStore.loadCode(b.id);
      if (code !== null) fresh.saveCode(b.id, code);
    }
    return {
      ...b,
      elo: ELO.initial,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      gamesSinceVersion: 0,
      highScore: null,
      highScoreMatch: null,
      lastPlayedAt: null,
    };
  });
  // Counters keep counting, so match ids and seeds never repeat across seasons.
  const data: LadderData = { formatVersion: 1, nextSeed: old.nextSeed, nextMatch: old.nextMatch, bots, matches: [], economy };
  fresh.save(data);
  return { archive, id: stamp, bots: bots.length, minElo, dropped, refundedBets: openBets };
}
