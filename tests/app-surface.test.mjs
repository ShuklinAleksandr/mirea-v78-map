import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { layout } from "../src/ui/layout.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("test interface has no Wi-Fi collection, clear-history action or source footer", () => {
  assert.doesNotMatch(
    layout,
    /wifi-survey|Замеры Wi-Fi|clear-history|Очистить историю|map-sources|sidebar-footer|OpenStreetMap|pulse\.mirea/iu,
  );
  assert.match(layout, /id="search-clear"/u);
  assert.match(layout, /id="location-gps"/u);
  assert.match(layout, /id="location-map"/u);
});

test("production entry no longer binds a collector or creates an attribution overlay", async () => {
  const app = await read("src/app.js");
  assert.doesNotMatch(
    app,
    /wifiSurvey|bindWifiSurvey|surveyLocation|osm-attribution/u,
  );
  const experience = await read("src/ui/experience.js");
  assert.doesNotMatch(experience, /clear-history|История поиска очищена/u);
  assert.match(experience, /readSaved\("favorites"/u);
  assert.match(experience, /readSaved\("recent"/u);
});

test("Android keeps GPS and compass but has no production Wi-Fi scanner or scan permissions", async () => {
  const manifest = await read("android/app/src/main/AndroidManifest.xml");
  assert.doesNotMatch(
    manifest,
    /ACCESS_WIFI_STATE|CHANGE_WIFI_STATE|NEARBY_WIFI_DEVICES/u,
  );
  assert.match(manifest, /ACCESS_FINE_LOCATION/u);
  assert.match(manifest, /ACCESS_COARSE_LOCATION/u);
  const main = await read(
    "android/app/src/main/java/ru/mirea/spatialatlas/MainActivity.java",
  );
  assert.doesNotMatch(main, /WifiSurvey/u);
  assert.match(main, /registerPlugin\(HeadingPlugin\.class\)/u);
  assert.match(main, /registerPlugin\(GpsCalibrationExportPlugin\.class\)/u);
  for (const file of [
    "src/ui/wifi-survey.js",
    "src/data/wifi-survey.js",
    "android/app/src/main/java/ru/mirea/spatialatlas/WifiSurveyPlugin.java",
    "android/app/src/main/java/ru/mirea/spatialatlas/WifiSurveyPolicy.java",
  ]) {
    await assert.rejects(access(new URL(`../${file}`, import.meta.url)), {
      code: "ENOENT",
    });
  }
});

test("both interfaces expose single-floor controls without an all-floors entry", async () => {
  assert.doesNotMatch(layout, /nav-stack|Все этажи/iu);
  assert.match(layout, /id="nav-inside"/u);
  assert.match(layout, /id="floor-rail"/u);
  const app = await read("src/app.js");
  assert.doesNotMatch(app, /nav-stack|focusStackFloor|setBuildingOverview/u);
});

test("top corner provides campus return while interface choice stays in Settings", () => {
  const header = layout.split("</header>")[0];
  assert.doesNotMatch(header, /interface-badge|Классика|Новая/u);
  assert.match(header, /id="campus-overview"[^>]*hidden/u);
  assert.match(header, /Все корпуса/u);
  const settings = layout.split('<dialog id="settings-dialog">')[1];
  assert.match(settings, /id="interface-classic"/u);
  assert.match(settings, /id="interface-next"/u);
});
