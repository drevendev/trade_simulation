/**
 * Verify the *published* GitHub Pages assets against the checked-out deployment
 * revision. This is deliberately separate from the offline M5 preview tests:
 * a green local build cannot establish that the public site is fresh.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const M5_PAGES_BASE = "https://drevendev.github.io/trade_simulation/";
export const M5_PAGES_ASSETS = ["m5.html", "m5-preview.json", "m5-arrival.json"];

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** One attempt, no retry and no fallback. Throws on a missing or stale public file. */
export async function verifyM5Pages({
  baseUrl = M5_PAGES_BASE,
  fetchAsset = fetch,
  readExpected = path => readFile(fileURLToPath(new URL("../docs/" + path, import.meta.url))),
} = {}) {
  for (const asset of M5_PAGES_ASSETS) {
    const url = new URL(asset, baseUrl);
    const response = await fetchAsset(url.href, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || response.status !== 200) {
      throw new Error(`${asset}: public HTTP ${response.status}`);
    }
    // A redirect to another host or a fallback page must not masquerade as an
    // actual publication. Browser fetch follows redirects by default.
    if (response.url && response.url !== url.href) {
      throw new Error(`${asset}: unexpected redirect to ${response.url}`);
    }
    const [expected, actual] = await Promise.all([
      readExpected(asset),
      response.arrayBuffer().then(bytes => Buffer.from(bytes)),
    ]);
    if (!Buffer.from(expected).equals(actual)) {
      throw new Error(`${asset}: published bytes differ from checkout` +
        ` (expected sha256 ${sha(expected)}, got ${sha(actual)})`);
    }
  }
  return M5_PAGES_ASSETS.length;
}

export async function verifyWithRetries({ attempts = 6, delayMs = 10000, ...options } = {}) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await verifyM5Pages(options); }
    catch (failure) {
      error = failure;
      if (attempt < attempts) {
        console.error(`M5 published check ${attempt}/${attempts}: ${error.message}; retrying`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw error;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verifyWithRetries().then(count => {
    console.log(`Verified ${count} exact public M5 Pages assets against deployed revision.`);
  }).catch(error => {
    console.error(`M5 public deployment unverified: ${error.message}`);
    process.exitCode = 1;
  });
}
