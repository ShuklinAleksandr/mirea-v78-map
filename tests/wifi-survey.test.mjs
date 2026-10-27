import test from "node:test";
import assert from "node:assert/strict";
import {
  WIFI_SURVEY_STORAGE_KEY,
  WIFI_SURVEY_SSID,
  WIFI_SURVEY_MAX_AGE_MS,
  WIFI_SURVEY_LIMIT,
  wifiSurveyAnchor,
  wifiSurveySample,
  validateWifiSurvey,
  readWifiSurvey,
  appendWifiSurveySample,
  exportWifiSurvey,
  exportWifiSurveyBackup,
  wifiSurveyLocationCount,
  createWifiSurveyRecorder,
} from "../src/data/wifi-survey.js";

// These fixtures exercise the native response contract, not radio hardware.
const now = 1793044800000;
let sequence = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const position = () => ({
  source: "manual",
  campusId: "v-78",
  floorId: "v-78-floor2",
  building: "А",
  physicalLevel: 2,
  label: "А-214",
  placeId: "v-78--floor-2--9zz",
  point: [23.123456789, -1.987654321],
});
const floors = [{ id: "v-78-floor2", buildingLevels: { А: 2, Г: 3 } }];
const scan = () => ({
  capturedAt: now - 100,
  ageMs: 140,
  fresh: true,
  source: "active-scan",
  networks: [
    {
      ssid: WIFI_SURVEY_SSID,
      bssid: "AA:11:22:33:44:55",
      rssi: -61,
      frequency: 2412,
      ageMs: 120,
      is80211mcResponder: true,
    },
    {
      ssid: "Other_WiFi",
      bssid: "AA:11:22:33:44:56",
      rssi: -40,
      frequency: 5180,
      ageMs: 140,
    },
    {
      ssid: WIFI_SURVEY_SSID,
      bssid: "AA:11:22:33:44:57",
      rssi: -72,
      frequency: 5200,
      ageMs: 50,
    },
  ],
  device: {
    manufacturer: "Google",
    model: "Pixel 7",
    androidVersion: "16",
    api: 36,
  },
});
const sample = (extra = {}) =>
  wifiSurveySample(wifiSurveyAnchor(position(), floors), scan(), {
    now,
    id: uuid(),
    ...extra,
  });
function storage() {
  const values = new Map();
  return {
    writes: 0,
    quota: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.quota) {
        const error = new Error("Quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      this.writes++;
      values.set(key, value);
    },
  };
}
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function recorderFixture() {
  const store = storage();
  const queue = [];
  let pos = position(),
    active = true,
    calls = 0,
    cancellations = 0;
  const plugin = {
    scan() {
      calls++;
      const request = defer();
      queue.push(request);
      return request.promise;
    },
    async cancel() {
      cancellations++;
    },
  };
  const recorder = createWifiSurveyRecorder({
    storage: store,
    plugin,
    getPosition: () => pos,
    getFloors: () => floors,
    isActive: () => active,
    now: () => now,
    newId: uuid,
  });
  return {
    recorder,
    store,
    queue,
    get calls() {
      return calls;
    },
    get cancellations() {
      return cancellations;
    },
    setPosition(value) {
      pos = value;
    },
    setActive(value) {
      active = value;
    },
  };
}
const errorCode = (code) => (error) => error.code === code;

test("Wi-Fi anchors require manual V78 coordinates and a known physical floor, preserving exact x/z", () => {
  assert.deepEqual(wifiSurveyAnchor(position(), floors), {
    x: 23.123456789,
    z: -1.987654321,
    floorId: "v-78-floor2",
    building: "А",
    physicalLevel: 2,
    label: "А-214",
    placeId: "v-78--floor-2--9zz",
  });
  for (const change of [
    { source: "gps" },
    { campusId: "v-86" },
    { physicalLevel: null },
    { physicalLevel: NaN },
    { floorId: "v-78-floor9" },
    { building: "Г", physicalLevel: 2 },
    { point: [Infinity, 0] },
  ])
    assert.throws(
      () => wifiSurveyAnchor({ ...position(), ...change }, floors),
      errorCode("invalid-anchor"),
    );
});

