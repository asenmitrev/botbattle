import type { Replay } from "@arena/engine";

/** Playground ↔ ladder server integration. Everything stays hidden unless /api/health answers. */

interface Hooks {
  getCode(): string;
  /** Returns false (after reporting why) if the replay can't be shown. */
  showReplay(replay: Replay): boolean;
  status(text: string, kind?: "" | "err" | "ok"): void;
  /** Called after the user deleted their own ladder bot. */
  botDeleted?(id: string): void;
}

interface Row {
  rank: number;
  id: string;
  name: string;
  elo: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  highScore: number | null;
  version: number;
  provisional: boolean;
  house: boolean;
}

interface Side {
  id: string;
  name: string;
  eloBefore: number;
  eloAfter: number;
  score: number;
}
interface Match {
  id: string;
  at: string;
  seed: number;
  p1: Side;
  p2: Side;
  winner: 1 | 2 | "draw";
  reason: string;
}

interface Season {
  id: string;
  number: number;
  endedAt: string;
  firstMatchAt: string | null;
  bots: number;
  matches: number;
  champion: { name: string; elo: number } | null;
}

interface Identity {
  name: string;
  token: string;
  id: string;
}

const KEY = "bot-arena:ladder";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function loadIdentity(): Identity | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.token === "string" ? (v as Identity) : null;
  } catch {
    return null;
  }
}
function saveIdentity(i: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(i));
  } catch {
    /* best effort */
  }
}
function clearIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

/**
 * This browser's owner key: random, generated once, sent with every submission. The server keeps
 * only its hash on each bot, so every bot submitted from this browser is recognised as yours.
 */
