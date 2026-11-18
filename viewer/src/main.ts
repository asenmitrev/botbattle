import "./style.css";
import { marked } from "marked";
import {
  CONFIG,
  STRUCTURE_TYPES,
  UNIT_TYPES,
  UPGRADE_TYPES,
  countTotal,
  matrixTotal,
  runMatch,
  type GameEvent,
  type GameState,
  type KillMatrix,
  type MatchResult,
  type PlayerId,
  type PlayerMatchStats,
  type Replay,
} from "@arena/engine";
import readmeSource from "../../README.md?raw";
import { SAMPLE_BOTS, STARTER_SOURCE } from "./bots.js";
import { LineChart } from "./charts.js";
import { createEditor } from "./editor.js";
import { BoardRenderer, type RenderOptions } from "./renderer.js";
import { ReplayModel, type Series } from "./replay-model.js";
import { WorkerBot } from "./worker-bot.js";
import { initLadder, owner } from "./ladder.js";
import { initLadderView, type LadderView } from "./ladder-view.js";
import { SPRITE_URLS } from "./sprites.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CODE_KEY = "bot-arena:code";
const SETTINGS_KEY = "bot-arena:settings";

// ------------------------------------------------------------------ storage (best effort)
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

// ------------------------------------------------------------------ view state
let model: ReplayModel | null = null;
let t = 0;
let playing = false;
let lastFrame = 0;
let acc = 0;
let logTab: "logs" | "problems" | "stats" = "logs";
let statsScope: "tick" | "match" = "tick";
const opts: RenderOptions = { fog: 0, marks: true, attacks: true };

const board = new BoardRenderer($<HTMLCanvasElement>("board"));

// Legend: what each sprite on the board is.
const title = (t: string) => t[0]!.toUpperCase() + t.slice(1);
$("legend").innerHTML = [
  ...[...UNIT_TYPES, ...STRUCTURE_TYPES, "base"].map((t) => [t, title(t)]),
  ...UPGRADE_TYPES.map((t) => [`${t}_up`, `Upgraded ${t}`]),
]
  .filter(([k]) => k! in SPRITE_URLS)
  .map(([k, label]) => `<div class="legend-item"><img src="${SPRITE_URLS[k as keyof typeof SPRITE_URLS]}" alt="" /><span>${label}</span></div>`)
  .join("");
const charts: Record<keyof Series, LineChart> = {} as Record<keyof Series, LineChart>;
for (const el of document.querySelectorAll<HTMLElement>(".chart")) {
  charts[el.dataset.series as keyof Series] = new LineChart(el, (i) => seek(i));
}

// ------------------------------------------------------------------ editor
const settings = (() => {
  try {
    return JSON.parse(load(SETTINGS_KEY) ?? "{}") as { side?: string; opponent?: string; seed?: string };
  } catch {
    return {};
  }
})();
let code = load(CODE_KEY) ?? STARTER_SOURCE;
let saveTimer = 0;
const editor = createEditor(
  $("editor"),
  code,
  (c) => {
    code = c;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => save(CODE_KEY, c), 300);
  },
  () => void runOne(),
);

const opponentSel = $<HTMLSelectElement>("opponent-select");
const houseGroup = document.createElement("optgroup");
houseGroup.label = "House bots";
for (const name of Object.keys(SAMPLE_BOTS)) houseGroup.append(new Option(name, name));
opponentSel.append(houseGroup);
opponentSel.value = settings.opponent && SAMPLE_BOTS[settings.opponent] ? settings.opponent : "greedy";

// Ladder (user) bots join the list when the page is served by `arena server`. Value: "ladder:<id>".
const LADDER_PREFIX = "ladder:";
const ladderNames = new Map<string, string>();
let ladderGroup: HTMLOptGroupElement | null = null;
/** (Re)build the "Ladder bots" group. Safe to call again, e.g. after a bot is deleted. */
async function loadLadderBots(): Promise<void> {
  let rows: { id: string; name: string; elo: number; house: boolean; version: number }[];
  try {
    const r = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!r.ok) return;
    rows = await r.json();
  } catch {
    return;
  }
  const users = rows.filter((x) => !x.house);
  const current = opponentSel.value;
  ladderGroup?.remove();
  ladderGroup = null;
  ladderNames.clear();
  if (!users.length) {
    if (current.startsWith(LADDER_PREFIX)) opponentSel.value = "greedy";
    return;
  }
  const group = (ladderGroup = document.createElement("optgroup"));
  group.label = "Ladder bots";
  for (const b of users) {
    ladderNames.set(b.id, b.name);
    group.append(new Option(`${b.name} (${Math.round(b.elo)}) · server`, LADDER_PREFIX + b.id));
  }
  opponentSel.append(group);
  const want = current.startsWith(LADDER_PREFIX) ? current : settings.opponent;
  if (want?.startsWith(LADDER_PREFIX)) opponentSel.value = ladderNames.has(want.slice(LADDER_PREFIX.length)) ? want : current.startsWith(LADDER_PREFIX) ? "greedy" : current;
}
void loadLadderBots();

