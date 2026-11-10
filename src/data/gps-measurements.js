import registration from "./gps-registration.json" with { type: "json" };
import { projectGpsToMap } from "../location.js";
import { readGpsCalibrationSurvey } from "./gps-calibration-survey.js";

export const GPS_MEASUREMENTS_KEY = "mirea:gps-measurements:v1";
export const GPS_MEASUREMENT_DURATION_MS = 30_000;
const MAX_RECORDS = 100;
const MAX_SAMPLES = 80;
const MAX_BYTES = 2_500_000;
const kinds = new Set(["recording", "complete", "partial", "interrupted"]);
const number = (n) => Number.isFinite(n);
const time = (n) => Number.isSafeInteger(n) && n > 0;
const point = (p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every((n) => number(n) && Math.abs(n) < 10_000);
const short = (s, limit = 240) =>
  typeof s === "string" &&
  s.length <= limit &&
  !/[\u0000-\u001f\u007f]/u.test(s);
const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => {
  throw new Error(message);
};

export function gpsMeasurementSummary(record) {
  const samples = record.samples;
  const accuracy = samples.map((s) => s.accuracyMeters).sort((a, b) => a - b);
  return {
    sampleCount: samples.length,
    observedSpanMs:
      samples.length > 1 ? samples.at(-1).timestamp - samples[0].timestamp : 0,
    minReportedAccuracyMeters: accuracy[0] ?? null,
    medianReportedAccuracyMeters: accuracy.length
      ? accuracy[Math.floor(accuracy.length / 2)]
      : null,
    maxReportedAccuracyMeters: accuracy.at(-1) ?? null,
    usableForReview:
      record.status === "complete" &&
      samples.length >= 5 &&
      samples.at(-1).timestamp - samples[0].timestamp >= 15_000,
    registrationErrorKnown: false,
    requiresFieldReview: true,
  };
}

function normalizeRecord(record) {
  const anchor = record?.anchor;
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !short(record.id, 100) ||
    !record.id ||
    !time(record.startedAt) ||
    !time(record.updatedAt) ||
    record.updatedAt < record.startedAt ||
    !kinds.has(record.status) ||
    !short(record.stopReason || "") ||
    !anchor ||
    !point(anchor.point) ||
    !/^v-78-floor[0-4]$/u.test(anchor.floorId) ||
    !short(anchor.label) ||
    !short(anchor.landmark) ||
    !anchor.landmark.trim() ||
    !short(anchor.building || "", 16) ||
    !(
      anchor.physicalLevel == null ||
      (Number.isInteger(anchor.physicalLevel) &&
        anchor.physicalLevel >= -1 &&
        anchor.physicalLevel <= 20)
    ) ||
    !time(anchor.confirmedAt) ||
    anchor.confirmedAt > record.startedAt ||
    !Array.isArray(record.samples) ||
    record.samples.length > MAX_SAMPLES ||
    !record.registration ||
    !/^[a-f0-9]{64}$/u.test(record.registration.sourceSha256 || "") ||
    !record.device ||
    record.device.platform !== "android" ||
    !short(record.device.userAgent, 512) ||
    !short(record.appVersion, 32)
  )
    fail(
      "Сохранённые замеры имеют неподдерживаемый формат. Данные не перезаписаны.",
    );
  let last = record.startedAt - 1;
  const samples = record.samples.map((sample) => {
    if (
      !sample ||
      !time(sample.timestamp) ||
      sample.timestamp <= last ||
      sample.timestamp > record.updatedAt ||
      !time(sample.receivedAt) ||
      sample.receivedAt < sample.timestamp ||
      sample.receivedAt > record.updatedAt ||
      !number(sample.latitude) ||
      Math.abs(sample.latitude) > 90 ||
      !number(sample.longitude) ||
      Math.abs(sample.longitude) > 180 ||
      !number(sample.accuracyMeters) ||
      sample.accuracyMeters <= 0 ||
      sample.accuracyMeters > 100_000 ||
      !point(sample.projectedPoint)
    )
      fail(
        "В сохранённом замере некорректные GPS-отсчёты. Данные не перезаписаны.",
      );
    last = sample.timestamp;
    return {
      timestamp: sample.timestamp,
      receivedAt: sample.receivedAt,
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyMeters: sample.accuracyMeters,
      projectedPoint: sample.projectedPoint.slice(),
    };
  });
  const clean = {
    schemaVersion: 1,
    id: record.id,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    requestedDurationMs: GPS_MEASUREMENT_DURATION_MS,
    status: record.status,
    stopReason: record.stopReason || "",
    appVersion: record.appVersion,
    device: { platform: "android", userAgent: record.device.userAgent },
    anchor: {
      point: anchor.point.slice(),
      floorId: anchor.floorId,
      building: anchor.building || null,
      physicalLevel: anchor.physicalLevel ?? null,
      floorEvidence: "manually-confirmed",
      label: anchor.label,
      landmark: anchor.landmark,
      confirmedAt: anchor.confirmedAt,
    },
    registration: clone(record.registration),
    samples,
  };
  return { ...clean, summary: gpsMeasurementSummary(clean) };
}

