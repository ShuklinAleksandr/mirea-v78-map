export const WIFI_SURVEY_STORAGE_KEY = "mirea:wifi-survey:v1";
export const WIFI_SURVEY_SSID = "Moscow_WiFi_Free";
export const WIFI_SURVEY_LIMIT = 500;
export const WIFI_SURVEY_MAX_AGE_MS = 15_000;

export class WifiSurveyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WifiSurveyError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new WifiSurveyError(code, message);
};
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const identifier = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
const text = (value, limit) =>
  typeof value === "string" && value.length <= limit;
const clone = (value) => JSON.parse(JSON.stringify(value));

function validateAnchor(anchor) {
  if (
    !anchor ||
    !Number.isFinite(anchor.x) ||
    !Number.isFinite(anchor.z) ||
    !/^v-78-floor\d+$/u.test(anchor.floorId) ||
    !Number.isInteger(anchor.physicalLevel) ||
    anchor.physicalLevel < -5 ||
    anchor.physicalLevel > 100 ||
    !(
      anchor.building == null ||
      (text(anchor.building, 16) && anchor.building.length > 0)
    ) ||
    !text(anchor.label, 240) ||
    !(anchor.placeId == null || text(anchor.placeId, 240))
  )
    fail(
      "invalid-anchor",
      "Для замера нужна вручную указанная точка В78 с известным физическим этажом.",
    );
  return anchor;
}

/** Preserve the exact chosen map coordinates. A GPS floor, nearest room or
 * source-level number is never substituted for a confirmed physical floor. */
export function wifiSurveyAnchor(position, floors = []) {
  if (
    position?.source !== "manual" ||
    position.campusId !== "v-78" ||
    !Array.isArray(position.point) ||
    position.point.length < 2
  )
    fail(
      "invalid-anchor",
      "Укажите точку на карте В78 вручную. GPS не определяет этаж внутри здания.",
    );
  const anchor = validateAnchor({
    x: position.point[0],
    z: position.point[1],
    floorId: position.floorId,
    building: position.building || null,
    physicalLevel: position.physicalLevel,
    label: position.label || "Точка на карте",
    placeId: position.placeId || null,
  });
  if (floors.length) {
    const floor = floors.find((item) => item.id === anchor.floorId);
    if (
      !floor ||
      (anchor.building &&
        floor.buildingLevels?.[anchor.building] !== anchor.physicalLevel)
    )
      fail(
        "invalid-anchor",
        "Точка и этаж не совпадают с открытыми планами. Укажите точку ещё раз.",
      );
  }
  return anchor;
}

function validateDevice(device) {
  if (
    !device ||
    !text(device.manufacturer, 120) ||
    !text(device.model, 120) ||
    !text(device.androidVersion, 80) ||
    !Number.isInteger(device.api) ||
    device.api < 23 ||
    device.api > 200
  )
    fail(
      "invalid-scan",
      "Android не передал сведения об устройстве для замера.",
    );
  return {
    manufacturer: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    api: device.api,
  };
}

function validateNetwork(network) {
  if (
    !network ||
    !text(network.ssid, 256) ||
    typeof network.bssid !== "string" ||
    !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(network.bssid) ||
    /^(?:00:00:00:00:00:00|02:00:00:00:00:00)$/iu.test(network.bssid) ||
    !Number.isInteger(network.rssi) ||
    network.rssi < -127 ||
    network.rssi > 0 ||
    !Number.isInteger(network.frequency) ||
    network.frequency < 1000 ||
    network.frequency > 100000 ||
    !Number.isFinite(network.ageMs) ||
    network.ageMs < 0 ||
    network.ageMs > WIFI_SURVEY_MAX_AGE_MS ||
    !(
      network.is80211mcResponder == null ||
      typeof network.is80211mcResponder === "boolean"
    )
  )
    fail(
      "invalid-scan",
      "Сканирование вернуло неполные или устаревшие данные. Повторите замер.",
    );
  return {
    ssid: network.ssid,
    bssid: network.bssid.toLowerCase(),
    rssi: network.rssi,
    frequency: network.frequency,
    ageMs: network.ageMs,
    ...(typeof network.is80211mcResponder === "boolean"
      ? { is80211mcResponder: network.is80211mcResponder }
      : {}),
  };
}