function opponentName(value: string): string {
  return value.startsWith(LADDER_PREFIX) ? (ladderNames.get(value.slice(LADDER_PREFIX.length)) ?? value) : value;
}

const sideSel = $<HTMLSelectElement>("side-select");
sideSel.value = settings.side === "2" ? "2" : "1";
const seedInput = $<HTMLInputElement>("seed-input");
if (settings.seed) seedInput.value = settings.seed;
const persistSettings = () => save(SETTINGS_KEY, JSON.stringify({ side: sideSel.value, opponent: opponentSel.value, seed: seedInput.value }));
for (const el of [opponentSel, sideSel, seedInput]) el.addEventListener("change", persistSettings);

// ------------------------------------------------------------------ status line
function status(text: string, kind: "" | "err" | "ok" = ""): void {
  const el = $("status");
  el.textContent = text;
  el.className = `status mono ${kind}`;
}

// ------------------------------------------------------------------ running matches in the browser sandbox
let running = false;

type MatchOutcome = { initError: string } | { replay: Replay; result: MatchResult; cost: number };

/** House bots play here, in Web Workers. Ladder bots play on the server: their code never comes to the browser. */
async function playMatch(seed: number, side: PlayerId, opponentValue: string, onProgress?: (tick: number) => void): Promise<MatchOutcome> {
  if (opponentValue.startsWith(LADDER_PREFIX)) return playOnServer(seed, side, opponentValue.slice(LADDER_PREFIX.length));
  const opponent = opponentName(opponentValue);
  const mine = await WorkerBot.create("my-bot", code, (seed * 2 + side) >>> 0);
  const other = side === 1 ? 2 : 1;
  const theirs = await WorkerBot.create(opponent, SAMPLE_BOTS[opponentValue]!, (seed * 2 + other) >>> 0);
  try {
    if (mine.initError) return { initError: mine.initError };
    const bots = side === 1 ? ([mine, theirs] as const) : ([theirs, mine] as const);
    let n = 0;
    const res = await runMatch([bots[0], bots[1]], {
      seed,
      onTick: (s) => {
        if (++n % 20 === 0) onProgress?.(s.tick);
      },
    });
    res.replay.bots = side === 1 ? ["my-bot", opponent] : [opponent, "my-bot"];
    return { replay: res.replay, result: res.state.result!, cost: 0 };
  } finally {
    mine.dispose();
    theirs.dispose();
  }
}

async function playOnServer(seed: number, side: PlayerId, opponentId: string): Promise<MatchOutcome> {
  const r = await fetch("/api/test-game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: owner(), code, opponent: opponentId, seed, side }),
  });
  const out = (await r.json().catch(() => ({}))) as { replay?: Replay; cost?: number; error?: string; initError?: boolean };
  if (out.initError) return { initError: out.error ?? "init failed" };
  if (!r.ok || !out.replay?.result) {
    if (r.status === 404) void loadLadderBots(); // deleted from the ladder: prune the list
    throw new Error(out.error ?? `HTTP ${r.status}`);
  }
  if (out.cost) window.dispatchEvent(new Event("botcoin-changed"));
  return { replay: out.replay, result: out.replay.result, cost: out.cost ?? 0 };
}

/** Status suffix for a paid server game. */
const paid = (cost: number) => (cost ? ` (server game, ${cost} 🪙)` : "");

function setBusy(b: boolean): void {
  running = b;
  for (const id of ["run-btn", "bench-btn"]) $<HTMLButtonElement>(id).disabled = b;
}