export function createGpsMeasurement(
  anchor,
  {
    now = Date.now(),
    appVersion,
    userAgent = "",
    id = globalThis.crypto?.randomUUID?.() ||
      `measurement-${now}-${Math.random().toString(36).slice(2)}`,
  } = {},
) {
  if (anchor?.source !== "manual" || anchor.campusId !== "v-78")
    fail("Укажите реальное место на плане В78.");
  return normalizeRecord({
    schemaVersion: 1,
    id,
    startedAt: now,
    updatedAt: now,
    status: "recording",
    stopReason: "",
    appVersion,
    device: { platform: "android", userAgent: userAgent.slice(0, 512) },
    anchor: { ...anchor, confirmedAt: now },
    registration: {
      status: registration.status,
      source: registration.source,
      sourceSha256: registration.sourceSha256,
      width: registration.width,
      height: registration.height,
      metersPerUnit: registration.metersPerUnit,
      anchors: clone(registration.anchors),
    },
    samples: [],
  });
}

/** Never uses the displayed, manually corrected or route-snapped position. */
export function appendGpsMeasurementSample(
  record,
  fix,
  { now = Date.now() } = {},
) {
  if (
    record.status !== "recording" ||
    record.samples.length >= MAX_SAMPLES ||
    fix?.source !== "gps" ||
    !time(fix.timestamp) ||
    fix.timestamp < record.startedAt ||
    fix.timestamp > now ||
    now - fix.timestamp > 10_000 ||
    fix.timestamp <= (record.samples.at(-1)?.timestamp ?? -Infinity) ||
    !number(fix.latitude) ||
    Math.abs(fix.latitude) > 90 ||
    !number(fix.longitude) ||
    Math.abs(fix.longitude) > 180 ||
    !number(fix.accuracyMeters) ||
    fix.accuracyMeters <= 0 ||
    fix.accuracyMeters > 100_000
  )
    return record;
  const projectedPoint = projectGpsToMap(fix.longitude, fix.latitude);
  if (!point(projectedPoint)) return record;
  return normalizeRecord({
    ...record,
    updatedAt: now,
    samples: [
      ...record.samples,
      {
        timestamp: fix.timestamp,
        receivedAt: now,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyMeters: fix.accuracyMeters,
        projectedPoint,
      },
    ],
  });
}

export function finishGpsMeasurement(
  record,
  { now = Date.now(), reason = "timer" } = {},
) {
  if (record.status !== "recording") return record;
  const status =
    reason === "timer" && now - record.startedAt >= GPS_MEASUREMENT_DURATION_MS
      ? "complete"
      : reason === "manual-stop"
        ? "partial"
        : "interrupted";
  return normalizeRecord({
    ...record,
    updatedAt: Math.max(record.updatedAt, now),
    status,
    stopReason: reason,
  });
}

