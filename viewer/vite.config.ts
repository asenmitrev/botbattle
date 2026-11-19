import path from "node:path";
import { build } from "esbuild";
import { defineConfig, type Plugin } from "vite";

/**
 * `import src from "../bots/greedy.js?bot"` → the bot bundled (with its lib imports)
 * into one ES module, as a string. The browser sandbox runs it exactly like pasted code.
 * `import ... from "arena"` stays as is: the sandbox resolves it, as it does for pasted code.
 */
function botBundle(): Plugin {
  return {
    name: "arena-bot-bundle",
    enforce: "pre",
    resolveId(id, importer) {
      if (!id.endsWith("?bot") || !importer) return null;
      return path.resolve(path.dirname(importer), id.slice(0, -4)) + "?bot";
    },
    async load(id) {
      if (!id.endsWith("?bot")) return null;
      const file = id.slice(0, -4);
      const out = await build({ entryPoints: [file], bundle: true, format: "esm", write: false, platform: "neutral", metafile: true, external: ["arena"] });
      for (const input of Object.keys(out.metafile!.inputs)) this.addWatchFile(path.resolve(input));
      return `export default ${JSON.stringify(out.outputFiles[0]!.text)};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [botBundle()],
  // `pnpm playground` talks to a local ladder (`arena server`) if one is running on 8787.
  server: { fs: { allow: [".."] }, proxy: { "/api": "http://127.0.0.1:8787" } },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
