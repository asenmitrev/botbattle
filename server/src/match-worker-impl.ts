import { parentPort } from "node:worker_threads";
import { playMatch, type MatchSpec } from "./match-runner.js";

// One match at a time: the pool only posts a new spec after this one replied.
parentPort!.on("message", (spec: MatchSpec) => {
  playMatch(spec).then(
    (run) => parentPort!.postMessage({ ok: true, run }),
    (e: unknown) => parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
});
