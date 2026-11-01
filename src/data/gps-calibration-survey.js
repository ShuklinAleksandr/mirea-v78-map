import registration from "./gps-registration.json" with { type: "json" };

export const GPS_CALIBRATION_SURVEY_STORAGE_KEY =
  "mirea:gps-calibration-survey:v1";
export const GPS_CALIBRATION_SURVEY_LIMIT = 200;
export const GPS_CALIBRATION_PAIR_MAX_AGE_MS = 10_000;
export const GPS_CALIBRATION_MAX_ACCURACY_METERS = 200;
export const GPS_CALIBRATION_CANDIDATE_ACCURACY_METERS = 15;
const MAX_STORAGE_BYTES = 1_000_000;
const KIND = "gps-map-calibration-survey";
const point = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => Number.isFinite(n) && Math.abs(n) <= 10_000);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, limit) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const optionalText = (value, limit) => value == null || text(value, limit);
const close = (a, b) => Math.abs(a - b) <= 1e-6;

export class GpsCalibrationSurveyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GpsCalibrationSurveyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new GpsCalibrationSurveyError(code, message);
};
const invalid = () =>
  fail(
    "storage-invalid",
    "Сохранённые GPS-замеры повреждены или имеют неподдерживаемый формат. Они не перезаписаны.",
  );

function sourceRegistration() {
  return canonicalRegistration(registration);
}

function canonicalRegistration(value) {
  const {
    source,
    sourceSha256,
    status,
    width,
    height,
    metersPerUnit,
    anchors,
  } = value;
  return {
    source,
    sourceSha256,
    status,
    width,
    height,
    metersPerUnit,
    anchors: anchors.map(({ x, y, latitude, longitude }) => ({
      x,
      y,
      latitude,
      longitude,
    })),
  };
}

function validRegistration(value) {
  return (
    value &&
    text(value.source, 300) &&
    /^[a-f0-9]{64}$/u.test(value.sourceSha256) &&
    value.status === "approximate" &&
    [value.width, value.height, value.metersPerUnit].every(
      (n) => Number.isFinite(n) && n > 0 && n <= 100_000,
    ) &&
    Array.isArray(value.anchors) &&
    value.anchors.length === 3 &&
    value.anchors.every(
      (a) =>
        a &&
        Number.isFinite(a.x) &&
        Number.isFinite(a.y) &&
        Number.isFinite(a.latitude) &&
        Math.abs(a.latitude) <= 90 &&
        Number.isFinite(a.longitude) &&
        Math.abs(a.longitude) <= 180,
    )
  );
}

// Reproduce the recorded source registration only. This never fits or applies a
// new registration, and also lets stored observations retain their own version.
function projectedPoint(longitude, latitude, source) {
  const [origin, a, b] = source.anchors;
  const xx = (a.longitude - origin.longitude) / source.width;
  const xy = (a.latitude - origin.latitude) / source.width;
  const yx = (b.longitude - origin.longitude) / source.height;
  const yy = (b.latitude - origin.latitude) / source.height;
  const det = xx * yy - xy * yx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return null;
  const x = longitude - origin.longitude;
  const y = latitude - origin.latitude;
  return [
    ((x * yy - y * yx) / det - source.width / 2) * source.metersPerUnit,
    ((xx * y - xy * x) / det - source.height / 2) * source.metersPerUnit,
  ];
}

function qualityFor(accuracyMeters, offsetMap) {
  return {
    classification:
      accuracyMeters <= GPS_CALIBRATION_CANDIDATE_ACCURACY_METERS
        ? "candidate"
        : "noisy",
    flags: [
      ...(accuracyMeters > GPS_CALIBRATION_CANDIDATE_ACCURACY_METERS
        ? ["poor-provider-accuracy"]
        : []),
      ...(offsetMap > Math.max(50, accuracyMeters * 3)
        ? ["large-discrepancy"]
        : []),
    ],
    requiresFieldReview: true,
    registrationErrorKnown: false,
  };
}

function privacyMetadata() {
  return {
    storage: "local-only",
    automaticUpload: false,
    continuousRecording: false,
    contains: ["manual-map-points", "gps-coordinates", "timestamps"],
  };
}

function recordId(now) {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `gps-${now.toString(36)}-${Math.random().toString(36).slice(2, 14)}`
  );
}

function validAnchor(anchor) {
  return (
    anchor &&
    point(anchor.point) &&
    /^v-78-floor[0-4]$/u.test(anchor.floorId) &&
    anchor.floorEvidence === "manual" &&
    optionalText(anchor.building, 16) &&
    (anchor.physicalLevel == null ||
      (Number.isInteger(anchor.physicalLevel) &&
        anchor.physicalLevel >= -5 &&
        anchor.physicalLevel <= 100)) &&
    text(anchor.label, 240) &&
    optionalText(anchor.placeId, 240) &&
    timestamp(anchor.timestamp)
  );
}

