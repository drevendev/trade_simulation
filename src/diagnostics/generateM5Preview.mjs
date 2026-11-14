/**
 * #677: generate or verify the static M5 Pages receipt from the canonical
 * executed 16-phase tick. No authored economic numbers or simulated fallback.
 *
 * npm run m5:preview         writes docs/m5-preview.json
 * npm run m5:preview:check   fails if the checked-in receipt is stale/missing
 * node src/diagnostics/generateM5Preview.mjs --stdout   streams the exact dispatch receipt
 * node src/diagnostics/generateM5Preview.mjs --arrival-stdout
 *   streams the separately verified real tick-8 delivery receipt
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const args = process.argv.slice(2);
// A candidate file can be checked without editing the checked-in Pages artifact.
if (args.length > 2 ||
    (args[0] && !["--check", "--stdout", "--arrival-stdout"].includes(args[0])) ||
    (args.length === 2 && (args[0] !== "--check" || !args[1] || args[1].startsWith("--")))) {
  throw new Error("Usage: generate-m5-preview.mjs [--check [candidate-path]|--stdout|--arrival-stdout]");
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = fileURLToPath(new URL("../../docs/m5-preview.json", import.meta.url));
const checkedArtifact = args[0] === "--check" && args[1] ? resolve(args[1]) : artifact;
const checkedLabel = args[1] ? "candidate M5 receipt" : "docs/m5-preview.json";
const server = await createServer({
  root,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const { createM5PreviewScenario, serializeM5Preview, serializeM5ArrivalPreview } =
    await server.ssrLoadModule("/src/diagnostics/m5PreviewScenario.ts");
  const json = args[0] === "--arrival-stdout"
    ? serializeM5ArrivalPreview(createM5PreviewScenario())
    : serializeM5Preview(createM5PreviewScenario());
  const preview = JSON.parse(json);

  // The canonical generator itself enforces paid FX cargo, rate movement,
  // issuer identity and no fake data. Verify the Pages envelope as well.
  if (preview.milestone !== "M5" ||
      !Number.isSafeInteger(preview.tick) ||
      !Array.isArray(preview.routes) || !Array.isArray(preview.fxPools) ||
      !json.endsWith("\n")) {
    throw new Error("Refusing to publish an invalid M5 preview envelope");
  }

  if (args[0] === "--stdout" || args[0] === "--arrival-stdout") {
    process.stdout.write(json);
  } else if (args[0] === "--check") {
    let published;
    try {
      published = await readFile(checkedArtifact, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      throw new Error(checkedLabel + " is missing; generate and commit the receipt");
    }
    if (published !== json) {
      throw new Error(checkedLabel + " differs from canonical tick output");
    }
  } else {
    await writeFile(artifact, json, "utf8");
    process.stdout.write("Generated docs/m5-preview.json from canonical M5 tick\n");
  }
} finally {
  await server.close();
}