export function wifiSurveySample(
  anchor,
  scan,
  {
    includeOtherSsids = false,
    now = Date.now(),
    id = crypto.randomUUID(),
  } = {},
) {
  validateAnchor(anchor);
  if (
    !scan ||
    scan.fresh !== true ||
    scan.source !== "active-scan" ||
    !timestamp(scan.capturedAt) ||
    scan.capturedAt > now + 1000 ||
    now - scan.capturedAt > WIFI_SURVEY_MAX_AGE_MS ||
    !Number.isFinite(scan.ageMs) ||
    scan.ageMs < 0 ||
    scan.ageMs + Math.max(0, now - scan.capturedAt) > WIFI_SURVEY_MAX_AGE_MS ||
    !Array.isArray(scan.networks) ||
    !scan.networks.length ||
    scan.networks.length > 2048 ||
    !timestamp(now) ||
    !identifier(id)
  )
    fail(
      "stale-scan",
      "Свежий замер Wi-Fi не получен. Старые результаты не записаны.",
    );
  const networks = scan.networks.map(validateNetwork);
  if (
    networks.some(
      (network) =>
        network.ageMs + Math.max(0, now - scan.capturedAt) >
        WIFI_SURVEY_MAX_AGE_MS,
    )
  )
    fail("stale-scan", "Результат Wi-Fi устарел до записи. Повторите замер.");
  return {
    id,
    timestamp: scan.capturedAt,
    recordedAt: now,
    anchor: clone(anchor),
    source: "active-scan",
    fresh: true,
    ageMs: scan.ageMs,
    ssidFilter: includeOtherSsids ? null : WIFI_SURVEY_SSID,
    observedNetworkCount: networks.length,
    networks: includeOtherSsids
      ? networks
      : networks.filter((network) => network.ssid === WIFI_SURVEY_SSID),
    device: validateDevice(scan.device),
  };
}

function validateStoredSample(sample) {
  if (
    !sample ||
    !identifier(sample.id) ||
    !timestamp(sample.timestamp) ||
    !timestamp(sample.recordedAt) ||
    sample.source !== "active-scan" ||
    sample.fresh !== true ||
    !Number.isFinite(sample.ageMs) ||
    sample.ageMs < 0 ||
    sample.ageMs > WIFI_SURVEY_MAX_AGE_MS ||
    !(sample.ssidFilter === null || sample.ssidFilter === WIFI_SURVEY_SSID) ||
    !Number.isInteger(sample.observedNetworkCount) ||
    !Array.isArray(sample.networks) ||
    sample.networks.length > 2048 ||
    sample.observedNetworkCount < sample.networks.length ||
    sample.observedNetworkCount > 2048
  )
    fail(
      "storage-invalid",
      "Сохранённые замеры повреждены или имеют неподдерживаемый формат. Они не перезаписаны.",
    );
  validateAnchor(sample.anchor);
  validateDevice(sample.device);
  for (const network of sample.networks) {
    validateNetwork(network);
    if (sample.ssidFilter && network.ssid !== sample.ssidFilter)
      fail(
        "storage-invalid",
        "Сохранённые сети не соответствуют фильтру. Записи не изменены.",
      );
  }
}

export function validateWifiSurvey(session) {
  if (
    !session ||
    session.schemaVersion !== 1 ||
    session.campusId !== "v-78" ||
    !identifier(session.sessionId) ||
    !timestamp(session.createdAt) ||
    !timestamp(session.updatedAt) ||
    session.updatedAt < session.createdAt ||
    session.timestampUnit !== "unix-ms" ||
    session.coordinateSystem !== "v78-source-map-meters" ||
    !Array.isArray(session.samples) ||
    session.samples.length > WIFI_SURVEY_LIMIT
  )
    fail(
      "storage-invalid",
      "Не удалось прочитать сохранённые замеры. Содержимое не изменено; экспортируйте резервную копию.",
    );
  try {
    for (const sample of session.samples) validateStoredSample(sample);
  } catch {
    fail(
      "storage-invalid",
      "В сохранённых замерах есть повреждённая запись. Ничего не удалено; экспортируйте резервную копию.",
    );
  }
  if (
    new Set(session.samples.map((sample) => sample.id)).size !==
    session.samples.length
  )
    fail(
      "storage-invalid",
      "В сохранённых замерах повторяются идентификаторы. Записи не изменены.",
    );
  return session;
}

export function readWifiSurvey(storage) {
  let raw;
  try {
    raw = storage.getItem(WIFI_SURVEY_STORAGE_KEY);
  } catch {
    fail(
      "storage-unavailable",
      "Хранилище приложения недоступно. Замеры не будут потеряны молча — запись остановлена.",
    );
  }
  if (raw === null) return null;
  try {
    return validateWifiSurvey(JSON.parse(raw));
  } catch {
    fail(
      "storage-invalid",
      "Не удалось прочитать сохранённые замеры. Ничего не перезаписано; экспортируйте резервную копию.",
    );
  }
}

