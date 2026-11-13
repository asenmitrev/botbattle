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
  /** Queued boost pairs. */
  boosted?: number;
  openBet?: { stake: number; games: number; played: number } | null;
}

interface PublicBet {
  id: string;
  botId: string;
  botName: string;
  stake: number;
  games: number;
  played: number;
  actual: number;
  expected: number;
  placedAt: string;
  settledAt: string | null;
  payout: number | null;
  outcome: "settled" | "refunded" | null;
}

interface WalletView {
  exists: boolean;
  balance: number;
  stipendAvailable: boolean;
  nextNewBotCost: number;
  bots: { id: string; name: string; nextUpdateCost: number }[];
  ledger: { at: string; delta: number; kind: string; ref?: string; count?: number }[];
  bets: PublicBet[];
  prices: {
    boostPairCost: number; maxBoostPairsQueued: number; betMinStake: number; betMaxStake: number; betGames: number[]; dailyStipend: number;
    newBotCost: number; updateCost: number; winPayout: number; drawPayout: number;
  };
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

/** Botcoin amount: up to 2 decimals, trailing zeros trimmed (132, 132.1, 132.05). */
const coin = (x: number) => String(Math.round(x * 100) / 100);
const signed = (x: number) => `${x >= 0 ? "+" : ""}${coin(x)}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `HTTP ${r.status}`);
  return out;
}

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

  // ---------------------------------------------------------------- botcoin wallet
  let wallet: WalletView | null = null;
  const submitBtnEl = $<HTMLButtonElement>("submit-btn");
  async function loadWallet(): Promise<void> {
    try {
      wallet = await postJSON<WalletView>("/api/wallet", { owner: owner() });
    } catch {
      wallet = null;
    }
    renderWallet();
    announceSettled();
  }
  /** What submitting the typed name would cost from this browser's wallet. */
  function submitCost(): number {
    if (!wallet) return 0;
    const n = nameInput.value.trim().toLowerCase();
    const mineBot = wallet.bots.find((b) => b.name.toLowerCase() === n);
    return mineBot ? mineBot.nextUpdateCost : wallet.nextNewBotCost;
  }
  let shownBalance: number | null = null;
  const LEDGER_LABEL: Record<string, string> = {
    grant: "Starting grant", stipend: "Daily stipend", win: "Wins", draw: "Draws", boost: "Boost", bet: "Bet placed",
    payout: "Bet payout", refund: "Bet refund", submit: "Submission", admin: "Adjustment",
  };
  function renderWallet(): void {
    $("wallet-wrap").hidden = false;
    const bal = wallet?.exists ? wallet.balance : 0;
    $("wallet-balance").textContent = coin(bal);
    // Flash the chip and float the difference whenever the balance moves (wins, payouts, spending).
    if (shownBalance !== null && wallet?.exists && bal !== shownBalance) {
      const d = bal - shownBalance;
      const chip = $("wallet-chip");
      const delta = $("wallet-delta");
      delta.textContent = signed(d);
      delta.className = `wallet-delta ${d > 0 ? "up" : "down"}`;
      chip.classList.remove("flash");
      void delta.offsetWidth; // restart the animations
      delta.classList.add("show");
      chip.classList.add("flash");
    }
    if (wallet?.exists) shownBalance = bal;
    const st = $("stipend-btn");
    st.hidden = !wallet?.exists || !wallet.stipendAvailable;
    if (wallet) st.textContent = `Claim +${wallet.prices.dailyStipend}`;
    const lw = $("ladder-wallet");
    lw.hidden = !wallet?.exists;
    lw.textContent = `🪙 ${coin(bal)}`;
    const cost = submitCost();
    submitBtnEl.innerHTML = `Submit to ladder${wallet ? (cost ? `<span class="cost-badge">${cost} 🪙</span>` : `<span class="free-badge">free</span>`) : ""}`;
    submitBtnEl.title = cost
      ? `Costs ${cost} botcoin (extra bots, and extra versions on the same day, cost coins)`
      : "Free: your first bot, or this bot's first version today";
    renderWalletPop();
  }
  function renderWalletPop(): void {
    const pop = $("wallet-pop");
    if (!wallet || !wallet.exists) {
      pop.innerHTML = `<h4>🪙 Botcoin</h4>
        <p>Submit your first bot to the ladder (it's <strong>free</strong>) and get <span class="big">100</span> botcoin.</p>
        <ul><li>Claim +20 every day, and earn a little when your bot wins (+0.1) or draws (+0.01).</li>
        <li>Spend them to <strong>boost</strong> your bot (priority games) or <strong>bet</strong> on its next games.</li>
        <li>Extra bots and extra versions on the same day cost coins.</li></ul>`;
      return;
    }
    const p = wallet.prices;
    const ledger = wallet.ledger;
    const bets = wallet.bets.slice(0, 8);
    pop.innerHTML = `<h4>🪙 Botcoin</h4>
      <div><span class="big">${coin(wallet.balance)}</span> <span class="muted">botcoin</span></div>
      <ul>
        <li><strong>Earn</strong>: +${p.winPayout} per win, +${p.drawPayout} per draw, +${p.dailyStipend} daily${wallet.stipendAvailable ? " <strong>(ready to claim)</strong>" : ""}</li>
        <li><strong>Boost</strong>: ${p.boostPairCost} for 2 priority games</li>
        <li><strong>Bet</strong> ${p.betMinStake}–${p.betMaxStake} on your bot's next ${p.betGames.join("/")} games: up to 3× if it beats its rating</li>
        <li><strong>Submit</strong>: next new bot ${wallet.nextNewBotCost}, 1 free version per bot per day, then ${p.updateCost}</li>
      </ul>
      <div class="muted">Boost and bet from your bot's panel in the <strong>Leaderboard</strong>.</div>
      ${bets.length ? `<div class="pop-section"><strong>Your bets</strong>${bets.map(betLine).join("")}</div>` : ""}
      ${ledger.length ? `<div class="pop-section"><strong>Recent activity</strong></div>` : ""}
      ${ledger.length ? `<div class="ledger">${ledger
        .slice(0, 25)
        .map((l) => `<div><span>${esc(LEDGER_LABEL[l.kind] ?? l.kind)}${l.ref ? ` · ${esc(l.ref)}` : ""}${l.count && l.count > 1 ? ` ×${l.count}` : ""}</span><span class="${l.delta >= 0 ? "up" : "down"}">${signed(l.delta)}</span></div>`)
        .join("")}</div>` : ""}`;
  }
  /** One bet in the wallet panel: open (progress) or settled (profit/loss). */
  function betLine(b: PublicBet): string {
    const what = `${esc(b.botName)} · ${b.stake} 🪙 on ${b.games}`;
    if (!b.settledAt) {
      return `<div class="bet-line"><span>🎲 ${what}</span><span class="muted">${b.played}/${b.games} · ${b.actual} vs ${b.expected} exp.</span></div>`;
    }
    if (b.outcome === "refunded") return `<div class="bet-line"><span>${what}</span><span class="muted">refunded</span></div>`;
    const net = (b.payout ?? 0) - b.stake;
    return `<div class="bet-line"><span>${net >= 0 ? "✅" : "❌"} ${what}</span><span class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${net} (${b.actual}/${b.games} vs ${b.expected})</span></div>`;
  }
  /** Bets seen open last time: when one settles, say so. */
  let openBetIds: Set<string> | null = null;
  function announceSettled(): void {
    if (!wallet?.exists) return;
    const nowOpen = new Set(wallet.bets.filter((b) => !b.settledAt).map((b) => b.id));
    if (openBetIds) {
      for (const b of wallet.bets) {
        if (!openBetIds.has(b.id) || !b.settledAt || b.outcome !== "settled") continue;
        const net = (b.payout ?? 0) - b.stake;
        hooks.status(
          `🎲 Bet settled: ${b.botName} scored ${b.actual} vs ${b.expected} expected over ${b.games} games. Payout ${b.payout} 🪙 (${net >= 0 ? "+" : ""}${net}).`,
          net >= 0 ? "ok" : "err",
        );
      }
    }
    openBetIds = nowOpen;
  }

  $("wallet-chip").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("wallet-pop");
    pop.hidden = !pop.hidden;
    $("wallet-chip").setAttribute("aria-expanded", String(!pop.hidden));
    if (!pop.hidden) void loadWallet();
  });
  document.addEventListener("click", (e) => {
    const pop = $("wallet-pop");
    if (!pop.hidden && !(e.target as HTMLElement).closest(".wallet-wrap")) {
      pop.hidden = true;
      $("wallet-chip").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("wallet-pop").hidden = true;
  });
  // Keep the balance live so win payouts show up as they happen.
  window.setInterval(() => {
    if (!document.hidden) void loadWallet();
  }, 15_000);
  $("stipend-btn").addEventListener("click", async () => {
    try {
      wallet = await postJSON<WalletView>("/api/wallet/stipend", { owner: owner() });
      renderWallet();
      hooks.status(`Claimed today's botcoin: you have 🪙 ${coin(wallet.balance)}.`, "ok");
    } catch (e) {
      hooks.status(`Could not claim: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  });

  const nameInput = $<HTMLInputElement>("ladder-name");
  nameInput.addEventListener("input", renderWallet);
  void loadWallet();
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
      void loadWallet();
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
      if (!season) void loadWallet();
      $("ladder-meta").textContent =
        `${rows.length} bots` + (top ? ` · top score ${top.score} by ${top.name}` : "") + (health.busy || health.queue ? ` · ${health.queue + (health.busy ? 1 : 0)} games in queue` : "");
      $("ladder-rows").innerHTML = rows
        .map((r) => {
          const mine = isMine(r.id);
          const tags = [
            mine ? `<span class="tag you">you</span>` : "",
            r.boosted ? `<span class="tag boost" title="${r.boosted} boost pair(s) queued">⚡${r.boosted}</span>` : "",
            r.openBet ? `<span class="tag bet" title="Open bet: ${r.openBet.stake} 🪙 on the next ${r.openBet.games} games">🎲 ${r.openBet.played}/${r.openBet.games}</span>` : "", r.house ? `<span class="tag">house</span>` : "", r.provisional ? `<span class="tag" title="Fewer than 10 games since the last version">provisional</span>` : ""].join("");
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
    const coins = !season && isMine(botId) ? coinPanel(botId) : "";
    if (!ms.length) {
      box.innerHTML = `<h4>${esc(name)}: recent matches${del}</h4>${coins}<div class="muted">No games yet.</div>`;
      return;
    }
    box.innerHTML =
      `<h4>${esc(name)}: recent matches <span class="muted">(click to watch)</span>${del}</h4>${coins}` +
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

  /** Boost and bet controls for one of your own bots. */
  function coinPanel(botId: string): string {
    if (!wallet?.exists) return "";
    const p = wallet.prices;
    const open = wallet.bets.find((b) => b.botId === botId && !b.settledAt);
    const last = wallet.bets.find((b) => b.botId === botId && b.settledAt);
    const opts = (xs: number[], f: (x: number) => string) => xs.map((x) => `<option value="${x}">${f(x)}</option>`).join("");
    const bet = open
      ? `<span class="group">🎲 ${open.stake} 🪙 on ${open.games} games: ${open.played} played, ${open.actual} scored vs ${open.expected} expected</span>`
      : `<span class="group">🎲 Bet <input data-coin="stake" type="number" min="${p.betMinStake}" max="${p.betMaxStake}" value="${Math.max(p.betMinStake, Math.min(20, Math.floor(wallet.balance)))}" />
          🪙 on the next <select data-coin="games">${opts(p.betGames, (g) => `${g} games`)}</select>
          <button class="btn small" data-coin="bet" data-id="${esc(botId)}" title="Payout = stake × (score ÷ Elo-expected score), up to 3×">Bet</button></span>`;
    const result = last && !open ? `<span class="muted">Last bet: ${last.stake} → ${last.payout} 🪙${last.outcome === "refunded" ? " (refunded)" : ""}</span>` : "";
    return `<div class="coin-panel"><span class="coin-title">🪙 Botcoin</span>
      <span class="group">⚡ Boost <select data-coin="pairs">${opts([1, 2, 3, 4, 5], (n) => `${n * 2} games · ${n * p.boostPairCost} 🪙`)}</select>
        <button class="btn small" data-coin="boost" data-id="${esc(botId)}" title="Priority games now, ahead of background games (max ${p.maxBoostPairsQueued} pairs queued)">Boost</button></span>
      ${bet}${result}<span class="bal">🪙 ${coin(wallet.balance)}</span></div>`;
  }

  async function coinAction(btn: HTMLButtonElement): Promise<void> {
    const panel = btn.closest<HTMLElement>(".coin-panel")!;
    const id = btn.dataset.id!;
    const val = (k: string) => Number(panel.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-coin="${k}"]`)?.value);
    const name = $("ladder-rows").querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`)?.children[1]?.firstChild?.textContent ?? "";
    btn.disabled = true;
    try {
      if (btn.dataset.coin === "boost") {
        const r = await postJSON<{ queuedGames: number; balance: number }>(`/api/bots/${encodeURIComponent(id)}/boost`, { owner: owner(), pairs: val("pairs") });
        hooks.status(`Boosted ${name}: ${r.queuedGames} priority games queued. 🪙 ${coin(r.balance)} left.`, "ok");
      } else {
        const r = await postJSON<{ bet: PublicBet; balance: number }>(`/api/bots/${encodeURIComponent(id)}/bet`, { owner: owner(), stake: val("stake"), games: val("games") });
        hooks.status(`Bet ${r.bet.stake} 🪙 on ${name}'s next ${r.bet.games} games. 🪙 ${coin(r.balance)} left.`, "ok");
      }
      await loadWallet();
      await refresh();
      await showMatches(id, name);
    } catch (e) {
      hooks.status(`${btn.dataset.coin === "boost" ? "Boost" : "Bet"} failed: ${e instanceof Error ? e.message : String(e)}`, "err");
      btn.disabled = false;
    }
  }

  async function showBets(): Promise<void> {
    const box = $("ladder-matches");
    box.hidden = false;
    selected = null;
    for (const x of document.querySelectorAll("#ladder-rows tr")) x.classList.remove("selected");
    try {
      const bets = await getJSON<PublicBet[]>("/api/bets?limit=50");
      box.innerHTML =
        `<h4>Recent bets <span class="muted">(payout = stake × score ÷ Elo-expected, up to 3×)</span></h4>` +
        (bets.length
          ? bets
              .map((b) => {
                const state = !b.settledAt
                  ? `<span class="muted">${b.played}/${b.games} played</span>`
                  : b.outcome === "refunded"
                    ? `<span class="muted">refunded</span>`
                    : `<span class="${b.payout! >= b.stake ? "up" : ""}">→ ${b.payout} 🪙</span>`;
                return `<div class="bet-row"><span><strong>${esc(b.botName)}</strong> <span class="muted">· ${b.games} games · ${b.actual} vs ${b.expected} expected · ${fmtDate(b.placedAt)}</span></span>
                  <span>${b.stake} 🪙</span>${state}</div>`;
              })
              .join("")
          : `<div class="muted">No bets yet.</div>`);
    } catch (e) {
      box.innerHTML = `<div class="muted">Could not load bets: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
    }
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
    const coinBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-coin]");
    if (coinBtn) return void coinAction(coinBtn);
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
  $("bets-btn").addEventListener("click", () => void showBets());
  $("close-ladder").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => clearInterval(timer));
}