test("SSID filtering is opt-in for other networks and does not alter RSSI or frequencies", () => {
  const filtered = sample();
  assert.equal(filtered.ssidFilter, WIFI_SURVEY_SSID);
  assert.equal(filtered.observedNetworkCount, 3);
  assert.equal(filtered.networks.length, 2);
  assert.deepEqual(
    filtered.networks.map((network) => [network.rssi, network.frequency]),
    [
      [-61, 2412],
      [-72, 5200],
    ],
  );
  assert.equal(filtered.networks[0].bssid, "aa:11:22:33:44:55");
  const all = sample({ includeOtherSsids: true });
  assert.equal(all.ssidFilter, null);
  assert.equal(all.networks.length, 3);
  assert.equal(all.networks[1].ssid, "Other_WiFi");
  const noTarget = scan();
  noTarget.networks = noTarget.networks.filter(
    (network) => network.ssid !== WIFI_SURVEY_SSID,
  );
  const absence = wifiSurveySample(wifiSurveyAnchor(position()), noTarget, {
    now,
    id: uuid(),
  });
  assert.equal(
    absence.networks.length,
    0,
    "a real fresh scan without the target network records absence, not invented APs",
  );
  assert.equal(absence.observedNetworkCount, 1);
});

test("cached, old, empty, redacted and malformed native scans are rejected", () => {
  const cases = [
    { fresh: false },
    { source: "cache" },
    { capturedAt: now - WIFI_SURVEY_MAX_AGE_MS - 1 },
    { capturedAt: now + 2000 },
    { ageMs: WIFI_SURVEY_MAX_AGE_MS + 1 },
    { capturedAt: now - 10_000, ageMs: 5001 },
    { networks: [] },
    {
      networks: [{ ...scan().networks[0], ageMs: WIFI_SURVEY_MAX_AGE_MS + 1 }],
    },
    { networks: [{ ...scan().networks[0], bssid: "02:00:00:00:00:00" }] },
    { networks: [{ ...scan().networks[0], rssi: 50 }] },
  ];
  for (const change of cases)
    assert.throws(() =>
      wifiSurveySample(
        wifiSurveyAnchor(position()),
        { ...scan(), ...change },
        { now, id: uuid() },
      ),
    );
});

test("sessions export all captured facts and round-trip without silently dropping fields or records", () => {
  const store = storage();
  const first = sample();
  appendWifiSurveySample(store, first, { now, sessionId: uuid() });
  const next = sample({ includeOtherSsids: true });
  next.anchor.x += 0.25;
  appendWifiSurveySample(store, next, { now: now + 1000 });
  const output = JSON.parse(exportWifiSurvey(store));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.campusId, "v-78");
  assert.equal(output.timestampUnit, "unix-ms");
  assert.equal(output.createdAt, now);
  assert.equal(output.updatedAt, now + 1000);
  assert.deepEqual(output.samples, [first, next]);
  assert.deepEqual(validateWifiSurvey(output), readWifiSurvey(store));
  assert.equal(wifiSurveyLocationCount(output), 2);
  assert.equal(JSON.stringify(output).includes("deviceId"), false);
  assert.equal(output.samples[0].device.model, "Pixel 7");
});

test("the 500-sample limit fails explicitly and preserves every prior sample", () => {
  const store = storage();
  const saved = appendWifiSurveySample(store, sample(), {
    now,
    sessionId: uuid(),
  });
  saved.samples = Array.from({ length: WIFI_SURVEY_LIMIT }, () => sample());
  store.setItem(WIFI_SURVEY_STORAGE_KEY, JSON.stringify(saved));
  const before = store.getItem(WIFI_SURVEY_STORAGE_KEY);
  assert.throws(
    () => appendWifiSurveySample(store, sample(), { now }),
    errorCode("sample-limit"),
  );
  assert.equal(store.getItem(WIFI_SURVEY_STORAGE_KEY), before);
  assert.equal(readWifiSurvey(store).samples.length, WIFI_SURVEY_LIMIT);
});

