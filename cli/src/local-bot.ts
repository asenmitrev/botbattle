import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG, type BotController, type BotState, type BotTurn } from "@arena/engine";

type OnTick = (state: BotState, memory: Record<string, unknown>) => unknown;

/**
 * Milestone 1 runner: loads a bot as a plain ES module in-process (NOT sandboxed).
 * Each controller gets its own module instance (query-string cache bust), so a
 * bot playing itself never shares module-level state.
 */
export async function loadLocalBot(file: string, instance: string): Promise<BotController> {
  const abs = path.resolve(file);
  const url = pathToFileURL(abs).href + `?instance=${encodeURIComponent(instance)}`;
  const mod = (await import(url)) as { onTick?: OnTick; default?: { onTick?: OnTick } };
  const onTick = mod.onTick ?? mod.default?.onTick;
  if (typeof onTick !== "function") throw new Error(`${file} does not export onTick(state, memory)`);
  let memory: Record<string, unknown> = {};
  return {
    name: path.basename(file).replace(/\.[cm]?js$/, ""),
    turn(view: BotState): BotTurn {
      const working = JSON.parse(JSON.stringify(memory)) as Record<string, unknown>;
      let actions: unknown;
      try {
        actions = onTick(view, working);
      } catch (e) {
        return { actions: [], error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(working) ?? "{}";
      } catch (e) {
        return { actions, error: `memory not serializable: ${String(e)}` };
      }
      if (serialized.length > CONFIG.bot.memoryLimitBytes) {
        // Actions still count; memory changes from this tick are discarded.
        return { actions: [], error: `memory exceeds ${CONFIG.bot.memoryLimitBytes} bytes (${serialized.length})` };
      }
      memory = JSON.parse(serialized);
      return { actions };
    },
  };
}