const OWNER_KEY = "bot-arena:owner";
let ownerKey: string | null = null;
function owner(): string {
  if (ownerKey) return ownerKey;
  try {
    const v = localStorage.getItem(OWNER_KEY);
    if (v && /^[0-9a-f]{32,128}$/.test(v)) return (ownerKey = v);
  } catch {
    /* storage blocked: fall through to a key for this page load only */
  }
  ownerKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    localStorage.setItem(OWNER_KEY, ownerKey);
  } catch {
    /* best effort */
  }
  return ownerKey;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function initLadder(hooks: Hooks): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch("/api/health", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok || !((await r.json()) as { ok?: boolean }).ok) return;
  } catch {
    return; // no ladder server (plain playground / arena view)
  }

  let me = loadIdentity();
  /** Ids of the bots this browser owns (by owner key, plus the legacy single stored token). */
  let mineIds = new Set<string>(me ? [me.id] : []);
  const isMine = (id: string) => mineIds.has(id);
  /** Ask the server which bots are ours; the stored legacy token links its bot to the owner key on first run. */
  async function syncMine(): Promise<void> {
    try {
      const r = await fetch("/api/mine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: owner(), claims: me ? [{ id: me.id, token: me.token }] : [] }),
      });
      if (r.ok) mineIds = new Set([...((await r.json()) as { ids: string[] }).ids, ...(me ? [me.id] : [])]);
    } catch {
      /* keep what we have */
    }
  }
  void syncMine();
  const nameInput = $<HTMLInputElement>("ladder-name");
  if (me) nameInput.value = me.name;
  $("ladder-controls").hidden = false;
  $("leaderboard-btn").hidden = false;

  // ---------------------------------------------------------------- submit
  const submitBtn = $<HTMLButtonElement>("submit-btn");
  submitBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name)) {
      hooks.status("Ladder name must be 2-24 characters: letters, digits, _ or -", "err");
      nameInput.focus();
      return;
    }
    submitBtn.disabled = true;
    hooks.status(`Submitting ${name} to the ladder…`);
    try {
      const token = me && me.name.toLowerCase() === name.toLowerCase() ? me.token : undefined;
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, code: hooks.getCode(), token, owner: owner() }),
      });
      const body = (await r.json()) as { id?: string; name?: string; version?: number; token?: string; placementGames?: number; error?: string };
      if (!r.ok) {
        hooks.status(`Ladder submission failed: ${body.error ?? `HTTP ${r.status}`}`, "err");
        return;
      }
      if (body.token) {
        me = { name: body.name!, token: body.token, id: body.id! };
        saveIdentity(me);
      }
      if (body.id) mineIds.add(body.id);
      hooks.status(`Submitted ${body.name} v${body.version}. ${body.placementGames ?? "Placement"} placement games are queued; open the Leaderboard to follow along.`, "ok");
    } catch (e) {
      hooks.status(`Ladder submission failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- leaderboard
  const dialog = $<HTMLDialogElement>("leaderboard-dialog");
  let selected: string | null = null;
  let timer = 0;
  /** null = the live ladder; otherwise an archived season id. */
  let season: string | null = null;
  let seasons: Season[] = [];
  const api = () => (season ? `/api/seasons/${encodeURIComponent(season)}` : "/api");
  const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  async function loadSeasons(): Promise<void> {
    try {
      seasons = await getJSON<Season[]>("/api/seasons");
    } catch {
      seasons = [];
    }
    renderSeasonBar();
  }

  function renderSeasonBar(): void {
    const bar = $("season-bar");
    bar.hidden = seasons.length === 0;
    const btn = (id: string, label: string, sub: string, title: string) =>
      `<button class="btn ghost small" role="tab" data-season="${esc(id)}" aria-selected="${(season ?? "") === id}" title="${esc(title)}">${esc(label)}<span class="muted">${esc(sub)}</span></button>`;
    bar.innerHTML =
      btn("", `Season ${seasons.length + 1}`, "live", "The current ladder") +
      [...seasons]
        .reverse()
        .map((s) => btn(s.id, `Season ${s.number}`, `ended ${fmtDate(s.endedAt)}`, `${s.bots} bots · ${s.matches} matches archived` + (s.champion ? ` · champion ${s.champion.name} (${s.champion.elo})` : "")))
        .join("");
    const note = $("season-note");
    const cur = seasons.find((s) => s.id === season);
    note.hidden = !cur;
    if (cur) {
      note.textContent =
        `Final standings of season ${cur.number}, archived ${fmtDate(cur.endedAt)}.` +
        (cur.champion ? ` Champion: ${cur.champion.name} (${cur.champion.elo}).` : "") +
        ` Only the last ${cur.matches} matches${cur.firstMatchAt ? ` (since ${fmtDate(cur.firstMatchAt)})` : ""} are kept; replays recorded under older rules play only if they still play out the same.`;
    }
  }

  $("season-bar").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-season]");
    if (!b) return;
    const next = b.dataset.season || null;
    if (next === season) return;
    season = next;
    selected = null;
    $("ladder-matches").hidden = true;
    $("ladder-rows").innerHTML = "";
    renderSeasonBar();
    void refresh();
  });

  /** `withMatches`: also reload the selected bot's match list (manual refresh only, so rows never shift under the cursor). */
  async function refresh(withMatches = false): Promise<void> {
    try {
      const shown = season;
      const [rows, top, health] = await Promise.all([
        getJSON<Row[]>(`${api()}/leaderboard`),
        getJSON<{ name: string; score: number } | null>(`${api()}/highscore`),
        season ? Promise.resolve({ queue: 0, busy: false }) : getJSON<{ queue: number; busy: boolean }>("/api/health"),
      ]);
      if (shown !== season) return; // switched seasons while loading
      $("ladder-meta").textContent =
        `${rows.length} bots` + (top ? ` · top score ${top.score} by ${top.name}` : "") + (health.busy || health.queue ? ` · ${health.queue + (health.busy ? 1 : 0)} games in queue` : "");
      $("ladder-rows").innerHTML = rows
        .map((r) => {
          const mine = isMine(r.id);
          const tags = [mine ? `<span class="tag you">you</span>` : "", r.house ? `<span class="tag">house</span>` : "", r.provisional ? `<span class="tag" title="Fewer than 10 games since the last version">provisional</span>` : ""].join("");
          return `<tr data-id="${esc(r.id)}" class="${mine ? "mine" : ""} ${r.id === selected ? "selected" : ""}">
            <td>${r.rank}</td><td>${esc(r.name)}${r.version > 1 ? ` <span class="muted">v${r.version}</span>` : ""}${tags}</td>
            <td><strong>${r.elo}</strong></td><td>${r.wins}-${r.losses}-${r.draws}</td><td>${r.games}</td><td>${r.highScore ?? "–"}</td></tr>`;
        })
        .join("");
      if (selected && withMatches) await showMatches(selected, rows.find((r) => r.id === selected)?.name ?? "");
    } catch (e) {
      $("ladder-meta").textContent = `Could not load the leaderboard: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function showMatches(botId: string, name: string): Promise<void> {
    const box = $("ladder-matches");
    box.hidden = false;
    const ms = await getJSON<Match[]>(`${api()}/bots/${encodeURIComponent(botId)}/matches?limit=20`);
    // Your own live bot: offer an (inline, two-step) delete.
    const del = !season && isMine(botId) ? `<span class="bot-delete" data-id="${esc(botId)}" data-name="${esc(name)}"><button class="btn ghost small danger" data-del="ask">Delete bot</button></span>` : "";
    if (!ms.length) {
      box.innerHTML = `<h4>${esc(name)}: recent matches${del}</h4><div class="muted">No games yet.</div>`;
      return;
    }
    box.innerHTML =
      `<h4>${esc(name)}: recent matches <span class="muted">(click to watch)</span>${del}</h4>` +
      ms
        .map((m) => {
          const side = m.p1.id === botId ? 1 : 2;
          const self = side === 1 ? m.p1 : m.p2;
          const res = m.winner === "draw" ? "draw" : m.winner === side ? "win" : "loss";
          const d = Math.round(self.eloAfter - self.eloBefore);
          return `<div class="match-row" data-match="${esc(m.id)}">
            <span class="res ${res}">${res.toUpperCase()}</span>
            <span><span class="p1">${esc(m.p1.name)}</span> ${m.p1.score} : ${m.p2.score} <span class="p2">${esc(m.p2.name)}</span>
              <span class="muted"> · ${esc(m.reason.replace("_", " "))} · seed ${m.seed}</span></span>
            <span class="delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d}</span></div>`;
        })
        .join("");
  }

  /** Inline confirm: "Delete bot" → "Really delete X? …" [Confirm] [Cancel]. */
  async function deleteStep(btn: HTMLButtonElement): Promise<void> {
    const wrap = btn.closest<HTMLElement>(".bot-delete")!;
    const name = wrap.dataset.name ?? "";
    const step = btn.dataset.del;
    if (step === "ask") {
      wrap.innerHTML = `<span class="confirm-text">Really delete ${esc(name)}? This can't be undone</span>
        <button class="btn small danger" data-del="confirm">Confirm</button><button class="btn ghost small" data-del="cancel">Cancel</button>`;
      return;
    }
    if (step === "cancel") {
      wrap.innerHTML = `<button class="btn ghost small danger" data-del="ask">Delete bot</button>`;
      return;
    }
    const id = wrap.dataset.id;
    if (step !== "confirm" || !id) return;
    for (const b of wrap.querySelectorAll("button")) b.disabled = true;
    try {
      const r = await fetch(`/api/bots/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: me?.id === id ? me.token : undefined, owner: owner() }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok && r.status !== 404) {
        hooks.status(`Could not delete ${name}: ${body.error ?? `HTTP ${r.status}`}`, "err");
        wrap.innerHTML = `<button class="btn ghost small danger" data-del="ask">Delete bot</button>`;
        return;
      }
      // 404: already gone, so the stored identity is stale either way.
      mineIds.delete(id);
      if (me?.id === id) {
        me = null;
        clearIdentity();
      }
      selected = null;
      $("ladder-matches").hidden = true;
      void refresh();
      hooks.botDeleted?.(id);
      hooks.status(`Deleted ${name} from the ladder. Its past matches stay in its opponents' histories.`, "ok");
    } catch (err) {
      hooks.status(`Could not delete ${name}: ${err instanceof Error ? err.message : String(err)}`, "err");
      wrap.innerHTML = `<button class="btn ghost small danger" data-del="ask">Delete bot</button>`;
    }
  }

  $("ladder-rows").addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-id]");
    if (!tr) return;
    selected = tr.dataset.id!;
    for (const x of document.querySelectorAll("#ladder-rows tr")) x.classList.toggle("selected", x === tr);
    void showMatches(selected, tr.children[1]!.firstChild?.textContent ?? "");
  });
  $("ladder-matches").addEventListener("click", async (e) => {
    const delBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-del]");
    if (delBtn) return void deleteStep(delBtn);
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-match]");
    if (!row) return;
    try {
      const replay = await getJSON<Replay>(`${api()}/matches/${encodeURIComponent(row.dataset.match!)}/replay`);
      if (!hooks.showReplay(replay)) return;
      dialog.close();
      const where = season ? `Season ${seasons.find((s) => s.id === season)?.number ?? "?"} match` : "Ladder match";
      hooks.status(`${where} ${row.dataset.match}: ${replay.bots[0]} vs ${replay.bots[1]}, seed ${replay.seed}.`, "ok");
    } catch (err) {
      hooks.status(`Could not load replay: ${err instanceof Error ? err.message : String(err)}`, "err");
    }
  });

  $("leaderboard-btn").addEventListener("click", () => {
    dialog.showModal();
    void loadSeasons();
    void syncMine().then(() => refresh());
    clearInterval(timer);
    timer = window.setInterval(() => void (season ? undefined : refresh()), 10_000);
  });
  $("ladder-refresh").addEventListener("click", () => void refresh(true));
  $("close-ladder").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => clearInterval(timer));
}
