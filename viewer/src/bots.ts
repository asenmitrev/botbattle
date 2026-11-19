import idle from "../../bots/idle.js?bot";
import greedy from "../../bots/greedy.js?bot";
import rusher from "../../bots/rusher.js?bot";
import balanced from "../../bots/balanced.js?bot";
import starter from "../../bots/starter.js?bot";
import aggressor from "../../bots/aggressor.js?bot";
import tumor from "../../bots/tumor.js?bot";
import starterRaw from "../../bots/starter.js?raw";
// Denaivam's bots (copies of the files in GameJam/bots/<date>/; copy them again after changing those).
import DenaivamMaikaTi from "../../bots/denaivam/DenaivamMaikaTi.mjs?bot";
import DenaivamApex from "../../bots/denaivam/DenaivamApex.mjs?bot";
import DenaivamBulwark from "../../bots/denaivam/DenaivamBulwark.mjs?bot";
import DenaivamCastle from "../../bots/denaivam/DenaivamCastle.mjs?bot";
import DenaivamFortress from "../../bots/denaivam/DenaivamFortress.mjs?bot";
import DenaivamCitadel from "../../bots/denaivam/DenaivamCitadel.mjs?bot";
import DenaivamDecoy from "../../bots/denaivam/DenaivamDecoy.mjs?bot";
import DenaivamPhalanx from "../../bots/denaivam/DenaivamPhalanx.mjs?bot";

/** Sample bots, each bundled into a single module so the browser sandbox runs them like pasted code. */
export const SAMPLE_BOTS: Record<string, string> = { greedy, rusher, balanced, aggressor, tumor, starter, idle };

/** Denaivam's own bots, offered as opponents in their own group. All play the classic race. */
export const DENAIVAM_BOTS: Record<string, string> = {
  DenaivamMaikaTi,
  DenaivamApex,
  DenaivamBulwark,
  DenaivamCastle,
  DenaivamFortress,
  DenaivamCitadel,
  DenaivamDecoy,
  DenaivamPhalanx,
};

/** Source of a local opponent (sample or Denaivam bot), or undefined. */
export const localBotSource = (name: string): string | undefined =>
  Object.hasOwn(SAMPLE_BOTS, name) ? SAMPLE_BOTS[name] : Object.hasOwn(DENAIVAM_BOTS, name) ? DENAIVAM_BOTS[name] : undefined;

/** The editor's initial content (the README example). */
export const STARTER_SOURCE = starterRaw;
