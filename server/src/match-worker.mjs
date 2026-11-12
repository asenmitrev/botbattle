// Worker-thread entry for MatchPool. Plain JS so it starts in any host (tsx CLI, vitest),
// then loads the TypeScript implementation through tsx.
import { register } from "tsx/esm/api";

register();
await import("./match-worker-impl.ts");
