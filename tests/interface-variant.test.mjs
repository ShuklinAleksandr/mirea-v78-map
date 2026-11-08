import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  resolveInterfaceVariant,
  getInterfaceVariant,
  isNextInterface,
  variantStorageKey,
  migrateInterfaceStorage,
  getInterfaceStorage,
  interfaceUrl,
  switchInterface,
} from "../src/ui/variant.js";
import { bindInterfaceControls } from "../src/ui/interface-controls.js";

function storage(initial = []) {
  const entries = new Map(initial);
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}
const nextKey = variantStorageKey;
const marker = "atlas:single-interface-storage:v1";

test("new installs, saved Classic choices and both historical links open the same interface", () => {
  for (const query of [
    "",
    "?interface=classic",
    "?interface=next",
    "?interface=__proto__",
  ]) {
    for (const saved of [null, "classic", "next", "unexpected"]) {
      assert.equal(resolveInterfaceVariant(query, saved), "next");
    }
  }
  assert.equal(getInterfaceVariant(), "next");
  assert.equal(isNextInterface(), true);
  assert.equal(
    variantStorageKey("atlas:settings", "classic"),
    nextKey("atlas:settings"),
  );
});

test("legacy URL helpers retain route, subpath and unrelated parameters without navigating", () => {
  const href =
    "https://example.org/map/?sample=1&interface=classic#campus=v-78&from=a&to=b";
  for (const name of ["classic", "next"]) {
    const url = new URL(interfaceUrl(name, href));
    assert.equal(url.pathname, "/map/");
    assert.equal(url.searchParams.get("sample"), "1");
    assert.equal(url.searchParams.has("interface"), false);
    assert.equal(url.hash, "#campus=v-78&from=a&to=b");
    // Node has no location/document: a hidden reload or DOM dependency fails.
    assert.equal(switchInterface(name), false);
  }
  assert.equal(interfaceUrl("invalid", href), null);
  assert.doesNotThrow(bindInterfaceControls);
});

test("Classic-only users retain preferences, saved locations and native view before first reads", () => {
  const legacy = [
    ["atlas:settings", '{"quality":"high","theme":"dark"}'],
    ["atlas:quality-default-version", "1"],
    ["atlas:favorites", '["a","b"]'],
    ["atlas:recent", '["b","c"]'],
    ["mirea:last-native-view:v1", "#campus=v-78&room=b"],
    ["mirea:gps-calibration-survey:v1", '{"records":[{"id":"old"}]}'],
  ];
  const db = storage(legacy);
  assert.equal(migrateInterfaceStorage(db), true);
  for (const [key, value] of legacy) {
    assert.equal(db.getItem(nextKey(key)), value);
    assert.equal(db.getItem(key), value);
  }
  assert.equal(db.getItem(marker), "1");
});

test("existing Next preferences and GPS data win while saved lists merge without truncation", () => {
  const oldFavorites = Array.from({ length: 20 }, (_, i) => `old-${i}`);
  const nextFavorites = ["next", "old-3"];
  const db = storage([
    ["atlas:settings", '{"quality":"low"}'],
    [nextKey("atlas:settings"), '{"quality":"high"}'],
    ["mirea:gps-calibration-survey:v1", "classic-gps"],
    [nextKey("mirea:gps-calibration-survey:v1"), "next-gps"],
    ["atlas:favorites", JSON.stringify(oldFavorites)],
    [nextKey("atlas:favorites"), JSON.stringify(nextFavorites)],
    ["atlas:recent", '["old-visit","both"]'],
    [nextKey("atlas:recent"), '["new-visit","both"]'],
  ]);
  const original = new Map(db.entries);
  assert.equal(migrateInterfaceStorage(db), true);
  assert.equal(db.getItem(nextKey("atlas:settings")), '{"quality":"high"}');
  assert.equal(
    db.getItem(nextKey("mirea:gps-calibration-survey:v1")),
    "next-gps",
  );
  assert.deepEqual(JSON.parse(db.getItem(nextKey("atlas:favorites"))), [
    ...new Set([...nextFavorites, ...oldFavorites]),
  ]);
  assert.deepEqual(JSON.parse(db.getItem(nextKey("atlas:recent"))), [
    "new-visit",
    "both",
    "old-visit",
  ]);
  for (const [key, value] of original) {
    if (!key.startsWith("atlas:next:")) assert.equal(db.getItem(key), value);
  }
});

