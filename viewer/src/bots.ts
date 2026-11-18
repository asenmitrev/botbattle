import idle from "../../bots/idle.js?bot";
import greedy from "../../bots/greedy.js?bot";
import rusher from "../../bots/rusher.js?bot";
import balanced from "../../bots/balanced.js?bot";
import starter from "../../bots/starter.js?bot";
import aggressor from "../../bots/aggressor.js?bot";
import tumor from "../../bots/tumor.js?bot";
import starterRaw from "../../bots/starter.js?raw";

/** Sample bots, each bundled into a single module so the browser sandbox runs them like pasted code. */
export const SAMPLE_BOTS: Record<string, string> = { greedy, rusher, balanced, aggressor, tumor, starter, idle };

/** The editor's initial content (the README example). */
export const STARTER_SOURCE = starterRaw;
