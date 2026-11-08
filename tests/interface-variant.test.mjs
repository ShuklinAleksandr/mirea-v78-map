import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveInterfaceVariant,
  getInterfaceStorage,
  interfaceUrl,
} from "../src/ui/variant.js";

test("Classic is the unchanged default; explicit valid links override saved choice", () => {
  assert.equal(resolveInterfaceVariant(), "classic");
  assert.equal(resolveInterfaceVariant("?interface=next", "classic"), "next");
  assert.equal(
    resolveInterfaceVariant("?interface=classic", "next"),
    "classic",
  );
  assert.equal(
    resolveInterfaceVariant("?interface=unexpected", "next"),
    "next",
  );
  assert.equal(
    resolveInterfaceVariant("?interface=__proto__", "unexpected"),
    "classic",
  );
});

test("interface changes retain the same route and unrelated URL parameters", () => {
  const href = "https://example.org/map/?sample=1#campus=v-78&from=a&to=b";
  const next = new URL(interfaceUrl("next", href));
  assert.equal(next.pathname, "/map/");
  assert.equal(next.searchParams.get("sample"), "1");
  assert.equal(next.searchParams.get("interface"), "next");
  assert.equal(next.hash, "#campus=v-78&from=a&to=b");
  assert.equal(interfaceUrl("invalid", href), null);
});

test("Next settings and saved view cannot overwrite or erase Classic records", () => {
  const entries = new Map([["atlas:settings", "classic-original"]]);
  const store = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
  const classic = getInterfaceStorage(store, "classic");
  const next = getInterfaceStorage(store, "next");
  assert.equal(classic.getItem("atlas:settings"), "classic-original");
  assert.equal(next.getItem("atlas:settings"), null);
  next.setItem("atlas:settings", "new-value");
  next.removeItem("atlas:settings");
  assert.equal(classic.getItem("atlas:settings"), "classic-original");
  next.setItem("mirea:last-native-view:v1", "#room=b");
  assert.equal(classic.getItem("mirea:last-native-view:v1"), null);
  assert.equal(getInterfaceStorage(null), null);
});