async function runOne(): Promise<void> {
  if (running) return;
  setBusy(true);
  const seed = Number(seedInput.value) >>> 0;
  const side = Number(sideSel.value) as PlayerId;
  const opponent = opponentName(opponentSel.value);
  status(`Running my-bot vs ${opponent} on seed ${seed}${opponentSel.value.startsWith(LADDER_PREFIX) ? " on the server" : ""}…`);
  try {
    const r = await playMatch(seed, side, opponentSel.value, (tick) => status(`Running my-bot vs ${opponent} on seed ${seed}… tick ${tick}`));
    if ("initError" in r) {
      status(`Your bot failed to start:\n${r.initError}`, "err");
      return;
    }
    showReplay(r.replay);
    const res = r.result;
    const errors = r.replay.ticks.flatMap((x) => x.runnerEvents ?? []).filter((e) => e.type === "bot_error" && e.player === side).length;
    const invalid = r.replay.ticks.flatMap((x) => x.events).filter((e) => e.type === "invalid_action" && e.player === side).length;
    const outcome = res.winner === "draw" ? "Draw" : res.winner === side ? "You win" : "You lose";
    const tail = [errors ? `${errors} failed ticks` : "", invalid ? `${invalid} invalid actions` : ""].filter(Boolean).join(", ");
    status(
      `${outcome} — ${res.reason.replace("_", " ")} at tick ${res.tick}, ` +
        (res.units ? `units ${res.units[side - 1]} vs ${res.units[2 - side]}, ` : "") +
        `score ${res.scores[side - 1]} vs ${res.scores[2 - side]}` +
        paid(r.cost) +
        (tail ? `\n${tail} (see Problems)` : ""),
      res.winner === side ? "ok" : res.winner === "draw" ? "" : "err",
    );
    play(true);
  } catch (e) {
    status(`Match crashed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    setBusy(false);
  }
}

async function runBench(): Promise<void> {
  if (running) return;
  setBusy(true);
  const opponentValue = opponentSel.value;
  const opponent = opponentName(opponentValue);
  let w = 0;
  let l = 0;
  let d = 0;
  let firstLoss: Replay | null = null;
  let last: Replay | null = null;
  let spent = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const seed = 1 + Math.floor(i / 2);
      const side = ((i % 2) + 1) as PlayerId;
      status(`Benchmark vs ${opponent}: game ${i + 1}/10 (seed ${seed}, P${side})…  ${w}W ${l}L ${d}D`);
      const r = await playMatch(seed, side, opponentValue);
      if ("initError" in r) {
        status(`Your bot failed to start:\n${r.initError}`, "err");
        return;
      }
      last = r.replay;
      spent += r.cost;
      const win = r.result.winner;
      if (win === "draw") d++;
      else if (win === side) w++;
      else {
        l++;
        firstLoss ??= r.replay;
      }
    }
    const shown = firstLoss ?? last!;
    showReplay(shown);
    status(`vs ${opponent}: ${w} wins, ${l} losses, ${d} draws over 10 games.` + paid(Math.round(spent * 100) / 100) + (firstLoss ? "\nShowing your first loss." : ""), w > l ? "ok" : l > w ? "err" : "");
  } catch (e) {
    status(`Benchmark crashed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    setBusy(false);
  }
}

$("run-btn").addEventListener("click", () => void runOne());
$("bench-btn").addEventListener("click", () => void runBench());
$("dice-btn").addEventListener("click", () => {
  seedInput.value = String(Math.floor(Math.random() * 100000));
  persistSettings();
});
$("reset-btn").addEventListener("click", () => {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: STARTER_SOURCE } });
});

// ------------------------------------------------------------------ replay loading
let currentReplay: Replay | null = null;
let ladderView: LadderView | null = null;

/** `fromLadderView`: the ladder view's own queue; anything else tells the view a game was picked elsewhere. */
function showReplay(replay: Replay, fromLadderView = false): boolean {
  try {
    model = new ReplayModel(replay);
    board.resetAim();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), "err");
    return false;
  }
  currentReplay = replay;
  $<HTMLButtonElement>("download-btn").disabled = false;
  const scrub = $<HTMLInputElement>("scrubber");
  scrub.max = String(model.lastIndex);
  for (const k of Object.keys(charts) as (keyof Series)[]) charts[k].set(model.series[k]);
  buildLogIndex();
  play(false);
  seek(0);
  if (!model.verified) status("Warning: re-simulating this replay did not reproduce its recorded final state.", "err");
  if (!fromLadderView) ladderView?.replaced();
  return true;
}

async function loadReplayText(text: string, label: string): Promise<void> {
  try {
    const r = JSON.parse(text) as Replay;
    if (r.format !== "bot-arena-replay") throw new Error("not a Bot Arena replay");
    showReplay(r);
    if (model) status(`Loaded ${label}: ${r.bots[0]} vs ${r.bots[1]}, seed ${r.seed}${model.verified ? " (verified)" : ""}.`, "ok");
  } catch (e) {
    status(`Could not load ${label}: ${e instanceof Error ? e.message : String(e)}`, "err");
  }
}

