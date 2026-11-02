import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function bridge() {
  const messages = [],
    timers = new Map(),
    listeners = new Map();
  const window = {
    webkit: {
      messageHandlers: { mirea: { postMessage: (m) => messages.push(m) } },
    },
  };
  const navigator = {};
  const history = { replaceState() {}, pushState() {} };
  const context = {
    window,
    navigator,
    history,
    location: { hash: "#campus=v-78" },
    DOMException,
    Error,
    addEventListener: (name, fn) => listeners.set(name, fn),
    setTimeout: (fn) => {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(
    readFileSync(
      new URL("../desktop/mac/native-bridge.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return { ...context, messages, timers, listeners, api: window.mireaDesktop };
}

test("desktop geolocation remains idle until requested and forwards real native observations", () => {
  const h = bridge();
  assert.equal(h.messages.length, 0);
  const seen = [];
  const id = h.navigator.geolocation.watchPosition((value) => seen.push(value));
  assert.equal(h.messages[0].action, "geo-watch");
  const value = {
    coords: { latitude: 55, longitude: 37, accuracy: 18 },
    timestamp: 1000,
  };
  h.window.__mireaDesktopReply(id, value);
  assert.equal(seen[0], value);
  h.navigator.geolocation.clearWatch(id);
  h.window.__mireaDesktopReply(id, { coords: { latitude: 1 } });
  assert.equal(seen.length, 1);
  assert.equal(h.messages.at(-1).action, "geo-clear");
});

test("desktop one-shot timeout cancels the native watch instead of fabricating a fix", () => {
  const h = bridge();
  let observed = false,
    failure;
  h.navigator.geolocation.getCurrentPosition(
    () => (observed = true),
    (value) => (failure = value),
  );
  [...h.timers.values()][0]();
  assert.equal(observed, false);
  assert.equal(failure.code, 3);
  assert.equal(h.messages.at(-1).action, "geo-clear");
});

test("desktop watch reports a missing fix and can recover only from a native observation", () => {
  const h = bridge();
  let observed, failure;
  const id = h.navigator.geolocation.watchPosition(
    (value) => (observed = value),
    (value) => (failure = value),
  );
  [...h.timers.values()][0]();
  assert.equal(failure.code, 3);
  assert.equal(observed, undefined);
  const actual = {
    coords: { latitude: 55, longitude: 37, accuracy: 25 },
    timestamp: 2000,
  };
  h.window.__mireaDesktopReply(id, actual);
  assert.equal(observed, actual);
  h.navigator.geolocation.clearWatch(id);
  assert.equal(h.timers.size, 0);
});

test("desktop export and sharing resolve only matching requests; cancellation rejects", async () => {
  const h = bridge();
  const share = h.api.shareLink("mireamap://map#room=abc");
  const exportFile = h.api.exportGpsJson('{"campusId":"v-78"}');
  h.window.__mireaDesktopReply(h.messages[0].id, {
    value: { method: "share" },
  });
  assert.equal((await share).method, "share");
  h.window.__mireaDesktopReply(h.messages[1].id, {
    error: { name: "AbortError", message: "Отменено" },
  });
  await assert.rejects(exportFile, { name: "AbortError" });
  assert.equal(h.api.platform, "macos");
});

test("desktop view persistence contains the fragment and closing the page stops GPS", () => {
  const h = bridge();
  h.history.replaceState(null, "", "#campus=v-78");
  assert.equal(h.messages[0].action, "remember");
  assert.equal(h.messages[0].hash, "#campus=v-78");
  h.navigator.geolocation.watchPosition(() => {});
  h.listeners.get("pagehide")();
  assert.equal(h.messages.at(-1).action, "geo-clear");
});
