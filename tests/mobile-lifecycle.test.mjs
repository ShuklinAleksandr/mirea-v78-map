import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The production shell runs here with native APIs and DOM as boundaries.
// Real keyboard/safe-area rendering still requires a device or emulator.
function shell({
  platform = "android",
  hash = "",
  launch,
  saved,
  storageFails = false,
} = {}) {
  const callbacks = new Map(),
    store = new Map(),
    targets = new Map(),
    bars = [];
  const window = new EventTarget();
  const location = {
    hash,
    reloads: 0,
    reload() {
      this.reloads++;
    },
  };
  const document = {
    documentElement: { dataset: {} },
    activeElement: null,
    querySelector: (selector) => targets.get(selector) ?? null,
  };
  let minimized = 0,
    mutations;
  if (saved) store.set("mirea:last-native-view:v1", saved);
  const sandbox = {
    Capacitor: {
      getPlatform: () => platform,
      isNativePlatform: () => platform !== "web",
    },
    App: {
      getLaunchUrl: async () => launch && { url: launch },
      addListener: async (name, fn) => callbacks.set(name, fn),
      minimizeApp: async () => minimized++,
    },
    SystemBars: {
      setStyle: async ({ style }) => bars.push(style),
    },
    SystemBarsStyle: { Light: "light", Dark: "dark" },
    localStorage: {
      getItem(key) {
        if (storageFails) throw new Error("Storage unavailable");
        return store.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageFails) throw new Error("Storage unavailable");
        store.set(key, value);
      },
    },
    history: {
      replaceState(_state, _title, value) {
        location.hash = value;
      },
    },
    MutationObserver: class {
      constructor(fn) {
        mutations = fn;
      }
      observe() {}
    },
    URL,
    URLSearchParams,
    Event,
    CustomEvent,
    window,
    document,
    location,
  };
  const source = readFileSync(
    new URL("../src/mobile.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;\n/gm, "")
    .replace(/export /g, "");
  const api = vm.runInNewContext(`${source}\n;({initMobileShell})`, sandbox);
  return {
    ...api,
    callbacks,
    store,
    targets,
    window,
    document,
    location,
    bars,
    mutations: () => mutations(),
    minimized: () => minimized,
  };
}

test("native launch link wins over saved view; unsafe subsequent links cannot reload the app", async () => {
  const h = shell({
    saved: "#campus=old",
    launch: "mireamap://map#campus=v-78&from=first&to=last",
  });
  await h.initMobileShell();
  assert.equal(h.location.hash, "#campus=v-78&from=first&to=last");
  const open = h.callbacks.get("appUrlOpen");
  open({ url: "https://foreign.test/#campus=bad" });
  assert.equal(h.location.reloads, 0);
  open({ url: "mireamap://map#campus=v-78&from=first&to=last" });
  assert.equal(h.location.reloads, 0);
  open({ url: "mireamap://map#campus=s-20&server=https://foreign.test" });
  assert.equal(h.location.hash, "#campus=s-20");
  assert.equal(h.location.reloads, 1);
});

test("background saves navigation and foreground resumes map rendering and system theme", async () => {
  const h = shell({ platform: "ios", saved: "#campus=v-78&room=Б-209" });
  await h.initMobileShell();
  assert.equal(
    new URLSearchParams(h.location.hash.slice(1)).get("room"),
    "Б-209",
  );
  const activity = [];
  let resizes = 0;
  h.window.addEventListener("atlas:app-state", (event) =>
    activity.push(event.detail.isActive),
  );
  h.window.addEventListener("resize", () => resizes++);
  h.location.hash = "#campus=v-86&room=other";
  h.callbacks.get("appStateChange")({ isActive: false });
  assert.equal(h.store.get("mirea:last-native-view:v1"), h.location.hash);
  assert.equal(h.document.documentElement.dataset.appActive, "false");
  h.callbacks.get("appStateChange")({ isActive: true });
  assert.deepEqual(activity, [false, true]);
  assert.equal(resizes, 1);
  h.document.documentElement.dataset.theme = "dark";
  h.mutations();
  assert.deepEqual(h.bars, ["light", "dark"]);
});

test("Android Back dismisses dialog, input and UI panel before minimizing", async () => {
  const h = shell();
  await h.initMobileShell();
  const back = h.callbacks.get("backButton");
  let closed = 0,
    blurred = 0;
  h.targets.set("dialog[open]", { close: () => closed++ });
  await back();
  assert.equal(closed, 1);
  assert.equal(h.minimized(), 0);
  h.targets.delete("dialog[open]");
  h.document.activeElement = { matches: () => true, blur: () => blurred++ };
  await back();
  assert.equal(blurred, 1);
  assert.equal(h.minimized(), 0);
  h.document.activeElement = null;
  const cancel = (event) => event.preventDefault();
  h.window.addEventListener("atlas:back", cancel);
  await back();
  assert.equal(h.minimized(), 0);
  h.window.removeEventListener("atlas:back", cancel);
  await back();
  assert.equal(h.minimized(), 1);
});

test("web startup avoids native APIs and unavailable storage cannot disable native lifecycle", async () => {
  const web = shell({ platform: "web" });
  await web.initMobileShell();
  assert.equal(web.document.documentElement.dataset.platform, "web");
  assert.equal(web.callbacks.size, 0);
  const native = shell({ storageFails: true });
  await native.initMobileShell();
  native.callbacks.get("appStateChange")({ isActive: false });
  await native.callbacks.get("backButton")();
  assert.equal(native.minimized(), 1);
});