$<HTMLInputElement>("file-input").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await loadReplayText(await f.text(), f.name);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) await loadReplayText(await f.text(), f.name);
});
$("download-btn").addEventListener("click", () => {
  if (!currentReplay) return;
  const blob = new Blob([JSON.stringify(currentReplay)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentReplay.bots.join("-vs-")}-seed${currentReplay.seed}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------ playback
function seek(i: number): void {
  if (!model) return;
  t = Math.max(0, Math.min(model.lastIndex, i));
  render();
}

function play(on: boolean): void {
  playing = on && !!model;
  if (playing && model && t >= model.lastIndex) t = 0;
  $("play-btn").textContent = playing ? "⏸" : "▶";
  lastFrame = performance.now();
  acc = 0;
}

function frame(now: number): void {
  if (playing && model) {
    const speed = Number($<HTMLSelectElement>("speed").value);
    acc += ((now - lastFrame) / 1000) * 4 * speed; // 1× = 4 ticks per second
    const steps = Math.floor(acc);
    if (steps > 0) {
      acc -= steps;
      seek(t + steps);
      if (t >= model.lastIndex) {
        play(false);
        ladderView?.ended();
      }
    }
  }
  lastFrame = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$("play-btn").addEventListener("click", () => play(!playing));

// Theater mode: the board fills the browser window (an in-page overlay, not the Fullscreen API).
let theater = false;
function setTheater(on: boolean): void {
  theater = on;
  document.body.classList.toggle("theater", on);
  const btn = $("theater-btn");
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "✕" : "⛶";
  btn.title = on ? "Exit (Esc)" : "Fill the window with the battle (F)";
}
$("theater-btn").addEventListener("click", () => setTheater(!theater));
$("back-btn").addEventListener("click", () => (play(false), seek(t - 1)));
$("fwd-btn").addEventListener("click", () => (play(false), seek(t + 1)));
$<HTMLInputElement>("scrubber").addEventListener("input", (e) => seek(Number((e.target as HTMLInputElement).value)));
document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".cm-editor") || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
  if (e.key === " ") {
    e.preventDefault();
    play(!playing);
  } else if (e.key === "f" || e.key === "F") {
    setTheater(!theater);
  } else if (e.key === "Escape" && theater) {
    setTheater(false);
  } else if (e.key === "ArrowLeft") {
    play(false);
    seek(t - (e.shiftKey ? 10 : 1));
  } else if (e.key === "ArrowRight") {
    play(false);
    seek(t + (e.shiftKey ? 10 : 1));
  }
});
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=fog]")) {
  r.addEventListener("change", () => {
    opts.fog = Number(r.value) as 0 | 1 | 2;
    render();
  });
}
$<HTMLInputElement>("marks-toggle").addEventListener("change", (e) => {
  opts.marks = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>("attacks-toggle").addEventListener("change", (e) => {
  opts.attacks = (e.target as HTMLInputElement).checked;
  render();
});

// ------------------------------------------------------------------ rendering
function render(): void {
  if (!model) return;
  const state = model.states[t]!;
  const events = model.eventsAt(t);
  board.draw(state, events, opts);
  $<HTMLInputElement>("scrubber").value = String(t);
  $("tick-label").textContent = `${state.tick} / ${CONFIG.match.maxTicks}`;
  for (const c of Object.values(charts)) c.setCurrent(t);
  renderStats(state);
  renderLogs();
  const banner = $("result-banner");
  if (state.result && t === model.lastIndex) {
    const r = state.result;
    const names = model.replay.bots;
    const tally = (r.units ? `units ${r.units[0]} : ${r.units[1]} · ` : "") + `score ${r.scores[0]} : ${r.scores[1]}`;
    banner.textContent =
      r.winner === "draw" ? `Draw · ${tally}` : `${names[r.winner - 1]} (P${r.winner}) wins · ${r.reason.replace("_", " ")} · ${tally}`;
    banner.hidden = false;
  } else banner.hidden = true;
}

function renderStats(s: GameState): void {
  if (!model) return;
  const names = model.replay.bots;
  const sc = model.series.score;
  const count = (p: PlayerId, type: string) => [...s.units, ...s.structures].filter((e) => e.owner === p && e.type === type).length;
  const ups = (p: PlayerId) => s.players[p - 1]!.upgrades.join(", ") || "–";
  const row = (label: string, f: (p: PlayerId) => string | number) => `<tr><td>${label}</td><td>${f(1)}</td><td>${f(2)}</td></tr>`;
  $("stats").innerHTML = `
    <table class="stats-table">
      <thead><tr><th></th>
        <th><span class="dot p1"></span> <span class="name" title="${esc(names[0])}">${esc(names[0])}</span></th>
        <th><span class="dot p2"></span> <span class="name" title="${esc(names[1])}">${esc(names[1])}</span></th></tr></thead>
      <tbody>
        ${row("Score", (p) => sc[p - 1]![t] ?? 0)}
        ${row("Energy", (p) => s.players[p - 1]!.energy)}
        ${row("Crystal", (p) => s.players[p - 1]!.crystal)}
        ${row("Bases", (p) => s.bases.filter((b) => b.owner === p && b.hp > 0).length)}
        ${row("Base HP", (p) => s.bases.reduce((hp, b) => hp + (b.owner === p ? Math.max(0, b.hp) : 0), 0))}
        ${[...UNIT_TYPES, ...STRUCTURE_TYPES].map((t) => row(`${title(t)}s`, (p) => count(p, t))).join("")}
        ${row("Upgrades", ups)}
      </tbody>
    </table>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ------------------------------------------------------------------ logs
type LogEntry = { t: number; player: PlayerId; text: string; err: boolean };
let logIndex: { logs: LogEntry[]; problems: LogEntry[] } = { logs: [], problems: [] };

function describeAction(a: unknown): string {
  try {
    const s = JSON.stringify(a);
    return s && s !== "null" ? ` ${s.length > 90 ? s.slice(0, 90) + "…" : s}` : "";
  } catch {
    return "";
  }
}

function buildLogIndex(): void {
  logIndex = { logs: [], problems: [] };
  if (!model) return;
  for (let i = 1; i <= model.lastIndex; i++) {
    for (const e of model.eventsAt(i) as GameEvent[]) {
      if (e.type === "log") logIndex.logs.push({ t: i - 1, player: e.player, text: e.text, err: false });
      else if (e.type === "invalid_action") logIndex.problems.push({ t: i - 1, player: e.player, text: `${e.reason}${describeAction(e.action)}`, err: true });
      else if (e.type === "bot_error") logIndex.problems.push({ t: i - 1, player: e.player, text: `bot error: ${e.message}`, err: true });
    }
  }
  const badge = $("problem-count");
  badge.textContent = String(logIndex.problems.length);
  badge.classList.toggle("hot", logIndex.problems.length > 0);
}

function renderLogs(): void {
  const tab = logTab;
  const statsTab = tab === "stats";
  $("log-list").hidden = statsTab;
  $("match-stats").hidden = !statsTab;
  document.querySelector<HTMLElement>(".log-filter")!.hidden = statsTab;
  document.querySelector<HTMLElement>(".stats-scope")!.hidden = !statsTab;
  if (tab === "stats") return renderMatchStats();
  const show1 = $<HTMLInputElement>("log-p1").checked;
  const show2 = $<HTMLInputElement>("log-p2").checked;
  const list = logIndex[tab].filter((e) => e.t < t && (e.player === 1 ? show1 : show2)).slice(-300);
  const el = $("log-list");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.innerHTML = list.length
    ? list
        .map((e) => `<div class="log-row${e.err ? " err" : ""}" data-t="${e.t}"><span class="t">${e.t}</span><span class="who p${e.player}">P${e.player}</span><span class="msg">${esc(e.text)}</span></div>`)
        .join("")
    : `<div class="log-empty">${logTab === "logs" ? "No bot logs yet. Return { type: \"log\", text } actions to print here." : "No problems so far."}</div>`;
  if (atBottom || playing) el.scrollTop = el.scrollHeight;
}

$("log-list").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".log-row");
  if (row) {
    play(false);
    seek(Number(row.dataset.t) + 1);
  }
});
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    logTab = tab.dataset.tab as typeof logTab;
    for (const x of document.querySelectorAll(".tab")) x.classList.toggle("active", x === tab);
    renderLogs();
  });
}
for (const id of ["log-p1", "log-p2"]) $(id).addEventListener("change", renderLogs);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="stats-scope"]')) {
  r.addEventListener("change", () => {
    statsScope = r.value as typeof statsScope;
    renderLogs();
  });
}

// ------------------------------------------------------------------ match stats tab
const VICTIMS = [...UNIT_TYPES, ...STRUCTURE_TYPES, "base"] as const;
const KILLERS = [...UNIT_TYPES, ...STRUCTURE_TYPES, "zone", "unknown"] as const;
type Row = [label: string, value: (p: PlayerMatchStats) => number | string];

/** A number cell; zeros are dimmed so the non-zero numbers stand out. */
const num = (n: number) => (n ? String(n) : `<span class="zero">0</span>`);
const plural = (type: string) => `${title(type)}s`;
const tickOf = (n: number | null) => (n === null ? `<span class="zero">–</span>` : `t${n}`);
const get = (c: Partial<Record<string, number>>, k: string) => c[k] ?? 0;

/** A card with a P1 | P2 table. With `skipZero`, rows that are 0 for both players are left out. */
function pairCard(heading: string, rows: Row[], players: readonly PlayerMatchStats[], skipZero = false): string {
  const names = model!.replay.bots;
  const body = rows
    .filter(([, f]) => !skipZero || players.some((p) => f(p) !== 0))
    .map(([label, f]) => `<tr><td>${label}</td>${players.map((p) => { const v = f(p); return `<td>${typeof v === "number" ? num(v) : v}</td>`; }).join("")}</tr>`)
    .join("");
  const head = names.map((n, i) => `<th><span class="dot p${i + 1}"></span> <span class="name" title="${esc(n)}">${esc(n)}</span></th>`).join("");
  return `<section class="ms-card"><h4>${heading}</h4><table class="stats-table"><thead><tr><th></th>${head}</tr></thead>
    <tbody>${body || `<tr><td colspan="3">Nothing yet</td></tr>`}</tbody></table></section>`;
}

/** Victim type × killer type, showing only the rows and columns that have something in them. */
function matrixCard(heading: string, p: PlayerId, m: KillMatrix, empty: string): string {
  const rows = VICTIMS.filter((v) => countTotal(m[v]));
  const cols = KILLERS.filter((k) => rows.some((v) => m[v]?.[k]));
  const head = `<span class="dot p${p}"></span> ${heading} <span class="ms-total">${matrixTotal(m)}</span>`;
  if (!rows.length) return `<section class="ms-card"><h4>${head}</h4><div class="ms-empty">${empty}</div></section>`;
  const colTotal = (k: (typeof KILLERS)[number]) => rows.reduce((n, v) => n + (m[v]?.[k] ?? 0), 0);
  const totalRow = rows.length > 1 ? `<tr class="total"><td>Total</td>${cols.map((k) => `<td>${colTotal(k)}</td>`).join("")}<td>${matrixTotal(m)}</td></tr>` : "";
  return `<section class="ms-card"><h4>${head}</h4><table class="stats-table">
    <thead><tr><th title="victim type, by what killed it">Victim · by</th>${cols.map((k) => `<th>${title(k)}</th>`).join("")}<th>All</th></tr></thead>
    <tbody>${rows.map((v) => `<tr><td>${plural(v)}</td>${cols.map((k) => `<td>${num(m[v]?.[k] ?? 0)}</td>`).join("")}<td>${countTotal(m[v])}</td></tr>`).join("")}${totalRow}</tbody>
    </table></section>`;
}

function renderMatchStats(): void {
  const el = $("match-stats");
  if (!model) return void (el.innerHTML = `<div class="log-empty">Run a match or open a replay to see its stats.</div>`);
  const whole = statsScope === "match";
  const st = whole ? model.finalStats : model.statsAt(t);
  const names = model.replay.bots;
  const players = st.players;
  const killSplit = (m: KillMatrix) => {
    const [u, s, b] = [matrixTotal(m, UNIT_TYPES), matrixTotal(m, STRUCTURE_TYPES), matrixTotal(m, ["base"])];
    return `${num(u + s + b)} <span class="ms-split" title="units · structures · bases">${u}·${s}·${b}</span>`;
  };
  const upgrades = (p: PlayerMatchStats) =>
    p.upgrades.length ? p.upgrades.map((u) => `${esc(u.upgrade)} <span class="ms-split">t${u.tick}</span>`).join("<br>") : `<span class="zero">–</span>`;
  const reasons = (p: PlayerMatchStats) => {
    const top = Object.entries(p.invalidReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return top.length ? top.map(([r, n]) => `<div class="ms-reason" title="${esc(r)}">${n}× ${esc(r)}</div>`).join("") : `<span class="zero">–</span>`;
  };
  const dealers = [...UNIT_TYPES, ...STRUCTURE_TYPES];

  const army = pairCard("Army", [
    ["Kills", (p) => killSplit(p.kills)],
    ["Losses", (p) => killSplit(p.losses)],
    ["First kill", (p) => tickOf(p.firstKillTick)],
    ...UNIT_TYPES.map((u): Row => [`${plural(u)} spawned`, (p) => get(p.spawned, u)]),
    ...[...STRUCTURE_TYPES, "base"].map((b): Row => [`${plural(b)} built`, (p) => get(p.built, b)]),
    ["Upgrades", upgrades],
    ["Peak units", (p) => p.peakUnits],
    ["Peak army", (p) => p.peakArmy],
  ], players);
  const damage = pairCard("Damage", [
    ["Dealt", (p) => countTotal(p.damageDealt)],
    ...dealers.map((k): Row => [`<span class="ms-sub">by ${plural(k).toLowerCase()}</span>`, (p) => get(p.damageDealt, k)]),
    [`<span class="ms-sub">to bases</span>`, (p) => get(p.damageDealtTo, "base")],
    ["Taken", (p) => countTotal(p.damageTaken)],
    ...[...dealers, "zone"].map((k): Row => [`<span class="ms-sub">from ${k === "zone" ? "the zone" : plural(k).toLowerCase()}</span>`, (p) => get(p.damageTaken, k)]),
  ], players, true);
  const economy = pairCard("Economy", [
    ["Energy harvested", (p) => p.harvested.energy],
    ["Energy deposited", (p) => p.deposited.energy],
    ["Energy spent", (p) => p.spent.energy],
    ["Crystal harvested", (p) => p.harvested.crystal],
    ["Crystal deposited", (p) => p.deposited.crystal],
    ["Crystal spent", (p) => p.spent.crystal],
  ], players);
  const problems = pairCard("Problems", [
    ["Invalid actions", (p) => p.invalidActions],
    ["Bot errors", (p) => p.botErrors],
    ["Top reasons", reasons],
  ], players);
  const matrices = (["kills", "losses"] as const)
    .flatMap((k) => ([1, 2] as PlayerId[]).map((p) => matrixCard(`${esc(names[p - 1]!)} · ${k}`, p, players[p - 1]![k], k === "kills" ? "No kills yet" : "No losses yet")))
    .join("");

  const range = st.ticks ? `ticks 0–${st.ticks - 1}` : "nothing has happened yet";
  const scroll = el.scrollTop;
  el.innerHTML = `
    <div class="ms-summary">${whole ? "Whole match" : "So far"}: ${range} · first contact ${tickOf(st.firstContactTick)} · first death ${tickOf(st.firstDeathTick)}</div>
    <div class="ms-grid">${army}${matrices}${damage}${economy}${problems}</div>
    <div class="ms-note">A kill goes to the attacker that dealt the victim the most damage on the tick it died (ties: the first attacker).
      Anything the zone hit on the tick it died is a zone kill. Kills show units · structures · bases.</div>`;
  el.scrollTop = scroll;
}

// ------------------------------------------------------------------ hover info
$("board").addEventListener("mousemove", (e) => {
  if (!model) return;
  const s = model.states[t]!;
  const p = board.tileAt(e.clientX, e.clientY, s.map.size);
  const info = $("hover-info");
  if (!p) return void (info.textContent = "");
  const parts = [`(${p.x}, ${p.y})`];
  const at = (o: { x: number; y: number }) => o.x === p.x && o.y === p.y;
  for (const n of s.nodes.filter(at)) parts.push(`${n.type} node #${n.id}: ${n.amount}`);
  for (const b of s.bases.filter((b) => b.hp > 0 && at(b))) parts.push(`P${b.owner} base #${b.id}: ${b.hp} HP`);
  for (const x of s.structures.filter(at)) parts.push(`P${x.owner} ${x.upgraded ? "upgraded " : ""}${x.type} #${x.id}: ${x.hp} HP`);
  for (const u of s.units.filter(at)) {
    const cargo = u.cargo.energy || u.cargo.crystal ? ` cargo ${u.cargo.energy}E ${u.cargo.crystal}C` : "";
    parts.push(`P${u.owner} ${u.upgraded ? "upgraded " : ""}${u.type} #${u.id}: ${u.hp} HP${cargo}`);
  }
  if (s.map.tiles[p.y * s.map.size + p.x] === "#") parts.push("wall");
  info.textContent = parts.join(" · ");
});
$("board").addEventListener("mouseleave", () => ($("hover-info").textContent = ""));

// ------------------------------------------------------------------ README dialog
// README.md ties its numbers to the code with HTML-comment markers (scripts/readme.ts); readers don't need them.
const botApiMarkdown = readmeSource.replace(/<!--\/?(?:v [^>]*|v|table \w+|table)-->/g, "");
const dialog = $<HTMLDialogElement>("readme-dialog");
$("readme-body").innerHTML = marked.parse(botApiMarkdown, { async: false }) as string;
$("readme-btn").addEventListener("click", () => dialog.showModal());
$("close-readme").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
$("copy-readme").addEventListener("click", async () => {
  const btn = $("copy-readme");
  try {
    await navigator.clipboard.writeText(botApiMarkdown);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy markdown"), 1500);
});

// ------------------------------------------------------------------ "How to play" (auto-opens on the first visit)
const HOWTO_KEY = "bot-arena:howto-seen";
const howto = $<HTMLDialogElement>("howto-dialog");
const closeHowto = () => {
  howto.close();
  save(HOWTO_KEY, "1");
};
$("howto-btn").addEventListener("click", () => howto.showModal());
$("close-howto").addEventListener("click", closeHowto);
$("howto-go").addEventListener("click", closeHowto);
howto.addEventListener("close", () => save(HOWTO_KEY, "1"));
howto.addEventListener("click", (e) => {
  if (e.target === howto) closeHowto();
});
$("howto-copy").addEventListener("click", async () => {
  const btn = $("howto-copy");
  try {
    await navigator.clipboard.writeText(botApiMarkdown);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy README"), 1500);
});
// Not over a spectator link to the ladder view.
if (!load(HOWTO_KEY) && location.hash !== "#ladder") howto.showModal();

// ------------------------------------------------------------------ layout
// Draggable divider between the board (left) and the editor (right). The split is a fraction of the
// row given to the left pane; CSS turns it into fr tracks with per-side minimum widths. Changing it
// resizes the board canvas, which the ResizeObserver below picks up (once per frame) to re-render.
const SPLIT_KEY = "bot-arena:split";
const SPLIT_DEFAULT = 0.5;
const SPLIT_MIN_L = 520; // px (board + 220px stats column), keep in sync with --split-min-l in style.css
const SPLIT_MIN_R = 320; // px, keep in sync with --split-min-r
const splitEl = document.querySelector<HTMLElement>(".split")!;
const splitter = $("splitter");
let split = (() => {
  const v = Number(load(SPLIT_KEY));
  return Number.isFinite(v) && v > 0 && v < 1 ? v : SPLIT_DEFAULT;
})();

/** Allowed range of the split fraction for the current row width. */
function splitBounds(): [number, number] {
  const w = splitEl.clientWidth - splitter.offsetWidth;
  if (w <= SPLIT_MIN_L + SPLIT_MIN_R) return [0.45, 0.55];
  return [SPLIT_MIN_L / w, 1 - SPLIT_MIN_R / w];
}
function setSplitVars(f: number): void {
  splitEl.style.setProperty("--split-l", `${f}fr`);
  splitEl.style.setProperty("--split-r", `${1 - f}fr`);
}
/** Mirror the effective (clamped) split into the ARIA attributes. */
function splitAria(): void {
  const [lo, hi] = splitBounds();
  const pct = Math.round(Math.min(hi, Math.max(lo, split)) * 100);
  splitter.setAttribute("aria-valuenow", String(pct));
  splitter.setAttribute("aria-valuemin", String(Math.round(lo * 100)));
  splitter.setAttribute("aria-valuemax", String(Math.round(hi * 100)));
  splitter.setAttribute("aria-valuetext", `Map ${pct}%, code ${100 - pct}%`);
}
function applySplit(f: number, persist = false): void {
  const [lo, hi] = splitBounds();
  split = Math.min(hi, Math.max(lo, f));
  setSplitVars(split);
  splitAria();
  if (persist) save(SPLIT_KEY, String(split));
}
// Stacked (narrow) layout hides the divider: offsetWidth is 0 there, so it can't be dragged or focused.
const splitActive = () => splitter.offsetWidth > 0;
setSplitVars(split); // the CSS minimums clamp it if the window is narrower than when it was saved
if (splitActive()) splitAria();

let drag: { id: number; left: number; width: number; raf: number; x: number } | null = null;
splitter.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !splitActive()) return;
  e.preventDefault();
  const r = splitEl.getBoundingClientRect(); // read once; pointermoves only write
  drag = { id: e.pointerId, left: r.left, width: r.width - splitter.offsetWidth, raf: 0, x: e.clientX };
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  document.body.classList.add("split-dragging");
});
splitter.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX;
  // Coalesce to one style write per frame; the ResizeObserver then redraws the board in the same frame.
  if (!drag.raf)
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      applySplit((drag.x - drag.left - splitter.offsetWidth / 2) / drag.width);
    });
});
function endDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  cancelAnimationFrame(drag.raf);
  applySplit((drag.x - drag.left - splitter.offsetWidth / 2) / drag.width, true);
  drag = null;
  if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
  splitter.classList.remove("dragging");
  document.body.classList.remove("split-dragging");
}
splitter.addEventListener("pointerup", endDrag);
splitter.addEventListener("pointercancel", endDrag);
splitter.addEventListener("lostpointercapture", endDrag);
splitter.addEventListener("dblclick", () => applySplit(SPLIT_DEFAULT, true));
splitter.addEventListener("keydown", (e) => {
  if (!splitActive()) return;
  const step = e.shiftKey ? 0.1 : 0.02;
  const [lo, hi] = splitBounds();
  const cur = Math.min(hi, Math.max(lo, split)); // step from what's on screen, not a saved out-of-range value
  let next: number | null = null;
  if (e.key === "ArrowLeft") next = cur - step;
  else if (e.key === "ArrowRight") next = cur + step;
  else if (e.key === "Home") next = lo;
  else if (e.key === "End") next = hi;
  else if (e.key === "Enter") next = SPLIT_DEFAULT;
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation(); // the document-level arrow keys step the replay; don't do both
  applySplit(next, true);
});
// The saved split survives window resizes (CSS clamps it); just keep the ARIA values honest.
window.addEventListener("resize", () => {
  if (splitActive()) splitAria();
});

