import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  migrateInterfaceStorage,
  variantStorageKey,
} from "../src/ui/variant.js";
import { resolveAssetUrl } from "../src/data/client.js";

// The production shell runs here with native APIs and DOM as boundaries.
// Real keyboard/safe-area rendering still requires a device or emulator.
function shell({
  platform = "android",
  hash = "",
  launch,
  saved,
  currentSaved,
  storageFails = false,
  getLaunchUrl,
  registerListener,
} = {}) {
  const callbacks = new Map(),
    store = new Map(),
    targets = new Map(),
    timers = new Map(),
    bars = [];
  let timerId = 0;
  const window = new EventTarget();
  const location = {
    hash,
    search: "?interface=next",
    get href() {
      return `https://localhost/${this.search}${this.hash}`;
    },
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
  if (currentSaved)
    store.set(variantStorageKey("mirea:last-native-view:v1"), currentSaved);
  const sandbox = {
    variantStorageKey,
    resolveAssetUrl,
    Capacitor: {
      getPlatform: () => platform,
      isNativePlatform: () => platform !== "web",
    },
    App: {
      getLaunchUrl: getLaunchUrl ?? (async () => launch && { url: launch }),
      addListener: (name, fn) => {
        callbacks.set(name, fn);
        return registerListener?.(name, fn) ?? Promise.resolve();
      },
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
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const source = readFileSync(
    new URL("../src/mobile.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*;\n/gm, "")
    .replace(/export /g, "");
  // In the real module graph variant.js migrates storage before mobile.js
  // reads VIEW_KEY. Run that same migration against this shell's storage.
  migrateInterfaceStorage(sandbox.localStorage);
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
    timers,
    expireWait() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
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

test("native shell restores migrated legacy views but preserves an existing canonical view", async () => {
  const legacy = "#campus=v-78&floor=v-78-floor1&room=legacy";
  const current = "#campus=v-78&floor=v-78-floor2&room=current";
  for (const currentSaved of [undefined, current]) {
    const h = shell({ saved: legacy, currentSaved });
    await h.initMobileShell();
    assert.equal(h.location.hash, currentSaved ?? legacy);
    assert.equal(h.store.get("mirea:last-native-view:v1"), legacy);
    assert.equal(
      h.store.get(variantStorageKey("mirea:last-native-view:v1")),
      currentSaved ?? legacy,
    );
    h.location.hash = "#campus=v-78&room=new";
    h.window.dispatchEvent(new Event("pagehide"));
    assert.equal(
      h.store.get(variantStorageKey("mirea:last-native-view:v1")),
      h.location.hash,
    );
    assert.equal(h.store.get("mirea:last-native-view:v1"), legacy);
  }
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
  assert.equal(
    h.store.get(variantStorageKey("mirea:last-native-view:v1")),
    h.location.hash,
  );
  assert.equal(
    h.store.get("mirea:last-native-view:v1"),
    "#campus=v-78&room=Б-209",
    "background updates canonical state without modifying the retained legacy record",
  );
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

test("an unresponsive native bridge cannot hold offline map startup past the launch deadline", async () => {
  const h = shell({
    saved: "#campus=v-78&view=floor&floor=v-78-floor2",
    getLaunchUrl: () => new Promise(() => {}),
    registerListener: () => new Promise(() => {}),
  });
  let ready = false;
  const boot = h.initMobileShell().finally(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 1200);
  assert.equal(h.callbacks.size, 3, "lifecycle listeners start independently");
  h.expireWait();
  await boot;
  assert.equal(ready, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.location.hash, "#campus=v-78&view=floor&floor=v-78-floor2");
  assert.equal(h.location.reloads, 0);
});

test("a late safe launch link reloads once only while the original location remains unchanged", async () => {
  for (const change of ["none", "hash", "interface", "unsafe"]) {
    let resolveLaunch;
    const h = shell({
      hash: "#campus=v-78&view=overview",
      getLaunchUrl: () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
    });
    const boot = h.initMobileShell();
    h.expireWait();
    await boot;
    if (change === "hash") h.location.hash = "#campus=v-78&room=Г-209";
    if (change === "interface") h.location.search = "?interface=classic";
    const before = h.location.href;
    resolveLaunch({
      url:
        change === "unsafe"
          ? "https://foreign.test/#campus=bad"
          : "mireamap://map#campus=v-78&room=Г-103-1&server=https://foreign.test",
    });
    await new Promise(setImmediate);
    assert.equal(h.location.reloads, change === "none" ? 1 : 0, change);
    if (change === "none") {
      assert.equal(
        new URLSearchParams(h.location.hash.slice(1)).get("room"),
        "Г-103-1",
      );
      assert.equal(h.location.hash.includes("server="), false);
      h.callbacks.get("appUrlOpen")({
        url: `mireamap://map${h.location.hash}`,
      });
      assert.equal(
        h.location.reloads,
        1,
        "duplicate launch event does not reload again",
      );
    } else assert.equal(h.location.href, before, change);
  }
});

test("rejected and synchronously throwing native calls do not block saved view or lifecycle setup", async () => {
  for (const reject of [false, true]) {
    const failure = () => {
      if (reject) return Promise.reject(new Error("Native bridge unavailable"));
      throw new Error("Native bridge unavailable");
    };
    const h = shell({
      saved: "#campus=v-78&view=floor",
      getLaunchUrl: failure,
      registerListener: failure,
    });
    await h.initMobileShell();
    await new Promise(setImmediate);
    assert.equal(h.location.hash, "#campus=v-78&view=floor");
    assert.equal(h.callbacks.size, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.location.reloads, 0);
  }
});

test("a new deep link received during startup wins over an older launch URL", async () => {
  let resolveLaunch;
  const h = shell({
    getLaunchUrl: () =>
      new Promise((resolve) => {
        resolveLaunch = resolve;
      }),
  });
  const boot = h.initMobileShell();
  h.callbacks.get("appUrlOpen")({ url: "mireamap://map#campus=v-78&room=new" });
  resolveLaunch({ url: "mireamap://map#campus=v-78&room=old" });
  await boot;
  assert.equal(h.location.hash, "#campus=v-78&room=new");
  assert.equal(h.location.reloads, 1);
  assert.equal(h.timers.size, 0);
});
