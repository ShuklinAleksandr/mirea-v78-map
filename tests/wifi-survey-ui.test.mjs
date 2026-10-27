import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escape } from "../src/ui/dom.js";
import * as survey from "../src/data/wifi-survey.js";

// DOM, Android plugin and file sharing are boundaries. These tests neither
// scan real radio networks nor demonstrate measured positioning accuracy.
function harness({
  native = true,
  platform = "android",
  pendingScan = false,
  restrictedStorage = false,
  initialPosition = null,
} = {}) {
  const elements = new Map();
  function element() {
    return {
      hidden: false,
      disabled: false,
      checked: false,
      textContent: "",
      innerHTML: "",
      open: false,
      listeners: new Map(),
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        this.listeners.get("close")?.({ target: this });
      },
      addEventListener(type, callback) {
        this.listeners.set(type, callback);
      },
    };
  }
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const document = {
    hidden: false,
    documentElement: { dataset: {} },
    listeners: new Map(),
    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    },
  };
  const window = {
    listeners: new Map(),
    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    },
  };
  const values = new Map();
  const storage = {
    writes: 0,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      this.writes++;
      values.set(key, value);
    },
  };
  const state = {
    userLocation: initialPosition || {
      source: "manual",
      campusId: "v-78",
      floorId: "v-78-floor2",
      building: "А",
      physicalLevel: 2,
      label: "А-214",
      placeId: "room",
      point: [23.1, -1.9],
    },
    floorData: [{ id: "v-78-floor2", buildingLevels: { А: 2 } }],
  };
  const response = () => ({
    capturedAt: Date.now(),
    ageMs: 50,
    fresh: true,
    source: "active-scan",
    device: {
      manufacturer: "Google",
      model: "Pixel 7",
      androidVersion: "16",
      api: 36,
    },
    networks: [
      {
        ssid: survey.WIFI_SURVEY_SSID,
        bssid: "aa:11:22:33:44:55",
        rssi: -55,
        frequency: 2412,
        ageMs: 40,
      },
      {
        ssid: "Other",
        bssid: "aa:11:22:33:44:56",
        rssi: -62,
        frequency: 5180,
        ageMs: 50,
      },
    ],
  });
  let scans = 0,
    statusReads = 0,
    cancellations = 0,
    resolveScan,
    picked,
    pickPurpose;
  const exports = [],
    shares = [],
    notices = [];
  const plugin = {
    async getStatus() {
      statusReads++;
      return {
        supported: true,
        wifiEnabled: true,
        locationEnabled: true,
        preciseLocationGranted: true,
        nextScanInMs: 0,
      };
    },
    scan() {
      scans++;
      return pendingScan
        ? new Promise((resolve) => {
            resolveScan = resolve;
          })
        : Promise.resolve(response());
    },
    async cancel() {
      cancellations++;
    },
    async exportSurvey({ json }) {
      exports.push(json);
      return {
        uri: "file:///cache/MIREA-WiFi.json",
        filename: "MIREA-WiFi.json",
      };
    },
  };
  const sandbox = {
    ...survey,
    $,
    escape,
    icon: () => "",
    Capacitor: { isNativePlatform: () => native, getPlatform: () => platform },
    registerPlugin: () => plugin,
    Share: {
      async share(options) {
        shares.push(options);
      },
    },
    localStorage: storage,
    document,
    window,
    setTimeout,
    clearTimeout,
  };
  if (restrictedStorage)
    Object.defineProperty(sandbox, "localStorage", {
      get() {
        throw new Error("storage blocked by privacy settings");
      },
    });
  const source = readFileSync(
    new URL("../src/ui/wifi-survey.js", import.meta.url),
    "utf8",
  )
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/export /g, "");
  const { bindWifiSurvey } = vm.runInNewContext(
    `${source}\n;({bindWifiSurvey})`,
    sandbox,
  );
  const api = bindWifiSurvey({
    state,
    userPosition: {
      beginPicking({ purpose, onPicked }) {
        picked = onPicked;
        pickPurpose = purpose;
        return true;
      },
      setSurveyLocation(location) {
        state.surveyLocation = { ...location, point: [...location.point] };
      },
    },
    toast: (message) => notices.push(message),
  });
  return {
    $,
    api,
    state,
    storage,
    document,
    window,
    exports,
    shares,
    notices,
    response,
    get scans() {
      return scans;
    },
    get statusReads() {
      return statusReads;
    },
    get cancellations() {
      return cancellations;
    },
    get pickPurpose() {
      return pickPurpose;
    },
    finishScan() {
      resolveScan(response());
    },
    pick() {
      picked();
    },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("Wi-Fi collection controls are hidden on iOS and browser without requesting hardware", () => {
  for (const options of [
    { native: true, platform: "ios" },
    { native: false, platform: "web" },
  ]) {
    const h = harness(options);
    h.api.open();
    assert.equal(h.$("#wifi-survey-open").hidden, true);
    assert.equal(h.scans, 0);
    assert.equal(h.statusReads, 0);
    assert.equal(h.$("#wifi-survey-dialog").innerHTML, "");
  }
});

test("opening the survey closes settings and only reads status; collection starts with an explicit action", async () => {
  const h = harness();
  h.$("#settings-dialog").open = true;
  h.api.open();
  await turn();
  assert.equal(h.$("#settings-dialog").open, false);
  assert.equal(h.$("#wifi-survey-dialog").open, true);
  assert.equal(h.$("#wifi-survey-other").checked, false);
  assert.equal(h.statusReads, 1);
  assert.equal(h.scans, 0);
  assert.equal(h.storage.writes, 0);
  assert.equal(h.$("#wifi-survey-scan").disabled, false);
  assert.equal(h.$("#wifi-survey-export").disabled, true);
  assert.equal(h.$("#wifi-survey-export").hidden, true);
});

test("a blocked localStorage property does not prevent the main interface from binding", async () => {
  const h = harness({ restrictedStorage: true });
  h.api.open();
  await turn();
  assert.equal(h.$("#wifi-survey-dialog").open, true);
  assert.equal(h.$("#wifi-survey-scan").disabled, true);
  assert.equal(h.$("#wifi-survey-export").hidden, true);
  assert.match(
    h.$("#wifi-survey-last").textContent,
    /Хранилище приложения недоступно/u,
  );
  assert.equal(h.scans, 0);
});

test("the survey map picker returns to its own reference without changing the current position", async () => {
  const h = harness();
  h.api.open();
  await turn();
  const currentPosition = h.state.userLocation;
  h.$("#wifi-survey-pick").onclick();
  assert.equal(h.pickPurpose, "survey");
  assert.equal(h.$("#wifi-survey-dialog").open, false);
  h.state.surveyLocation = {
    ...h.state.userLocation,
    label: "Коридор у А-215",
    placeId: null,
    point: [24.2, -2.3],
  };
  h.pick();
  await turn();
  assert.equal(h.$("#wifi-survey-dialog").open, true);
  assert.match(
    h.$("#wifi-survey-anchor").textContent,
    /Коридор у А-215.*2 этаж/u,
  );
  assert.equal(h.state.userLocation, currentPosition);
  assert.equal(h.scans, 0);
});

test("opening the collector freezes a valid legacy manual pin independently of moving GPS", async () => {
  const h = harness({ pendingScan: true });
  assert.equal(
    h.state.surveyLocation,
    undefined,
    "binding does not create a reference",
  );
  h.api.open();
  await turn();
  const reference = h.state.surveyLocation;
  assert.notEqual(reference, h.state.userLocation);
  assert.notEqual(reference.point, h.state.userLocation.point);
  assert.deepEqual(reference.point, [23.1, -1.9]);
  const request = h.$("#wifi-survey-scan").onclick();
  h.state.userLocation = {
    source: "gps",
    campusId: "v-78",
    point: [42, -10],
    label: "Геопозиция",
  };
  h.api.refresh();
  assert.equal(h.state.surveyLocation, reference);
  assert.match(h.$("#wifi-survey-anchor").textContent, /А-214.*2 этаж/u);
  assert.equal(h.cancellations, 0);
  h.finishScan();
  await request;
  const sample = survey.readWifiSurvey(h.storage).samples[0];
  assert.equal(sample.anchor.x, 23.1);
  assert.equal(sample.anchor.z, -1.9);
  assert.equal(sample.anchor.physicalLevel, 2);
  assert.equal(h.storage.writes, 1);
  h.$("#wifi-survey-dialog").close();
  h.state.userLocation = {
    ...reference,
    label: "А-215",
    point: [24.2, -2.3],
  };
  h.api.open();
  await turn();
  assert.equal(
    h.state.surveyLocation,
    reference,
    "reopening keeps the chosen reference",
  );
  assert.match(h.$("#wifi-survey-anchor").textContent, /А-214.*2 этаж/u);
});

test("changing the survey reference while scanning refuses the late result", async () => {
  const h = harness({ pendingScan: true });
  h.api.open();
  await turn();
  const request = h.$("#wifi-survey-scan").onclick();
  h.state.surveyLocation = {
    ...h.state.surveyLocation,
    label: "Коридор у А-215",
    placeId: null,
    point: [24.2, -2.3],
  };
  h.finishScan();
  await request;
  assert.equal(h.storage.writes, 0);
  assert.match(h.$("#wifi-survey-feedback").textContent, /точк|этаж/iu);
});

test("GPS and manual points without a known physical floor are not adopted as survey references", async () => {
  for (const initialPosition of [
    { source: "gps", campusId: "v-78", point: [23.1, -1.9] },
    {
      source: "manual",
      campusId: "v-78",
      floorId: "v-78-floor2",
      point: [23.1, -1.9],
      physicalLevel: null,
    },
  ]) {
    const h = harness({ initialPosition });
    h.api.open();
    await turn();
    assert.equal(h.state.surveyLocation, undefined);
    assert.equal(h.$("#wifi-survey-scan").disabled, true);
    assert.equal(h.scans, 0);
  }
});

test("explicit capture filters SSID and explicit export passes the full saved JSON to system sharing", async () => {
  const h = harness();
  h.api.open();
  await turn();
  await h.$("#wifi-survey-scan").onclick();
  assert.equal(h.scans, 1);
  assert.match(h.$("#wifi-survey-feedback").textContent, /Замер сохранён/u);
  assert.equal(h.$("#wifi-survey-count").textContent, "1 / 500");
  assert.equal(h.$("#wifi-survey-locations").textContent, "1");
  assert.equal(h.$("#wifi-survey-export").hidden, false);
  await h.$("#wifi-survey-export").onclick();
  assert.equal(h.exports.length, 1);
  const saved = JSON.parse(h.exports[0]);
  assert.equal(saved.samples.length, 1);
  assert.equal(saved.samples[0].networks.length, 1);
  assert.equal(saved.samples[0].networks[0].ssid, survey.WIFI_SURVEY_SSID);
  assert.equal(saved.samples[0].anchor.x, 23.1);
  assert.equal(h.shares.length, 1);
  assert.equal(h.shares[0].files[0], "file:///cache/MIREA-WiFi.json");
  assert.equal(
    survey.readWifiSurvey(h.storage).samples.length,
    1,
    "export never deletes captured samples",
  );
});

test("closing a pending capture cancels and refuses a late response", async () => {
  const h = harness({ pendingScan: true });
  h.api.open();
  await turn();
  const request = h.$("#wifi-survey-scan").onclick();
  h.$("#wifi-survey-dialog").close();
  h.finishScan();
  await request;
  assert.equal(h.cancellations, 1);
  assert.equal(h.storage.writes, 0);
});

test("real background hides cancel capture, while a transient permission pause does not cancel a visible dialog", async () => {
  for (const background of [true, false]) {
    const h = harness({ pendingScan: true });
    h.api.open();
    await turn();
    const request = h.$("#wifi-survey-scan").onclick();
    h.document.hidden = background;
    h.window.listeners.get("atlas:app-state")({ detail: { isActive: false } });
    if (!background)
      h.window.listeners.get("atlas:app-state")({ detail: { isActive: true } });
    h.finishScan();
    await request;
    assert.equal(h.cancellations, Number(background));
    assert.equal(h.storage.writes, Number(!background));
  }
});
