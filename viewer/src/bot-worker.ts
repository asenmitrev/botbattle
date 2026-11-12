/// <reference lib="webworker" />
// Browser sandbox for LOCAL testing. Runs one bot in a dedicated module worker.
// Official matches use isolated-vm (sandbox/); this mirrors its protocol and limits
// as closely as a browser allows (wall-clock timing, no heap cap).
import helpersSource from "../../bots/lib/helpers.js?raw";
import * as helpers from "../../bots/lib/helpers.js";
import { makeTickFunction, seededRandom } from "@arena/engine";

type InMsg = { type: "init"; source: string; seed: number } | { type: "tick"; id: number; state: string; memory: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = scope.postMessage.bind(scope);
const parse = JSON.parse;
const stringify = JSON.stringify;
const now = performance.now.bind(performance);
const createURL = URL.createObjectURL.bind(URL);
let tick: ((s: string, m: string) => [string, string]) | null = null;

/** Hide capabilities a bot must not use. Shadowing on the global object hides prototype members. */
function lockDown(): void {
  const names = [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "queueMicrotask", "requestAnimationFrame", "indexedDB", "caches",
    "BroadcastChannel", "Worker", "SharedWorker", "WebAssembly", "Atomics", "SharedArrayBuffer",
    "postMessage", "close", "navigator", "location", "crypto", "FileReader", "Request", "Response",
  ];
  for (const n of names) {
    try {
      Object.defineProperty(scope, n, { value: undefined, configurable: false, writable: false });
    } catch {
      /* best effort */
    }
  }
}

function errText(e: unknown): string {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 500);
    return typeof e === "string" ? e.slice(0, 500) : `thrown ${typeof e}`;
  } catch {
    return "unprintable error";
  }
}

async function init(source: string, seed: number): Promise<void> {
  const helpersUrl = createURL(new Blob([helpersSource], { type: "text/javascript" }));
  const rewritten = source.replace(/(\bfrom\s*|\bimport\s*)(["'])arena\2/g, `$1"${helpersUrl}"`);
  const badImport = /\bimport\s*(?:[\w*{}\s,]+from\s*)?["'](?!blob:)([^"']+)["']/.exec(rewritten);
  if (badImport) throw new Error(`import "${badImport[1]}" is not allowed (only "arena")`);
  const botUrl = createURL(new Blob([rewritten], { type: "text/javascript" }));
  Math.random = seededRandom(seed);
  (scope as unknown as { Arena: unknown }).Arena = Object.freeze({ ...helpers });
  lockDown();
  const mod = await import(/* @vite-ignore */ botUrl);
  const fn = typeof mod.onTick === "function" ? mod.onTick : mod.default?.onTick;
  if (typeof fn !== "function") throw new TypeError("bot must export a function onTick(state, memory)");
  tick = makeTickFunction(fn, parse, stringify);
}

scope.addEventListener("message", async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    try {
      await init(msg.source, msg.seed);
      post({ type: "ready" });
    } catch (e) {
      post({ type: "initError", message: errText(e) });
    }
  } else if (msg.type === "tick") {
    if (!tick) return post({ type: "error", id: msg.id, message: "bot not initialized", ms: 0 });
    const t0 = now();
    try {
      const out = tick(msg.state, msg.memory);
      post({ type: "result", id: msg.id, out, ms: now() - t0 });
    } catch (e) {
      post({ type: "error", id: msg.id, message: errText(e), ms: now() - t0 });
    }
  }
});
post({ type: "booted" });
