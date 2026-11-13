/**
 * #677: generate or verify the static M5 Pages receipt from the canonical
 * executed 16-phase tick. No authored economic numbers or simulated fallback.
 *
 * npm run m5:preview         writes docs/m5-preview.json
 * npm run m5:preview:check   fails if the checked-in receipt is stale/missing
 * node scripts/generate-m5-preview.mjs --stdout   streams the exact receipt
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !["--check", "--stdout"].includes(args[0]))) {
  throw new Error("Usage: generate-m5-preview.mjs [--check|--stdout]");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const { createM5PreviewScenario, serializeM5Preview } =
    await server.ssrLoadModule("/src/diagnostics/m5PreviewScenario.ts");
  const json = serializeM5Preview(createM5PreviewScenario());
  const preview = JSON.parse(json);

  // The canonical generator itself enforces paid FX cargo, rate movement,
  // issuer identity and no fake data. Verify the Pages envelope as well.
  if (preview.milestone !== "M5" ||
      !Number.isSafeInteger(preview.tick) ||
      !Array.isArray(preview.routes) || !Array.isArray(preview.fxPools) ||
      !json.endsWith("\n")) {
    throw new Error("Refusing to publish an invalid M5 preview envelope");
  }

  if (args[0] === "--stdout") {
    process.stdout.write(json);
  } else if (args[0] === "--check") {
    let published;
    try {
      published = await readFile(artifact, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error("docs/m5-preview.json is missing; generate and commit the receipt");
    }
    if (published !== json) {
      throw new Error("docs/m5-preview.json differs from canonical tick output");
    }
  } else {
    await writeFile(artifact, json, "utf8");
    process.stdout.write("Generated docs/m5-preview.json from canonical M5 tick\n");
  }
} finally {
  await server.close();
}