const ro = new ResizeObserver(() => {
  board.resize();
  for (const c of Object.values(charts)) c.draw();
  render();
});
ro.observe($("board"));
for (const el of document.querySelectorAll<HTMLElement>(".chart")) ro.observe(el);

// ------------------------------------------------------------------ ranked ladder (only when served by `arena server`)
const ladderReady = initLadder({
  botDeleted: () => {
    void loadLadderBots().then(persistSettings);
  },
  getCode: () => code,
  showReplay: (r) => {
    if (!showReplay(r)) return false;
    play(true);
    return true;
  },
  status,
});
void ladderReady.then((ok) => {
  if (!ok) return;
  ladderView = initLadderView({
    playReplay: (r) => {
      if (!showReplay(r, true)) return false;
      play(true);
      return true;
    },
    status,
  });
});

// ------------------------------------------------------------------ startup
(async () => {
  const replayUrl = new URLSearchParams(location.search).get("replay");
  if (replayUrl) {
    try {
      const res = await fetch(replayUrl);
      await loadReplayText(await res.text(), replayUrl);
      return;
    } catch (e) {
      status(`Could not fetch ${replayUrl}: ${String(e)}`, "err");
    }
  }
  // The ladder view plays ladder games instead of a warm-up match.
  if (location.hash === "#ladder" && (await ladderReady)) return;
  await runOne();
})();