function normalizeRecord(value) {
  const gps = value?.gps;
  const anchor = value?.anchor;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.campusId !== "v-78" ||
    value.source !== "manual-gps-pair" ||
    !text(value.id, 100) ||
    !/^[a-z0-9:_-]+$/iu.test(value.id) ||
    !timestamp(value.recordedAt) ||
    !validAnchor(anchor) ||
    !gps ||
    gps.source !== "system-location" ||
    gps.coordinateSystem !== "WGS84" ||
    !Number.isFinite(gps.latitude) ||
    Math.abs(gps.latitude) > 90 ||
    !Number.isFinite(gps.longitude) ||
    Math.abs(gps.longitude) > 180 ||
    !Number.isFinite(gps.accuracyMeters) ||
    gps.accuracyMeters <= 0 ||
    gps.accuracyMeters > GPS_CALIBRATION_MAX_ACCURACY_METERS ||
    !timestamp(gps.timestamp) ||
    !point(gps.point) ||
    value.recordedAt < anchor.timestamp ||
    value.recordedAt < gps.timestamp ||
    value.recordedAt - anchor.timestamp > GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    value.recordedAt - gps.timestamp > GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    Math.abs(anchor.timestamp - gps.timestamp) >
      GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    !validRegistration(value.registration) ||
    !point(value.deltaMap) ||
    !Number.isFinite(value.offsetMap)
  )
    invalid();
  const projected = projectedPoint(
    gps.longitude,
    gps.latitude,
    value.registration,
  );
  const delta = anchor.point.map((n, i) => n - gps.point[i]);
  const offsetMap = Math.hypot(...delta);
  if (
    !point(projected) ||
    !projected.every((n, i) => close(n, gps.point[i])) ||
    !delta.every((n, i) => close(n, value.deltaMap[i])) ||
    !close(offsetMap, value.offsetMap)
  )
    invalid();
  // Canonical, whitelisted data prevents imported keys/prototypes or a forged
  // quality flag from changing the meaning of a saved observation.
  return {
    schemaVersion: 1,
    id: value.id,
    campusId: "v-78",
    source: "manual-gps-pair",
    recordedAt: value.recordedAt,
    anchor: {
      point: anchor.point.slice(),
      floorId: anchor.floorId,
      building: anchor.building || null,
      physicalLevel: anchor.physicalLevel ?? null,
      floorEvidence: "manual",
      label: anchor.label,
      placeId: anchor.placeId || null,
      timestamp: anchor.timestamp,
    },
    gps: {
      source: "system-location",
      coordinateSystem: "WGS84",
      latitude: gps.latitude,
      longitude: gps.longitude,
      accuracyMeters: gps.accuracyMeters,
      timestamp: gps.timestamp,
      point: gps.point.slice(),
    },
    deltaMap: delta,
    offsetMap,
    quality: qualityFor(gps.accuracyMeters, offsetMap),
    registration: canonicalRegistration(value.registration),
  };
}

/** One explicitly confirmed map point paired with one actual fresh OS fix.
 * The delta is diagnostic evidence, never a correction to the common map. */
export function createGpsCalibrationRecord(
  manualAnchor,
  rawFix,
  { now = Date.now(), id = recordId(now) } = {},
) {
  if (
    manualAnchor?.source !== "manual" ||
    manualAnchor.campusId !== "v-78" ||
    (manualAnchor.floorEvidence != null &&
      manualAnchor.floorEvidence !== "manual") ||
    !validAnchor({
      ...manualAnchor,
      floorEvidence: "manual",
      label: manualAnchor.label || "Точка на карте",
    })
  )
    fail(
      "invalid-anchor",
      "Для GPS-замера укажите точное место на плане В78 и подтвердите точку вручную.",
    );
  if (
    rawFix?.source !== "gps" ||
    rawFix.campusId !== manualAnchor.campusId ||
    rawFix.status !== "inside" ||
    !Number.isFinite(rawFix.latitude) ||
    Math.abs(rawFix.latitude) > 90 ||
    !Number.isFinite(rawFix.longitude) ||
    Math.abs(rawFix.longitude) > 180 ||
    !Number.isFinite(rawFix.accuracyMeters) ||
    rawFix.accuracyMeters <= 0 ||
    rawFix.accuracyMeters > GPS_CALIBRATION_MAX_ACCURACY_METERS
  )
    fail(
      "invalid-gps",
      "Для записи нужен действительный GPS-отсчёт В78 с погрешностью не больше 200 м. Замер не сохранён.",
    );
  if (
    !timestamp(now) ||
    !timestamp(rawFix.timestamp) ||
    rawFix.timestamp > now ||
    manualAnchor.timestamp > now ||
    now - rawFix.timestamp > GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    now - manualAnchor.timestamp > GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    Math.abs(manualAnchor.timestamp - rawFix.timestamp) >
      GPS_CALIBRATION_PAIR_MAX_AGE_MS ||
    (Number.isFinite(rawFix.expiresAt) && now >= rawFix.expiresAt)
  )
    fail(
      "stale-pair",
      "GPS и ручная точка должны быть получены не больше 10 секунд назад. Дождитесь свежего GPS и подтвердите место ещё раз.",
    );
  const source = sourceRegistration();
  const rawPoint = rawFix.rawPoint || rawFix.point;
  const projected = projectedPoint(rawFix.longitude, rawFix.latitude, source);
  if (
    !point(rawPoint) ||
    !point(projected) ||
    !rawPoint.every((n, i) => close(n, projected[i]))
  )
    fail(
      "corrected-gps",
      "Для замера нужен исходный GPS до ручной поправки. Уточнённая точка не заменяет измерение GPS.",
    );
  const delta = manualAnchor.point.map((n, i) => n - rawPoint[i]);
  return normalizeRecord({
    schemaVersion: 1,
    id,
    campusId: "v-78",
    source: "manual-gps-pair",
    recordedAt: now,
    anchor: {
      ...manualAnchor,
      floorEvidence: "manual",
      label: manualAnchor.label || "Точка на карте",
    },
    gps: {
      source: "system-location",
      coordinateSystem: "WGS84",
      latitude: rawFix.latitude,
      longitude: rawFix.longitude,
      accuracyMeters: rawFix.accuracyMeters,
      timestamp: rawFix.timestamp,
      point: rawPoint.slice(),
    },
    deltaMap: delta,
    offsetMap: Math.hypot(...delta),
    registration: source,
  });
}