export function appendWifiSurveySample(
  storage,
  sample,
  { now = Date.now(), sessionId = crypto.randomUUID() } = {},
) {
  validateStoredSample(sample);
  const previous = readWifiSurvey(storage);
  if (previous?.samples.length >= WIFI_SURVEY_LIMIT)
    fail(
      "sample-limit",
      "Достигнут предел 500 замеров. Экспортируйте JSON; прежние записи сохранены.",
    );
  const session = previous
    ? clone(previous)
    : {
        schemaVersion: 1,
        campusId: "v-78",
        sessionId,
        createdAt: now,
        updatedAt: now,
        timestampUnit: "unix-ms",
        coordinateSystem: "v78-source-map-meters",
        samples: [],
      };
  session.updatedAt = Math.max(session.updatedAt, now);
  session.samples.push(clone(sample));
  validateWifiSurvey(session);
  try {
    storage.setItem(WIFI_SURVEY_STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    fail(
      error?.name === "QuotaExceededError"
        ? "storage-full"
        : "storage-unavailable",
      "Не удалось сохранить новый замер: хранилище недоступно или заполнено. Предыдущие записи сохранены; экспортируйте JSON.",
    );
  }
  return session;
}

export function exportWifiSurvey(storage) {
  const session = readWifiSurvey(storage);
  if (!session?.samples.length)
    fail("empty-session", "Пока нет записанных замеров для экспорта.");
  // Keep every record while avoiding indentation overhead in the native file
  // bridge (8 MiB maximum). The exported object remains a regular JSON session.
  return JSON.stringify(session);
}

/** Broken data is never repaired by dropping records. The user can explicitly
 * export this envelope to recover the untouched original storage value. */
export function exportWifiSurveyBackup(storage) {
  let raw;
  try {
    raw = storage.getItem(WIFI_SURVEY_STORAGE_KEY);
  } catch {
    fail(
      "storage-unavailable",
      "Не удалось прочитать хранилище для резервной копии.",
    );
  }
  if (raw === null) fail("empty-session", "Сохранённой записи нет.");
  return JSON.stringify({
    format: "mirea-wifi-survey-unreadable-backup",
    schemaVersion: 1,
    campusId: "v-78",
    raw,
  });
}

export function wifiSurveyLocationCount(session) {
  return new Set(
    (session?.samples || []).map(({ anchor }) =>
      JSON.stringify([
        anchor.floorId,
        anchor.x,
        anchor.z,
        anchor.building,
        anchor.physicalLevel,
      ]),
    ),
  ).size;
}

export function createWifiSurveyRecorder({
  storage,
  plugin,
  getPosition,
  getFloors = () => [],
  isActive = () => true,
  onChange = () => {},
  now = Date.now,
  newId = () => crypto.randomUUID(),
}) {
  let active = null;
  return {
    get pending() {
      return active !== null;
    },
    async cancel() {
      if (!active) return;
      active = null;
      onChange();
      try {
        await plugin.cancel();
      } catch {
        /* The revision still rejects late responses. */
      }
    },
    async capture({ includeOtherSsids = false } = {}) {
      if (active)
        fail("busy", "Замер уже выполняется. Дождитесь его завершения.");
      const anchor = wifiSurveyAnchor(getPosition(), getFloors());
      const key = JSON.stringify(anchor);
      const previous = readWifiSurvey(storage);
      if (previous?.samples.length >= WIFI_SURVEY_LIMIT)
        fail(
          "sample-limit",
          "Достигнут предел 500 замеров. Экспортируйте JSON; прежние записи сохранены.",
        );
      const token = {};
      active = token;
      onChange();
      try {
        const scan = await plugin.scan();
        if (active !== token || !isActive())
          fail("cancelled", "Замер отменён и не записан.");
        let current;
        try {
          current = wifiSurveyAnchor(getPosition(), getFloors());
        } catch {
          fail(
            "anchor-changed",
            "Точка замера изменилась. Повторите замер на нужном месте.",
          );
        }
        if (JSON.stringify(current) !== key)
          fail(
            "anchor-changed",
            "Точка замера изменилась. Повторите замер на нужном месте.",
          );
        const latest = readWifiSurvey(storage);
        if ((latest?.sessionId || null) !== (previous?.sessionId || null))
          fail(
            "session-changed",
            "Сохранённая сессия изменилась во время замера. Повторите запись.",
          );
        const sample = wifiSurveySample(anchor, scan, {
          includeOtherSsids,
          now: now(),
          id: newId(),
        });
        const session = appendWifiSurveySample(storage, sample, {
          now: now(),
          sessionId: previous?.sessionId || newId(),
        });
        return { session, sample };
      } finally {
        if (active === token) {
          active = null;
          onChange();
        }
      }
    },
  };
}
