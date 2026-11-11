import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readGpsMeasurements } from "../src/data/gps-measurements.js";

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const median = (values) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const medianPoint = (points) =>
  [0, 1].map((axis) => median(points.map((point) => point[axis])));
const statistics = (values) =>
  values.length
    ? {
        count: values.length,
        min: Math.min(...values),
        median: median(values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        max: Math.max(...values),
        rmse: Math.sqrt(
          values.reduce((sum, value) => sum + value ** 2, 0) / values.length,
        ),
      }
    : null;

function validateBundle(bundle) {
  if (
    bundle?.kind !== "v78-gps-measurements-bundle" ||
    bundle.coordinateSystem !== "WGS84-and-v78-source-map-meters" ||
    bundle.timestampUnit !== "unix-ms"
  )
    throw new Error("Unsupported GPS measurement bundle.");
  // Reuse the recorder's validation, including unique IDs and ordered samples.
  return readGpsMeasurements({ getItem: () => JSON.stringify(bundle) });
}

function analyzeSite(record, index) {
  const points = record.samples.map((sample) => sample.projectedPoint);
  const center = points.length ? medianPoint(points) : null;
  const residual = center?.map(
    (value, axis) => value - record.anchor.point[axis],
  );
  const steps = points.slice(1).map((point, i) => distance(point, points[i]));
  return {
    measurementIndex: index + 1,
    usableForReview: record.summary.usableForReview,
    sampleCount: points.length,
    floorId: record.anchor.floorId,
    physicalLevel: record.anchor.physicalLevel,
    building: record.anchor.building,
    manualPointMapMeters: record.anchor.point.slice(),
    medianGpsPointMapMeters: center,
    gpsMinusManualMapMeters: residual,
    medianPointDistanceToManualMapMeters: residual
      ? Math.hypot(...residual)
      : null,
    reportedAccuracyMeters: statistics(
      record.samples.map((sample) => sample.accuracyMeters),
    ),
    rawSampleDistanceToManualMapMeters: statistics(
      points.map((point) => distance(point, record.anchor.point)),
    ),
    stationaryReplay: center
      ? {
          observedSpanMs: record.summary.observedSpanMs,
          maxRadiusFromMedianMapMeters: Math.max(
            ...points.map((point) => distance(point, center)),
          ),
          rawApparentPathLengthMapMeters: steps.reduce((a, b) => a + b, 0),
          rawNetDisplacementMapMeters: distance(points[0], points.at(-1)),
          maxStepMapMeters: Math.max(0, ...steps),
        }
      : null,
  };
}

function summarize(sites) {
  const usable = sites.filter((site) => site.usableForReview);
  return {
    measurementCount: sites.length,
    sampleCount: sites.reduce((sum, site) => sum + site.sampleCount, 0),
    usableMeasurementCount: usable.length,
    missingPhysicalLevelCount: sites.filter(
      (site) => site.physicalLevel == null,
    ).length,
    missingBuildingCount: sites.filter((site) => site.building == null).length,
    medianPointDistanceToManualMapMeters: statistics(
      usable.map((site) => site.medianPointDistanceToManualMapMeters),
    ),
    stationaryReplay: {
      maxRadiusFromMedianMapMeters: statistics(
        usable.map(
          (site) => site.stationaryReplay.maxRadiusFromMedianMapMeters,
        ),
      ),
      rawApparentPathLengthMapMeters: statistics(
        usable.map(
          (site) => site.stationaryReplay.rawApparentPathLengthMapMeters,
        ),
      ),
    },
  };
}

export function analyzeGpsMeasurements(previousBundle, combinedBundle) {
  const previous = validateBundle(previousBundle);
  const combined = validateBundle(combinedBundle);
  const previousIds = new Set(previous.map((record) => record.id));
  const combinedById = new Map(
    combinedBundle.measurements.map((record) => [record.id, record]),
  );
  for (const [index, record] of previousBundle.measurements.entries()) {
    if (!isDeepStrictEqual(record, combinedById.get(record.id)))
      throw new Error(
        `Previous measurement ${index + 1} is missing or changed.`,
      );
  }
  if (
    combined.some(
      (record) =>
        !isDeepStrictEqual(record.registration, combined[0].registration),
    )
  )
    throw new Error("Measurements use different map registrations.");

  const previousSites = previous.map(analyzeSite);
  const sites = combined.map(analyzeSite);
  const added = combined.filter((record) => !previousIds.has(record.id));
  const addedSites = sites.filter(
    (_, index) => !previousIds.has(combined[index].id),
  );
  const training = previousSites.filter((site) => site.usableForReview);
  const heldOut = addedSites.filter((site) => site.usableForReview);
  const offset = training.length
    ? medianPoint(training.map((site) => site.gpsMinusManualMapMeters))
    : null;
  const before = heldOut.map(
    (site) => site.medianPointDistanceToManualMapMeters,
  );
  const after = offset
    ? heldOut.map((site) => distance(site.gpsMinusManualMapMeters, offset))
    : [];
  for (const site of addedSites) {
    site.nearestPreviousAnchors = previousSites
      .map((oldSite) => ({
        previousMeasurementIndex: oldSite.measurementIndex,
        anchorDistanceMapMeters: distance(
          site.manualPointMapMeters,
          oldSite.manualPointMapMeters,
        ),
        samePlan: site.floorId === oldSite.floorId,
        samePhysicalLevel:
          site.physicalLevel == null || oldSite.physicalLevel == null
            ? null
            : site.physicalLevel === oldSite.physicalLevel,
        residualChangeMapMeters:
          site.gpsMinusManualMapMeters && oldSite.gpsMinusManualMapMeters
            ? distance(
                site.gpsMinusManualMapMeters,
                oldSite.gpsMinusManualMapMeters,
              )
            : null,
        confirmedRepeat: false,
      }))
      .sort((a, b) => a.anchorDistanceMapMeters - b.anchorDistanceMapMeters)
      .slice(0, 3);
  }
  return {
    schemaVersion: 1,
    kind: "private-gps-measurement-analysis",
    calibrationApplied: false,
    methodology: {
      aggregation:
        "One vote per usable measurement; coordinate-wise median GPS center.",
      usable: "Complete, at least five samples spanning at least 15 seconds.",
      units:
        "Map meters; registration error and true GPS error are not separately known.",
      replay:
        "Chronological raw displacement, assuming the user stood still. No route, arrival, turn or navigation-state validation.",
      nearbyAnchors:
        "Spatial proximity only; matching plan IDs do not confirm physical floor or repeated physical location.",
      privacy:
        "No WGS84 coordinates, labels, IDs, device details, timestamps or input paths in this report. Map points remain private.",
    },
    previousMeasurementsUnchanged: true,
    legacyPairsExcluded: {
      previous: previousBundle.legacyCalibration?.records?.length || 0,
      combined: combinedBundle.legacyCalibration?.records?.length || 0,
    },
    groups: {
      previous: summarize(previousSites),
      added: summarize(addedSites),
      combined: summarize(sites),
    },
    previousOnlyTranslationExperiment: {
      applied: false,
      trainingMeasurementCount: training.length,
      gpsMinusManualMedianMapMeters: offset,
      hypotheticalCorrectionMapMeters: offset?.map((value) => -value) ?? null,
      heldOutMeasurementCount: heldOut.length,
      addedMeasurementsAreLater:
        added.length > 0 && previous.length > 0
          ? Math.min(...added.map((record) => record.startedAt)) >=
            Math.max(...previous.map((record) => record.updatedAt))
          : null,
      beforeMapMeters: statistics(before),
      afterMapMeters: statistics(after),
      improvedCount: after.filter((value, index) => value < before[index])
        .length,
      worsenedCount: after.filter((value, index) => value > before[index])
        .length,
    },
    sites,
  };
}

function main(args) {
  if (args.length !== 4 || args[2] !== "--output")
    throw new Error(
      "Usage: node scripts/analyze-gps-measurements.mjs OLD.json COMBINED.json --output .native-build/gps-analysis/report.json",
    );
  const [previousPath, combinedPath, , outputPath] = args.map((arg) =>
    resolve(arg),
  );
  if ([previousPath, combinedPath].includes(outputPath))
    throw new Error("Output must not overwrite an input bundle.");
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const report = analyzeGpsMeasurements(read(previousPath), read(combinedPath));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify(
      {
        groups: report.groups,
        previousOnlyTranslationExperiment:
          report.previousOnlyTranslationExperiment,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Parsing / filesystem errors can include private file contents or paths.
    console.error(
      error.code
        ? `GPS analysis failed (${error.code}).`
        : error instanceof SyntaxError
          ? "GPS analysis failed: invalid JSON."
          : error.message,
    );
    process.exitCode = 1;
  }
}
