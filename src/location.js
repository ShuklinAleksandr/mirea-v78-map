import { Capacitor } from "@capacitor/core";
import registration from "./data/gps-registration.json" with { type: "json" };

export const GPS_MAX_AGE_MS = 60_000;
const GPS_TIMEOUT_MS = 15_000;
const finitePoint = (point) =>
  Array.isArray(point) &&
  point.length >= 2 &&
  point.slice(0, 2).every(Number.isFinite);

export function pointInLocationPolygon(point, polygon) {
  if (!finitePoint(point) || !polygon?.points?.length) return false;
  const inside = (ring) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      const cross =
        (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
      if (
        Math.abs(cross) < 1e-7 &&
        point[0] >= Math.min(a[0], b[0]) &&
        point[0] <= Math.max(a[0], b[0]) &&
        point[1] >= Math.min(a[1], b[1]) &&
        point[1] <= Math.max(a[1], b[1])
      )
        return true;
      if (
        a[1] > point[1] !== b[1] > point[1] &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        result = !result;
    }
    return result;
  };
  return inside(polygon.points) && !(polygon.holes || []).some(inside);
}

/** The same inverse affine registration used by build-exterior-context.py. */
export function projectGpsToMap(longitude, latitude) {
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    return null;
  const [origin, a, b] = registration.anchors;
  const xx = (a.longitude - origin.longitude) / registration.width;
  const xy = (a.latitude - origin.latitude) / registration.width;
  const yx = (b.longitude - origin.longitude) / registration.height;
  const yy = (b.latitude - origin.latitude) / registration.height;
  const det = xx * yy - xy * yx;
  const x = longitude - origin.longitude,
    y = latitude - origin.latitude;
  return [
    ((x * yy - y * yx) / det - registration.width / 2) *
      registration.metersPerUnit,
    ((xx * y - xy * x) / det - registration.height / 2) *
      registration.metersPerUnit,
  ];
}

function accuracyRadius(accuracyMeters, longitude, latitude) {
  const p = projectGpsToMap(longitude, latitude);
  const east = projectGpsToMap(
    longitude + 1 / (111_320 * Math.cos((latitude * Math.PI) / 180)),
    latitude,
  );
  const north = projectGpsToMap(longitude, latitude + 1 / 111_320);
  if (!p || !east || !north) return accuracyMeters;
  const a = east[0] - p[0],
    b = north[0] - p[0];
  const c = east[1] - p[1],
    d = north[1] - p[1];
  const trace = a * a + b * b + c * c + d * d;
  const determinant = (a * d - b * c) ** 2;
  // A circle enclosing the transformed provider accuracy region. Registration
  // error is unknown and must not be advertised as a GPS confidence interval.
  return (
    accuracyMeters *
    Math.sqrt(
      (trace + Math.sqrt(Math.max(0, trace * trace - 4 * determinant))) / 2,
    )
  );
}

export function normalizeGpsPosition(position, now = Date.now()) {
  const { latitude, longitude, accuracy } = position?.coords || {};
  const timestamp = Number(position?.timestamp);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(accuracy) ||
    accuracy <= 0 ||
    !Number.isFinite(timestamp) ||
    timestamp > now + 10_000
  )
    throw new Error("GPS вернул некорректные координаты. Попробуйте ещё раз.");
  if (now - timestamp > GPS_MAX_AGE_MS)
    throw new Error(
      "Положение GPS устарело. Повторите определение или укажите точку вручную.",
    );
  const point = projectGpsToMap(longitude, latitude);
  if (!point) throw new Error("GPS вернул некорректные координаты.");
  const inside = registration.campusBoundary.some((polygon) =>
    pointInLocationPolygon(point, polygon),
  );
  const usefulAccuracy = accuracy <= 200;
  const status = !usefulAccuracy ? "uncertain" : inside ? "inside" : "outside";
  return {
    source: "gps",
    campusId: inside && usefulAccuracy ? registration.campusId : null,
    floorId: null,
    building: null,
    point: inside && usefulAccuracy ? point : null,
    latitude,
    longitude,
    accuracyMeters: accuracy,
    accuracyRadiusMap: accuracyRadius(accuracy, longitude, latitude),
    timestamp,
    expiresAt: timestamp + GPS_MAX_AGE_MS,
    label: "Местоположение GPS",
    status,
    registrationStatus: registration.status,
    message: !usefulAccuracy
      ? `Точность GPS ±${Math.round(accuracy)} м — для этой карты недостаточна. Укажите точку вручную.`
      : inside
        ? `GPS ±${Math.round(accuracy)} м. Этаж неизвестен, привязка карты приблизительная.`
        : "Вы за пределами карты Вернадского, 78. Внутри вуза можно указать точку вручную.",
  };
}