function normalizeSurvey(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.kind !== KIND ||
    value.campusId !== "v-78" ||
    value.coordinateSystem !== "v78-source-map-meters" ||
    value.timestampUnit !== "unix-ms" ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt ||
    !Array.isArray(value.records) ||
    value.records.length > GPS_CALIBRATION_SURVEY_LIMIT
  )
    invalid();
  const records = value.records.map(normalizeRecord);
  if (
    new Set(records.map((r) => r.id)).size !== records.length ||
    records.some(
      (r) => r.recordedAt < value.createdAt || r.recordedAt > value.updatedAt,
    )
  )
    invalid();
  return {
    schemaVersion: 1,
    kind: KIND,
    campusId: "v-78",
    coordinateSystem: "v78-source-map-meters",
    timestampUnit: "unix-ms",
    purpose: "diagnostic-control-points-not-applied-to-map",
    privacy: privacyMetadata(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    records,
  };
}

export function readGpsCalibrationSurvey(storage) {
  let raw;
  try {
    raw = storage.getItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY);
  } catch {
    fail("storage-unavailable", "Хранилище GPS-замеров недоступно.");
  }
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length > MAX_STORAGE_BYTES) invalid();
  try {
    return normalizeSurvey(JSON.parse(raw));
  } catch {
    invalid();
  }
}

export const loadGpsCalibrationSurvey = readGpsCalibrationSurvey;

export function saveGpsCalibrationSurvey(storage, survey) {
  const clean = normalizeSurvey(survey);
  // Never silently overwrite a corrupt prior collection during recording.
  readGpsCalibrationSurvey(storage);
  const raw = JSON.stringify(clean);
  if (raw.length > MAX_STORAGE_BYTES) invalid();
  try {
    storage.setItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY, raw);
  } catch {
    fail(
      "storage-unavailable",
      "Не удалось сохранить GPS-замер. Экспортируйте имеющиеся записи и проверьте свободное место.",
    );
  }
  return clean;
}

export function appendGpsCalibrationRecord(
  storage,
  record,
  { now = Date.now() } = {},
) {
  const clean = normalizeRecord(record);
  const previous = readGpsCalibrationSurvey(storage);
  if (previous?.records.some((r) => r.id === clean.id))
    fail("duplicate-record", "Этот GPS-замер уже сохранён.");
  if ((previous?.records.length || 0) >= GPS_CALIBRATION_SURVEY_LIMIT)
    fail(
      "survey-full",
      "Сохранено 200 GPS-замеров. Сначала экспортируйте их, затем очистите записи для продолжения.",
    );
  if (!timestamp(now) || now < clean.recordedAt)
    fail("invalid-time", "Некорректное время записи GPS-замера.");
  return saveGpsCalibrationSurvey(storage, {
    schemaVersion: 1,
    kind: KIND,
    campusId: "v-78",
    coordinateSystem: "v78-source-map-meters",
    timestampUnit: "unix-ms",
    createdAt: Math.min(
      previous?.createdAt || clean.recordedAt,
      clean.recordedAt,
    ),
    updatedAt: Math.max(previous?.updatedAt || now, now),
    records: [...(previous?.records || []), clean],
  });
}

export function clearGpsCalibrationSurvey(storage) {
  try {
    storage.removeItem(GPS_CALIBRATION_SURVEY_STORAGE_KEY);
  } catch {
    fail("storage-unavailable", "Не удалось удалить локальные GPS-замеры.");
  }
}

export function exportGpsCalibrationSurvey(survey, { now = Date.now() } = {}) {
  const clean = normalizeSurvey(survey);
  if (!timestamp(now)) fail("invalid-time", "Некорректное время экспорта.");
  return JSON.stringify({ ...clean, exportedAt: now }, null, 2) + "\n";
}
