import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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

test("Settings switches both interface variants without a top badge", () => {
  const source = readFileSync(
    new URL("../src/ui/interface-controls.js", import.meta.url),
    "utf8",
  )
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/export /g, "");
  for (const current of ["classic", "next"]) {
    const switches = [];
    const elements = new Map(
      ["classic", "next", "current"].map((name) => [
        `#interface-${name}`,
        {
          attributes: {},
          setAttribute(key, value) {
            this.attributes[key] = value;
          },
        },
      ]),
    );
    const bind = vm.runInNewContext(`${source}; bindInterfaceControls`, {
      $: (selector) => elements.get(selector) ?? null,
      getInterfaceVariant: () => current,
      INTERFACE_NAMES: { classic: "Классика", next: "Новая" },
      switchInterface: (variant) => switches.push(variant),
    });
    bind();
    for (const variant of ["classic", "next"]) {
      const button = elements.get(`#interface-${variant}`);
      assert.equal(
        button.attributes["aria-pressed"],
        String(variant === current),
      );
      button.onclick();
    }
    assert.deepEqual(switches, ["classic", "next"]);
    assert.match(
      elements.get("#interface-current").textContent,
      /сборка для сравнения/u,
    );
  }
});
