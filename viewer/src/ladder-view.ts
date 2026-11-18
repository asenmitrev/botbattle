import type { Replay } from "@arena/engine";

/**
 * Ladder view: the leaderboard takes the code panel's place and the board plays ladder matches one after
 * another. Each pick looks at the games it hasn't shown yet that finished since the previous pick, plus the
 * newest few, and plays the one with the biggest Elo swing (upsets first; ties go to the newest). Once it
 * has shown every game it starts over. Frontend only: the match list is the union of every bot's
 * recent matches (there is no ladder-wide match list endpoint).
 */

interface Hooks {
  /** Show and start playing a replay. Returns false if it can't be shown. */
  playReplay(replay: Replay): boolean;
  status(text: string, kind?: "" | "err" | "ok"): void;
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

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const PER_BOT = 20;
/** Newest unseen games always in the running for the next pick. */
const POOL = 5;
const SHOWN = 25;
const NEXT_DELAY_MS = 4000;
const REFRESH_MS = 10_000;
const HASH = "#ladder";

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** How much Elo the game moved: the bigger, the more unexpected the result. */
const swing = (m: Match) => Math.round(Math.max(Math.abs(m.p1.eloAfter - m.p1.eloBefore), Math.abs(m.p2.eloAfter - m.p2.eloBefore)));
/** The lower-rated bot won. */
const upset = (m: Match) => m.winner !== "draw" && (m.winner === 1 ? m.p1.eloBefore < m.p2.eloBefore : m.p2.eloBefore < m.p1.eloBefore);
const swingTag = (m: Match) => `<span class="tag${upset(m) ? " upset" : ""}" title="Elo swing${upset(m) ? ": the lower-rated bot won" : ""}">${upset(m) ? "upset " : ""}±${swing(m)}</span>`;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export interface LadderView {
  /** The replay on screen reached its last tick while playing. */
  ended(): void;
  /** Something else (a run, a file, the leaderboard dialog) put a replay on the board. */
  replaced(): void;
}

export function initLadderView(hooks: Hooks): LadderView {
  const btn = $<HTMLButtonElement>("ladder-view-btn");
  const box = $("ladder-view");
  btn.hidden = false;

  let on = false;
  let rows: Row[] = [];
  let matches: Match[] = [];
  /** Matches already shown in this cycle. */
  const seen = new Set<string>();
  let current: Match | null = null;
  /** Newest game time at the previous pick: anything after it finished while we were watching. */
  let horizon = "";
  /** Bot whose games the match list is narrowed to (click a leaderboard row). */
  let filter: string | null = null;
  let nextAt = 0;
  let nextTimer = 0;
  let refreshTimer = 0;
  let countdown = 0;
  /** Bumped on every switch so a slow replay fetch can't land after a newer choice. */
  let token = 0;

  async function load(): Promise<void> {
    rows = await getJSON<Row[]>("/api/leaderboard");
    const lists = await Promise.all(
      rows.map((r) => getJSON<Match[]>(`/api/bots/${encodeURIComponent(r.id)}/matches?limit=${PER_BOT}`).catch(() => [] as Match[])),
    );
    const byId = new Map<string, Match>();
    for (const m of lists.flat()) byId.set(m.id, m);
    matches = [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  }

  async function refresh(): Promise<void> {
    try {
      await load();
    } catch (e) {
      box.querySelector(".lv-meta")!.textContent = `Could not load the ladder: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (on) render();
  }

  /** Play the most recent match not shown yet in this cycle (or start a new cycle). */
  async function next(): Promise<void> {
    clearTimeout(nextTimer);
    clearInterval(countdown);
    nextAt = 0;
    await refresh();
    if (!on) return;
    if (!matches.some((x) => !seen.has(x.id))) seen.clear();
    const unseen = matches.filter((x) => !seen.has(x.id)); // newest first
    const pool = unseen.filter((x, i) => i < POOL || (horizon && x.at > horizon));
    // Biggest swing wins; the sort is stable, so ties keep newest-first order.
    const m = [...pool].sort((a, b) => swing(b) - swing(a))[0];
    horizon = matches[0]?.at ?? horizon;
    if (!m) {
      current = null;
      render();
      return;
    }
    await playMatch(m);
  }

  async function playMatch(m: Match): Promise<void> {
    const mine = ++token;
    seen.add(m.id);
    current = m;
    render();
    try {
      const replay = await getJSON<Replay>(`/api/matches/${encodeURIComponent(m.id)}/replay`);
      if (mine !== token || !on) return;
      if (!hooks.playReplay(replay)) throw new Error("replay could not be shown");
      hooks.status(`Ladder match ${m.id}: ${m.p1.name} vs ${m.p2.name}, seed ${m.seed}, ${ago(m.at)}.`, "ok");
    } catch (e) {
      if (mine !== token || !on) return;
      hooks.status(`Skipping match ${m.id}: ${e instanceof Error ? e.message : String(e)}`, "err");
      scheduleNext(1000);
    }
  }

  function scheduleNext(ms: number): void {
    clearTimeout(nextTimer);
    clearInterval(countdown);
    nextAt = Date.now() + ms;
    nextTimer = window.setTimeout(() => void next(), ms);
    countdown = window.setInterval(renderNowPlaying, 250);
    renderNowPlaying();
  }

  function render(): void {
    const top = matches[0];
    box.querySelector(".lv-meta")!.textContent = `${rows.length} bots · ${matches.length} recent matches` + (top ? ` · last game ${ago(top.at)}` : "");
    const playing = new Set(current ? [current.p1.id, current.p2.id] : []);
    $("lv-rows").innerHTML = rows
      .map((r) => {
        const side = current?.p1.id === r.id ? 1 : current?.p2.id === r.id ? 2 : 0;
        const tags = [r.house ? `<span class="tag">house</span>` : "", r.provisional ? `<span class="tag" title="Fewer than 10 games since the last version">provisional</span>` : ""].join("");
        return `<tr data-bot="${esc(r.id)}" class="${playing.has(r.id) ? `playing p${side}` : ""}${r.id === filter ? " selected" : ""}" title="Show ${esc(r.name)}'s games">
          <td>${r.rank}</td><td>${side ? `<span class="dot p${side}"></span> ` : ""}${esc(r.name)}${r.version > 1 ? ` <span class="muted">v${r.version}</span>` : ""}${tags}</td>
          <td><strong>${Math.round(r.elo)}</strong></td><td>${r.wins}-${r.losses}-${r.draws}</td><td>${r.games}</td></tr>`;
      })
      .join("");
    const list = filter ? matches.filter((m) => m.p1.id === filter || m.p2.id === filter) : matches;
    const fname = filter ? rows.find((r) => r.id === filter)?.name ?? "" : "";
    $("lv-matches-title").innerHTML = filter
      ? `${esc(fname)}'s games <button class="btn ghost small" data-lv="all">Show all</button>`
      : `Recent games <span class="muted">(click one to watch)</span>`;
    $("lv-matches").innerHTML = list.length
      ? list
          .slice(0, SHOWN)
          .map((m) => {
            const res = m.winner === "draw" ? "draw" : m.winner === 1 ? `<span class="p1">${esc(m.p1.name)}</span>` : `<span class="p2">${esc(m.p2.name)}</span>`;
            return `<div class="lv-match${m.id === current?.id ? " current" : ""}${seen.has(m.id) && m.id !== current?.id ? " seen" : ""}" data-match="${esc(m.id)}" title="Watch this match">
              <span><span class="p1">${esc(m.p1.name)}</span> ${m.p1.score} : ${m.p2.score} <span class="p2">${esc(m.p2.name)}</span></span>
              <span class="muted">${swingTag(m)} ${m.winner === "draw" ? "draw" : `${res} wins`} · ${esc(m.reason.replace("_", " "))} · ${ago(m.at)}</span></div>`;
          })
          .join("")
      : `<div class="muted">No ladder games yet.</div>`;
    renderNowPlaying();
  }

  function renderNowPlaying(): void {
    const el = $("lv-now");
    if (!current) {
      el.innerHTML = matches.length
        ? `<span class="muted">Playing a game picked elsewhere; the queue carries on after it.</span> <button class="btn ghost small" data-lv="skip">Skip ⏭</button>`
        : `<span class="muted">Waiting for ladder games…</span>`;
      return;
    }
    const m = current;
    const left = nextAt ? Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)) : 0;
    el.innerHTML = `<span class="lv-live">▶ Now playing</span>
      <span><span class="p1">${esc(m.p1.name)}</span> <span class="muted">${Math.round(m.p1.eloBefore)}</span> vs
      <span class="p2">${esc(m.p2.name)}</span> <span class="muted">${Math.round(m.p2.eloBefore)}</span></span>
      ${swingTag(m)}<span class="muted">seed ${m.seed} · ${ago(m.at)}</span>
      ${nextAt ? `<button class="btn ghost small" data-lv="skip">Next game in ${left}s ⏭</button>` : `<button class="btn ghost small" data-lv="skip" title="Go to the next most recent game">Skip ⏭</button>`}`;
  }

  function setOn(v: boolean): void {
    if (v === on) return;
    on = v;
    document.body.classList.toggle("lv-on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "✎ Code" : "Watch ladder";
    btn.title = on ? "Back to the code editor" : "Leaderboard + the most recent ladder games, one after another";
    if (location.hash === HASH ? !on : on) history.replaceState(null, "", on ? HASH : location.pathname + location.search);
    clearTimeout(nextTimer);
    clearInterval(countdown);
    clearInterval(refreshTimer);
    nextAt = 0;
    token++;
    if (!on) return;
    seen.clear();
    current = null;
    horizon = "";
    box.querySelector(".lv-meta")!.textContent = "Loading…";
    void next();
    refreshTimer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
  }

  btn.addEventListener("click", () => setOn(!on));
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-lv=skip]")) return void next();
    if (t.closest("[data-lv=all]")) return void ((filter = null), render());
    const bot = t.closest<HTMLElement>("tr[data-bot]");
    if (bot) {
      filter = filter === bot.dataset.bot ? null : bot.dataset.bot!;
      return render();
    }
    const row = t.closest<HTMLElement>("[data-match]");
    const m = row && matches.find((x) => x.id === row.dataset.match);
    if (!m) return;
    clearTimeout(nextTimer);
    clearInterval(countdown);
    nextAt = 0;
    void playMatch(m);
  });
  window.addEventListener("hashchange", () => setOn(location.hash === HASH));
  if (location.hash === HASH) setOn(true);

  return {
    ended() {
      if (on) scheduleNext(NEXT_DELAY_MS);
    },
    replaced() {
      // A game picked elsewhere (the Leaderboard dialog, a file): play it, then carry on with the queue.
      if (!on) return;
      token++;
      clearTimeout(nextTimer);
      clearInterval(countdown);
      nextAt = 0;
      current = null;
      render();
    },
  };
}