export function gpsErrorMessage(error) {
  const code = String(error?.code || "");
  if (error?.name === "AbortError")
    return "Определение местоположения отменено.";
  if (code === "1" || code === "OS-PLUG-GLOC-0003")
    return "Доступ к местоположению запрещён. Разрешите его в настройках или укажите точку вручную.";
  if (code === "3" || code === "OS-PLUG-GLOC-0010")
    return "GPS не ответил вовремя. Попробуйте у окна или укажите точку вручную.";
  if (code === "OS-PLUG-GLOC-0007")
    return "Геолокация выключена на устройстве. Включите её или укажите точку вручную.";
  return (
    error?.message ||
    "Не удалось определить местоположение. Укажите точку вручную."
  );
}

/** One explicit foreground request. Never starts watching or grants permissions on startup. */
export async function requestGpsLocation({
  signal,
  native = Capacitor.isNativePlatform(),
  plugin,
  browser = globalThis.navigator,
  now = Date.now,
  lifecycleTarget = globalThis.window,
  documentTarget = globalThis.document,
} = {}) {
  if (
    signal?.aborted ||
    documentTarget?.hidden ||
    documentTarget?.documentElement?.dataset?.appActive === "false"
  )
    throw new DOMException("Отменено", "AbortError");
  let timer,
    abort,
    requestingPermission = false,
    ended = false;
  const checkActive = () => {
    if (ended || signal?.aborted)
      throw new DOMException("Отменено", "AbortError");
  };
  const background = (event) => {
    // Android's runtime permission sheet may pause the Activity while the web
    // document remains visible. That temporary app-state event is part of the
    // permission request, not a decision to keep locating in the background.
    const permissionSheetPause =
      event?.type === "atlas:app-state" &&
      event?.detail?.isActive === false &&
      requestingPermission &&
      documentTarget?.hidden === false;
    if (
      documentTarget?.hidden ||
      event?.type === "pagehide" ||
      (event?.detail?.isActive === false && !permissionSheetPause)
    )
      abort();
  };
  const canceled = new Promise((_, reject) => {
    abort = () => {
      ended = true;
      reject(new DOMException("Отменено", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    documentTarget?.addEventListener("visibilitychange", background);
    lifecycleTarget?.addEventListener("atlas:app-state", background);
    lifecycleTarget?.addEventListener("pagehide", background);
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error(
              "GPS не ответил вовремя. Попробуйте у окна или укажите точку вручную.",
            ),
            { code: 3 },
          ),
        ),
      GPS_TIMEOUT_MS + 1000,
    );
  });
  const locate = async () => {
    const options = {
      enableHighAccuracy: true,
      timeout: GPS_TIMEOUT_MS,
      maximumAge: 0,
    };
    if (native) {
      const api =
        plugin || (await import("@capacitor/geolocation")).Geolocation;
      checkActive();
      const permissions = await api.checkPermissions();
      if (
        permissions.location !== "granted" &&
        permissions.coarseLocation !== "granted"
      ) {
        checkActive();
        let result;
        requestingPermission = true;
        try {
          result = await api.requestPermissions({
            permissions: ["location"],
          });
        } finally {
          requestingPermission = false;
        }
        if (
          result.location !== "granted" &&
          result.coarseLocation !== "granted"
        )
          throw Object.assign(
            new Error(
              "Доступ к местоположению запрещён. Укажите точку вручную.",
            ),
            { code: 1 },
          );
      }
      checkActive();
      return api.getCurrentPosition(options);
    }
    if (!browser?.geolocation)
      throw new Error(
        "В этом браузере GPS недоступен. Откройте защищённую страницу или укажите точку вручную.",
      );
    return new Promise((resolve, reject) =>
      browser.geolocation.getCurrentPosition(resolve, reject, options),
    );
  };
  try {
    const result = await Promise.race([locate(), canceled]);
    checkActive();
    return normalizeGpsPosition(result, now());
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(gpsErrorMessage(error));
  } finally {
    ended = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    documentTarget?.removeEventListener("visibilitychange", background);
    lifecycleTarget?.removeEventListener("atlas:app-state", background);
    lifecycleTarget?.removeEventListener("pagehide", background);
  }
}

/** Starts one explicitly requested foreground watch. Closing an application
 * dialog is deliberately unrelated to the sensor's lifetime. The caller owns
 * the returned stop function and can restart after a foreground lifecycle event.
 */
