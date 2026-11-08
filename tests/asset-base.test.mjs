import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBuildBase } from "../vite.config.js";
import { getJSON, resolveAssetUrl } from "../src/data/client.js";

test("map and native-package URLs use the configured Pages base without changing archived references", () => {
  const paths = [
    "/data/manifest.json",
    "/data/routing/v-78.json",
    "/data/campuses/v-78/v-78-floor1.json",
    "/mobile-package.json",
  ];
  for (const path of paths) {
    assert.equal(resolveAssetUrl(path), path);
    assert.equal(
      resolveAssetUrl(path, "/mirea-v78-map/"),
      `/mirea-v78-map${path}`,
    );
    assert.equal(
      resolveAssetUrl(path, "/mirea-v78-map"),
      `/mirea-v78-map${path}`,
    );
  }
  for (const path of [
    "https://example.org/data/example.json",
    "//example.org/data/example.json",
    "data/example.json",
    "/mirea-v78-map/data/manifest.json",
    "#campus=v-78",
  ])
    assert.equal(resolveAssetUrl(path, "/mirea-v78-map/"), path);
});

test("BUILD_BASE accepts same-site directories and rejects network URLs, query strings and traversal", () => {
  assert.equal(normalizeBuildBase(), "/");
  assert.equal(normalizeBuildBase("/mirea-v78-map"), "/mirea-v78-map/");
  assert.equal(
    normalizeBuildBase(" /previews/map-next/ "),
    "/previews/map-next/",
  );
  for (const invalid of [
    "",
    ".",
    "./",
    "https://example.org/",
    "javascript:alert(1)",
    "//",
    "//example.org/",
    "/map//",
    "/map?next",
    "/map#view",
    "/../",
    "/map/./",
    "/map/%2e%2e/",
    "/map\\else/",
  ])
    assert.throws(() => normalizeBuildBase(invalid), /BUILD_BASE/, invalid);
});

test("JSON requests still coalesce and a failed request can be retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(url, "/data/test-base-cache.json");
    return calls === 1
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ loaded: true }) };
  };
  try {
    await assert.rejects(getJSON("/data/test-base-cache.json"), /503/);
    const [a, b] = await Promise.all([
      getJSON("/data/test-base-cache.json"),
      getJSON("/data/test-base-cache.json"),
    ]);
    assert.deepEqual(a, { loaded: true });
    assert.equal(a, b);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