test("storage quota failure never reports successful capture or replaces prior samples", async () => {
  const h = recorderFixture();
  appendWifiSurveySample(h.store, sample(), { now, sessionId: uuid() });
  const before = h.store.getItem(WIFI_SURVEY_STORAGE_KEY);
  h.store.quota = true;
  const request = h.recorder.capture();
  h.queue[0].resolve(scan());
  await assert.rejects(request, errorCode("storage-full"));
  assert.equal(h.store.getItem(WIFI_SURVEY_STORAGE_KEY), before);
  assert.equal(h.recorder.pending, false);
});

test("malformed storage is read-only and its exact original value can be backed up", async () => {
  const h = recorderFixture();
  const raw =
    '{"schemaVersion":1,"samples":[{"real":"preserve this partial record"}]';
  h.store.setItem(WIFI_SURVEY_STORAGE_KEY, raw);
  assert.throws(() => readWifiSurvey(h.store), errorCode("storage-invalid"));
  await assert.rejects(h.recorder.capture(), errorCode("storage-invalid"));
  assert.equal(
    h.calls,
    0,
    "storage failure is detected before hardware is requested",
  );
  assert.equal(h.store.getItem(WIFI_SURVEY_STORAGE_KEY), raw);
  const backup = JSON.parse(exportWifiSurveyBackup(h.store));
  assert.equal(backup.raw, raw);
  assert.equal(backup.campusId, "v-78");
});

test("one malformed stored sample blocks mutation rather than being filtered out", () => {
  const store = storage();
  const saved = appendWifiSurveySample(store, sample(), {
    now,
    sessionId: uuid(),
  });
  saved.samples.push({ id: uuid(), timestamp: now, networks: [{ rssi: -60 }] });
  const raw = JSON.stringify(saved);
  store.setItem(WIFI_SURVEY_STORAGE_KEY, raw);
  assert.throws(
    () => appendWifiSurveySample(store, sample(), { now }),
    errorCode("storage-invalid"),
  );
  assert.equal(store.getItem(WIFI_SURVEY_STORAGE_KEY), raw);
});

test("changing the manual anchor while waiting rejects the scan without recording it", async () => {
  const h = recorderFixture();
  const request = h.recorder.capture();
  h.setPosition({ ...position(), point: [24, -2] });
  h.queue[0].resolve(scan());
  await assert.rejects(request, errorCode("anchor-changed"));
  assert.equal(h.store.writes, 0);
});

test("closed or backgrounded capture cannot store a late native response", async () => {
  for (const explicitCancel of [true, false]) {
    const h = recorderFixture();
    const request = h.recorder.capture();
    if (explicitCancel) await h.recorder.cancel();
    else h.setActive(false);
    h.queue[0].resolve(scan());
    await assert.rejects(request, errorCode("cancelled"));
    assert.equal(h.store.writes, 0);
    assert.equal(h.cancellations, Number(explicitCancel));
  }
});

test("transient permission pause followed by an active dialog can commit a fresh requested scan", async () => {
  const h = recorderFixture();
  const request = h.recorder.capture();
  h.setActive(false);
  h.setActive(true);
  h.queue[0].resolve(scan());
  const result = await request;
  assert.equal(result.session.samples.length, 1);
  assert.equal(h.calls, 1);
});

test("a late cancelled request cannot clear the pending state of a new request", async () => {
  const h = recorderFixture();
  const first = h.recorder.capture();
  await h.recorder.cancel();
  const second = h.recorder.capture();
  h.queue[0].resolve(scan());
  await assert.rejects(first, errorCode("cancelled"));
  assert.equal(h.recorder.pending, true);
  h.queue[1].resolve(scan());
  await second;
  assert.equal(readWifiSurvey(h.store).samples.length, 1);
});

test("repeated taps do not request two active scans and concurrent storage changes are preserved", async () => {
  const h = recorderFixture();
  const first = h.recorder.capture();
  await assert.rejects(h.recorder.capture(), errorCode("busy"));
  assert.equal(h.calls, 1);
  const independent = appendWifiSurveySample(h.store, sample(), {
    now,
    sessionId: uuid(),
  });
  h.queue[0].resolve(scan());
  await assert.rejects(first, errorCode("session-changed"));
  assert.deepEqual(readWifiSurvey(h.store), independent);
});
