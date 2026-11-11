import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeGpsMeasurements } from "../scripts/analyze-gps-measurements.mjs";

const T = 1_800_000_000_000;
function record(id, point, points, index = 0) {
  const startedAt = T + index * 60_000;
  return {
    schemaVersion: 1,
    id,
    startedAt,
    updatedAt: startedAt + 30_000,
    status: "complete",
    appVersion: "test",
    device: { platform: "android", userAgent: "PRIVATE_DEVICE" },
    anchor: {
      point,
      floorId: "v-78-floor2",
      building: null,
      physicalLevel: null,
      label: "PRIVATE_LABEL",
      landmark: "PRIVATE_LANDMARK",
      confirmedAt: startedAt,
    },
    registration: { sourceSha256: "a".repeat(64), status: "approximate" },
    samples: points.map((projectedPoint, i) => ({
      timestamp: startedAt + 1_000 + (i * 20_000) / (points.length - 1),
      receivedAt: startedAt + 1_100 + (i * 20_000) / (points.length - 1),
      latitude: 12.3456789,
      longitude: 23.4567891,
      accuracyMeters: 5,
      projectedPoint,
    })),
  };
}
const repeat = (point, count = 5) =>
  Array.from({ length: count }, () => [...point]);
const bundle = (measurements) => ({
  schemaVersion: 1,
  kind: "v78-gps-measurements-bundle",
  campusId: "v-78",
  coordinateSystem: "WGS84-and-v78-source-map-meters",
  timestampUnit: "unix-ms",
  measurements,
});

test("comparison gives each usable measurement one vote and excludes repeated old records", () => {
  const previous = bundle([
    record("old-a", [0, 0], repeat([2, 0], 5)),
    record("old-b", [20, 0], repeat([24, 0], 5), 1),
    record("old-c", [40, 0], repeat([60, 0], 21), 2),
  ]);
  const combined = bundle([
    ...previous.measurements,
    record("new", [100, 0], repeat([96, 0]), 3),
  ]);
  const original = JSON.stringify([previous, combined]);
  const report = analyzeGpsMeasurements(previous, combined);
  assert.equal(report.groups.combined.measurementCount, 4);
  assert.equal(report.groups.combined.sampleCount, 36);
  assert.equal(report.groups.added.measurementCount, 1);
  assert.deepEqual(
    report.previousOnlyTranslationExperiment.gpsMinusManualMedianMapMeters,
    [4, 0],
  );
  assert.equal(
    report.previousOnlyTranslationExperiment.beforeMapMeters.median,
    4,
  );
  assert.equal(
    report.previousOnlyTranslationExperiment.afterMapMeters.median,
    8,
  );
  assert.equal(report.previousOnlyTranslationExperiment.improvedCount, 0);
  assert.equal(report.previousOnlyTranslationExperiment.worsenedCount, 1);
  assert.equal(
    report.previousOnlyTranslationExperiment.addedMeasurementsAreLater,
    true,
  );
  assert.equal(report.calibrationApplied, false);
  assert.equal(JSON.stringify([previous, combined]), original);
  const output = JSON.stringify(report);
  for (const privateValue of [
    "PRIVATE_",
    "12.3456789",
    "23.4567891",
    "old-a",
    String(T),
  ])
    assert.ok(!output.includes(privateValue));
});

test("stationary replay measures raw apparent travel without claiming route progress", () => {
  const current = bundle([
    record(
      "jitter",
      [0, 0],
      [
        [0, 0],
        [3, 4],
        [0, 0],
        [3, 4],
        [0, 0],
      ],
    ),
  ]);
  const report = analyzeGpsMeasurements(bundle([]), current);
  assert.deepEqual(report.sites[0].medianGpsPointMapMeters, [0, 0]);
  assert.equal(
    report.sites[0].stationaryReplay.maxRadiusFromMedianMapMeters,
    5,
  );
  assert.equal(
    report.sites[0].stationaryReplay.rawApparentPathLengthMapMeters,
    20,
  );
  assert.equal(report.sites[0].stationaryReplay.rawNetDisplacementMapMeters, 0);
  assert.equal(report.previousOnlyTranslationExperiment.afterMapMeters, null);
});