export async function watchGpsLocation({
  onPosition,
  onError = () => {},
  signal,
  native = Capacitor.isNativePlatform(),
  plugin,
  browser = globalThis.navigator,
  now = Date.now,
  lifecycleTarget = globalThis.window,
  documentTarget = globalThis.document,
} = {}) {
  if (typeof onPosition !== "function")
    throw new TypeError("onPosition must be a function");
  const aborted = () => new DOMException("Отменено", "AbortError");
  if (
    signal?.aborted ||
    documentTarget?.hidden ||
    documentTarget?.documentElement?.dataset?.appActive === "false"
  )
    throw aborted();

  let stopped = false,
    ready = false,
    requestingPermission = false,
    watchId = null,
    api = null,
    cleared = false,
    lastTimestamp = -Infinity,
    startupTimer,
    rejectStartup;
  let clearing = Promise.resolve();
  const startupCanceled = new Promise((_, reject) => {
    rejectStartup = reject;
  });
  const asError = (error) => {
    if (error?.name === "AbortError") return error;
    return Object.assign(new Error(gpsErrorMessage(error)), {
      code: error?.code || "GPS_WATCH_ERROR",
    });
  };
  const clearInstalledWatch = () => {
    if (watchId == null || cleared) return clearing;
    cleared = true;
    clearing = Promise.resolve()
      .then(() =>
        native ? api.clearWatch({ id: watchId }) : api.clearWatch(watchId),
      )
      .catch((error) => {
        onError(
          Object.assign(
            new Error("Не удалось остановить обновления геопозиции."),
            { code: "GPS_CLEAR_FAILED", cause: error },
          ),
        );
      });
    return clearing;
  };
  const stop = () => {
    if (!stopped) {
      stopped = true;
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", cancel);
      documentTarget?.removeEventListener("visibilitychange", background);
      lifecycleTarget?.removeEventListener("atlas:app-state", background);
      lifecycleTarget?.removeEventListener("pagehide", background);
      // Startup can still be waiting for a native callback ID. Its eventual ID
      // is cleared in register(), and no queued position can reach the caller.
    }
    return clearInstalledWatch();
  };
  const terminate = (error) => {
    if (stopped) return;
    const wasReady = ready;
    stop();
    if (wasReady) onError(error);
    else rejectStartup(error);
  };
  const cancel = () => terminate(aborted());
  const background = (event) => {
    const permissionSheetPause =
      event?.type === "atlas:app-state" &&
      event?.detail?.isActive === false &&
      requestingPermission &&
      documentTarget?.hidden === false;
    if (
      documentTarget?.hidden ||
      event?.type === "pagehide" ||
      (event?.detail?.isActive === false && !permissionSheetPause)
    )
      cancel();
  };
  const receive = (position, error) => {
    if (stopped) return;
    if (error) {
      const normalized = asError(error);
      if (
        ["1", "OS-PLUG-GLOC-0003", "OS-PLUG-GLOC-0007"].includes(
          String(error.code),
        )
      )
        terminate(normalized);
      else onError(normalized);
      return;
    }
    let location;
    try {
      location = normalizeGpsPosition(position, now());
    } catch (error) {
      onError(asError(error));
      return;
    }
    // A provider may deliver a cached fix after a newer observation. Such an
    // update cannot pull the point back or refresh a last-known timestamp.
    if (location.timestamp <= lastTimestamp) return;
    lastTimestamp = location.timestamp;
    onPosition(location);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  documentTarget?.addEventListener("visibilitychange", background);
  lifecycleTarget?.addEventListener("atlas:app-state", background);
  lifecycleTarget?.addEventListener("pagehide", background);
  startupTimer = setTimeout(
    () =>
      terminate(
        Object.assign(
          new Error("Не удалось включить обновления GPS. Повторите попытку."),
          { code: "GPS_START_TIMEOUT" },
        ),
      ),
    GPS_TIMEOUT_MS + 1000,
  );
  const register = async () => {
    const options = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: GPS_TIMEOUT_MS,
      interval: 3000,
      minimumUpdateInterval: 2000,
      enableLocationFallback: true,
    };
    if (native) {
      api = plugin || (await import("@capacitor/geolocation")).Geolocation;
      if (stopped) throw aborted();
      const permissions = await api.checkPermissions();
      if (stopped) throw aborted();
      if (
        permissions.location !== "granted" &&
        permissions.coarseLocation !== "granted"
      ) {
        requestingPermission = true;
        let result;
        try {
          result = await api.requestPermissions({ permissions: ["location"] });
        } finally {
          requestingPermission = false;
        }
        if (stopped) throw aborted();
        if (
          result.location !== "granted" &&
          result.coarseLocation !== "granted"
        )
          throw Object.assign(new Error("Доступ к местоположению запрещён."), {
            code: 1,
          });
      }
      if (stopped) throw aborted();
      watchId = await api.watchPosition(options, receive);
    } else {
      api = browser?.geolocation;
      if (!api?.watchPosition || !api?.clearWatch)
        throw new Error(
          "В этом браузере обновления геопозиции недоступны. Укажите точку вручную.",
        );
      watchId = api.watchPosition(
        (position) => receive(position),
        (error) => receive(null, error),
        options,
      );
    }
    if (watchId == null)
      throw new Error("Устройство не включило обновления геопозиции.");
    if (stopped) {
      await clearInstalledWatch();
      throw aborted();
    }
    ready = true;
    clearTimeout(startupTimer);
    return stop;
  };
  try {
    return await Promise.race([register(), startupCanceled]);
  } catch (error) {
    await stop();
    throw asError(error);
  }
}