export function readGpsMeasurements(storage) {
  let raw;
  try {
    raw = storage.getItem(GPS_MEASUREMENTS_KEY);
  } catch {
    fail("Хранилище замеров недоступно.");
  }
  if (raw == null) return [];
  try {
    if (
      typeof raw !== "string" ||
      new TextEncoder().encode(raw).byteLength > MAX_BYTES
    )
      throw new Error();
    const value = JSON.parse(raw);
    if (
      value.schemaVersion !== 1 ||
      value.campusId !== "v-78" ||
      !Array.isArray(value.measurements) ||
      value.measurements.length > MAX_RECORDS
    )
      throw new Error();
    const records = value.measurements.map(normalizeRecord);
    if (new Set(records.map((r) => r.id)).size !== records.length)
      throw new Error();
    return records;
  } catch {
    fail("Сохранённые замеры повреждены. Они не перезаписаны.");
  }
}

export function saveGpsMeasurement(storage, record) {
  const clean = normalizeRecord(record);
  const records = readGpsMeasurements(storage);
  const index = records.findIndex((r) => r.id === clean.id);
  if (index < 0) {
    if (records.length >= MAX_RECORDS)
      fail(
        "Достигнут лимит 100 замеров. Записи сохранены и доступны для выгрузки; экспорт не удаляет их.",
      );
    records.push(clean);
  } else records[index] = clean;
  const json = JSON.stringify({
    schemaVersion: 1,
    campusId: "v-78",
    measurements: records,
  });
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES)
    fail("Хранилище замеров заполнено. Выгрузите файл.");
  try {
    storage.setItem(GPS_MEASUREMENTS_KEY, json);
  } catch {
    fail(
      "Не удалось сохранить замер на телефоне. Запись остановлена; попробуйте выгрузить данные.",
    );
  }
  return records;
}

export function exportGpsMeasurements(
  records,
  {
    now = Date.now(),
    legacyPairs = null,
    pendingRecord = null,
    warnings = [],
  } = {},
) {
  const clean = records.map(normalizeRecord);
  if (pendingRecord) {
    const pending = normalizeRecord(pendingRecord);
    const index = clean.findIndex((r) => r.id === pending.id);
    if (index < 0) clean.push(pending);
    else clean[index] = pending;
  }
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "v78-gps-measurements-bundle",
        campusId: "v-78",
        exportedAt: now,
        coordinateSystem: "WGS84-and-v78-source-map-meters",
        timestampUnit: "unix-ms",
        purpose: "diagnostic-control-points-not-applied-to-map",
        privacy: {
          storage: "local-only",
          automaticUpload: false,
          contains: [
            "manual-map-points",
            "gps-coordinates",
            "timestamps",
            "app-version",
            "android-webview-user-agent",
          ],
        },
        measurements: clean,
        legacyCalibration: legacyPairs,
        completeCollection: warnings.length === 0,
        exportWarnings: warnings,
      },
      null,
      2,
    ) + "\n"
  );
}

/** A failed storage read must not block rescue of samples still in memory.
 * Any incomplete collection is explicitly labelled, never silently called all. */
export function prepareGpsMeasurementExport(
  storage,
  {
    cachedRecords = [],
    cachedLegacy = null,
    pendingRecord = null,
    now = Date.now(),
  } = {},
) {
  let records = cachedRecords,
    legacyPairs = cachedLegacy;
  const warnings = [];
  try {
    records = readGpsMeasurements(storage);
  } catch {
    warnings.push(
      "Не удалось прочитать сохранённые серии. Включены только доступные записи из памяти; более ранние серии могут отсутствовать.",
    );
  }
  try {
    legacyPairs = readGpsCalibrationSurvey(storage);
  } catch {
    warnings.push(
      "Не удалось прочитать прежние одиночные уточнения GPS. Включена только доступная копия из памяти.",
    );
  }
  if (!records.length && !pendingRecord && !legacyPairs?.records?.length)
    fail("Нет доступных замеров для выгрузки. Сохранённые данные не удалены.");
  return {
    json: exportGpsMeasurements(records, {
      now,
      legacyPairs,
      pendingRecord,
      warnings,
    }),
    warnings,
  };
}