test("nearby anchors use geometry, preserve unknown physical floors and do not assert a repeat", () => {
  const previous = bundle([
    record("far", [100, 100], repeat([100, 101])),
    record("near", [0, 0], repeat([1, 0]), 1),
  ]);
  previous.measurements[1].anchor.landmark = "Different label";
  const combined = bundle([
    ...previous.measurements,
    record("new", [2, 0], repeat([4, 0]), 2),
  ]);
  const nearest = analyzeGpsMeasurements(previous, combined).sites[2]
    .nearestPreviousAnchors[0];
  assert.equal(nearest.previousMeasurementIndex, 2);
  assert.equal(nearest.anchorDistanceMapMeters, 2);
  assert.equal(nearest.residualChangeMapMeters, 1);
  assert.equal(nearest.samePhysicalLevel, null);
  assert.equal(nearest.confirmedRepeat, false);
});

test("changed, missing, duplicate and invalid records cannot silently enter the comparison", () => {
  const previous = bundle([record("old", [0, 0], repeat([1, 1]))]);
  const changed = structuredClone(previous);
  changed.measurements[0].anchor.point[0] = 1;
  assert.throws(
    () => analyzeGpsMeasurements(previous, changed),
    /missing or changed/,
  );
  assert.throws(
    () => analyzeGpsMeasurements(previous, bundle([])),
    /missing or changed/,
  );
  assert.throws(() =>
    analyzeGpsMeasurements(
      previous,
      bundle([...previous.measurements, ...previous.measurements]),
    ),
  );
  const invalid = structuredClone(previous);
  invalid.measurements[0].samples[1].timestamp =
    invalid.measurements[0].samples[0].timestamp;
  assert.throws(() => analyzeGpsMeasurements(bundle([]), invalid));
  assert.throws(() => analyzeGpsMeasurements({}, previous), /Unsupported/);
  const differentRegistration = structuredClone(previous.measurements[0]);
  differentRegistration.id = "new";
  differentRegistration.registration.sourceSha256 = "b".repeat(64);
  assert.throws(
    () =>
      analyzeGpsMeasurements(
        previous,
        bundle([...previous.measurements, differentRegistration]),
      ),
    /different map registrations/,
  );
});

test("incomplete sessions stay visible but do not train or score a correction", () => {
  const incomplete = record("partial", [0, 0], repeat([100, 100]));
  incomplete.status = "partial";
  const previous = bundle([incomplete]);
  const report = analyzeGpsMeasurements(previous, previous);
  assert.equal(report.groups.previous.measurementCount, 1);
  assert.equal(report.groups.previous.usableMeasurementCount, 0);
  assert.equal(
    report.previousOnlyTranslationExperiment.trainingMeasurementCount,
    0,
  );
  assert.equal(
    report.previousOnlyTranslationExperiment.gpsMinusManualMedianMapMeters,
    null,
  );
});

test("CLI requires an explicit report path and never overwrites inputs or existing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "gps-analysis-"));
  const previousPath = join(directory, "previous.json");
  const currentPath = join(directory, "current.json");
  const outputPath = join(directory, "report.json");
  const previous = bundle([record("old", [0, 0], repeat([1, 1]))]);
  writeFileSync(previousPath, JSON.stringify(previous));
  writeFileSync(currentPath, JSON.stringify(previous));
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/analyze-gps-measurements.mjs", import.meta.url),
        ),
        previousPath,
        currentPath,
        ...args,
      ],
      { encoding: "utf8" },
    );
  try {
    assert.notEqual(run().status, 0);
    assert.notEqual(run("--output", previousPath).status, 0);
    const result = run("--output", outputPath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(readFileSync(outputPath)).groups.combined.measurementCount,
      1,
    );
    assert.ok(!result.stdout.includes("PRIVATE_"));
    assert.ok(!result.stdout.includes("manualPoint"));
    assert.notEqual(run("--output", outputPath).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(previousPath)), previous);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
