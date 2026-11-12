import fs from "node:fs";
import path from "node:path";
import { Ladder } from "./ladder.js";
import { JsonFileStore, type LadderStore } from "./store.js";

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
  champion: { name: string; elo: number } | null;
}

const ID_RE = /^\d{8}-\d{6}$/;

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
  private readonly cache = new Map<string, { mtimeMs: number; ladder: Ladder; store: ArchivedStore; info: Omit<SeasonInfo, "number"> }>();

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
    const top = ladder.leaderboard()[0];
    const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)!;
    const info = {
      id,
      endedAt: new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).toISOString(),
      firstMatchAt: data.matches[0]?.at ?? null,
      lastMatchAt: data.matches.at(-1)?.at ?? null,
      bots: data.bots.length,
      matches: data.matches.length,
      champion: top && top.games > 0 ? { name: top.name, elo: top.elo } : null,
    };
    const entry = { mtimeMs, ladder, store, info };
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

  get(id: string): { ladder: Ladder; store: LadderStore } | null {
    return this.ids().includes(id) ? this.open(id) : null;
  }
}