test("completed migration never resurrects intentionally removed favorites or GPS data", () => {
  const db = storage([
    ["atlas:favorites", '["a"]'],
    ["mirea:gps-calibration-survey:v1", "old-gps"],
  ]);
  const active = getInterfaceStorage(db);
  active.setItem("atlas:favorites", "[]");
  active.removeItem("mirea:gps-calibration-survey:v1");
  assert.equal(migrateInterfaceStorage(db), true);
  assert.equal(active.getItem("atlas:favorites"), "[]");
  assert.equal(active.getItem("mirea:gps-calibration-survey:v1"), null);
  assert.equal(db.getItem("atlas:favorites"), '["a"]');
  assert.equal(db.getItem("mirea:gps-calibration-survey:v1"), "old-gps");
});

test("malformed saved lists remain untouched rather than being silently replaced", () => {
  const db = storage([
    ["atlas:favorites", '["legacy"]'],
    [nextKey("atlas:favorites"), "broken-json"],
    ["atlas:recent", '["legacy",42]'],
    [nextKey("atlas:recent"), '["current"]'],
  ]);
  migrateInterfaceStorage(db);
  assert.equal(db.getItem(nextKey("atlas:favorites")), "broken-json");
  assert.equal(db.getItem(nextKey("atlas:recent")), '["current"]');
  assert.equal(db.getItem("atlas:recent"), '["legacy",42]');
});

test("unavailable/full storage cannot block startup; interrupted migration retries safely", () => {
  assert.equal(migrateInterfaceStorage(null), false);
  assert.equal(getInterfaceStorage(null), null);
  assert.equal(
    migrateInterfaceStorage({
      getItem() {
        throw Error("blocked");
      },
    }),
    false,
  );
  const db = storage([
    ["atlas:settings", "settings"],
    ["atlas:favorites", '["a"]'],
  ]);
  const set = db.setItem;
  db.setItem = (key, value) => {
    if (key === nextKey("atlas:favorites")) throw Error("quota");
    set(key, value);
  };
  assert.equal(migrateInterfaceStorage(db), false);
  assert.equal(db.getItem(marker), null);
  assert.equal(db.getItem("atlas:favorites"), '["a"]');
  db.setItem = set;
  assert.equal(migrateInterfaceStorage(db), true);
  assert.equal(db.getItem(nextKey("atlas:favorites")), '["a"]');
});

test("module initialization migrates before direct readers and sets the product title", () => {
  const source = readFileSync(
    new URL("../src/ui/variant.js", import.meta.url),
    "utf8",
  ).replace(/export /g, "");
  const db = storage([["mirea:last-native-view:v1", "#room=a"]]);
  const document = { documentElement: { dataset: {} }, title: "Old" };
  vm.runInNewContext(`${source}; initializeInterface();`, {
    localStorage: db,
    document,
    URL,
    location: {
      search: "?interface=classic",
      replace() {
        throw Error("Unexpected navigation");
      },
    },
  });
  assert.equal(db.getItem(nextKey("mirea:last-native-view:v1")), "#room=a");
  assert.equal(document.documentElement.dataset.interface, "next");
  assert.equal(document.title, "МИРЭА · Вернадского, 78");
});

test("quality migration markers follow their own settings rather than crossing profiles", () => {
  const existingNext = storage([
    ["atlas:settings", '{"quality":"auto"}'],
    ["atlas:quality-default-version", "1"],
    [nextKey("atlas:settings"), '{"quality":"auto"}'],
  ]);
  migrateInterfaceStorage(existingNext);
  assert.equal(
    existingNext.getItem(nextKey("atlas:quality-default-version")),
    null,
  );
  const classicOnly = storage([
    ["atlas:settings", '{"quality":"auto"}'],
    ["atlas:quality-default-version", "1"],
  ]);
  migrateInterfaceStorage(classicOnly);
  assert.equal(
    classicOnly.getItem(nextKey("atlas:quality-default-version")),
    "1",
  );
});
