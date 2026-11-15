import test from "node:test";
import assert from "node:assert/strict";
import { verifyM5Pages, M5_PAGES_ASSETS } from "../verify_m5_pages_live.mjs";

const contents = new Map(M5_PAGES_ASSETS.map(name => [name, Buffer.from(`fixture:${name}`)]));
const fakeFetch = overrides => async url => {
  const asset = new URL(url).pathname.split("/").pop();
  const item = overrides?.[asset];
  const status = item?.status ?? 200;
  return {
    ok: status === 200, status,
    url: item?.url ?? url,
    arrayBuffer: async () => item?.bytes ?? contents.get(asset),
  };
};
const settings = fetchAsset => ({
  fetchAsset,
  readExpected: name => contents.get(name),
});

test("accepts three exact deployed assets", async () => {
  assert.equal(await verifyM5Pages(settings(fakeFetch())), 3);
});

test("rejects Pages' 404 fallback instead of accepting missing arrival JSON", async () => {
  await assert.rejects(() => verifyM5Pages(settings(fakeFetch({
    "m5-arrival.json": { status: 404 },
  }))), /m5-arrival\.json: public HTTP 404/);
});

test("rejects old but valid-looking receipt even when all routes still parse", async () => {
  await assert.rejects(() => verifyM5Pages(settings(fakeFetch({
    "m5-preview.json": { bytes: Buffer.from('{"milestone":"M5","tick":7}') },
  }))), /m5-preview\.json: published bytes differ/);
});

test("rejects a stale HTML shell, not merely stale JSON", async () => {
  await assert.rejects(() => verifyM5Pages(settings(fakeFetch({
    "m5.html": { bytes: Buffer.from("<html>old</html>") },
  }))), /m5\.html: published bytes differ/);
});

test("refuses redirects to substitute hosts or an unrelated fallback page", async () => {
  await assert.rejects(() => verifyM5Pages(settings(fakeFetch({
    "m5.html": { url: "https://example.invalid/fallback.html" },
  }))), /m5\.html: unexpected redirect/);
});
