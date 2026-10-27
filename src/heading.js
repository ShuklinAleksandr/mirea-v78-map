import { Capacitor, registerPlugin } from "@capacitor/core";

const Heading = registerPlugin("Heading");
export const HEADING_MAX_AGE_MS = 5_000;
const failure = (message, code, fatal = false) =>
  Object.assign(new Error(message), { code, fatal });
const aborted = () =>
  Object.assign(
    failure("Направление выключено в фоне.", "HEADING_ABORTED", true),
    { name: "AbortError" },
  );

/** Compass observations describe the screen's top edge, never GPS course. */
export function normalizeHeading(value, now = Date.now()) {
  const degrees = value?.degrees;
  const timestamp = value?.timestamp;
  const accuracy = value?.accuracyDegrees ?? value?.accuracy;
  if (
    !Number.isFinite(degrees) ||
    degrees < 0 ||
    degrees > 360 ||
    !Number.isFinite(timestamp) ||
    timestamp > now + 1000 ||
    now - timestamp > HEADING_MAX_AGE_MS ||
    ["low", "unreliable", "no-contact"].includes(value.accuracyStatus) ||
    !["magnetic", "true"].includes(value.reference)
  )
    return null;
  if (
    accuracy != null &&
    (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 60)
  )
    return null;
  return {
    degrees: degrees % 360,
    timestamp,
    accuracyDegrees: accuracy ?? null,
    accuracy: accuracy ?? null,
    reference: value.reference,
    source: "compass",
    accuracyStatus: value.accuracyStatus || null,
  };
}

/** W3C intrinsic Z-X-Y rotation, projected screen-top vector. Relative alpha
 * cannot establish north. A near-vertical top edge has no stable bearing. */
export function absoluteOrientationHeading(event, screenAngle = 0) {
  if (
    !(event.absolute === true || event.type === "deviceorientationabsolute") ||
    ![event.alpha, event.beta, event.gamma, screenAngle].every(Number.isFinite)
  )
    return null;
  const [alpha, beta, gamma, phi] = [
    event.alpha,
    event.beta,
    event.gamma,
    screenAngle,
  ].map((value) => (value * Math.PI) / 180);
  const ca = Math.cos(alpha),
    sa = Math.sin(alpha),
    cb = Math.cos(beta),
    sb = Math.sin(beta),
    cg = Math.cos(gamma),
    sg = Math.sin(gamma);
  const east =
    (ca * cg - sa * sb * sg) * Math.sin(phi) - sa * cb * Math.cos(phi);
  const north =
    (sa * cg + ca * sb * sg) * Math.sin(phi) + ca * cb * Math.cos(phi);
  if (Math.hypot(east, north) < 0.1) return null;
  return ((((Math.atan2(east, north) * 180) / Math.PI) % 360) + 360) % 360;
}

/** Explicit, foreground-only independent compass; unavailable means no arrow. */
export async function watchHeading({
  onHeading,
  onError,
  signal,
  native = Capacitor.isNativePlatform(),
  plugin = Heading,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  now = () => Date.now(),
  makeId = () => `heading-${Date.now()}-${Math.random().toString(36).slice(2)}`,
} = {}) {
  if (signal?.aborted || documentTarget?.hidden) throw aborted();
  let stopped = false,
    nativeStarted = false,
    listener = null,
    expiry = null,
    startup = null,
    lastTimestamp = -Infinity;
  const id = makeId();
  const removers = [];
  const add = (target, event, handler) => {
    target?.addEventListener?.(event, handler);
    removers.push(() => target?.removeEventListener?.(event, handler));
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(expiry);
    clearTimeout(startup);
    for (const remove of removers.splice(0)) remove();
    signal?.removeEventListener("abort", cancel);
    try {
      await listener?.remove?.();
    } catch {
      /* Native teardown remains best effort. */
    }
    if (nativeStarted)
      try {
        await plugin.stop({ id });
      } catch {
        /* Never keep the sensor for a closed UI. */
      }
  };
  const cancel = () => {
    void stop();
  };
  const report = (error) => {
    if (stopped) return;
    onError?.(error);
    if (error.fatal) void stop();
  };
  const receive = (value) => {
    if (stopped || (native && value?.id !== id)) return;
    if (value?.error) {
      report(
        failure(
          value.error.message || "Направление недоступно.",
          value.error.code || "HEADING_UNAVAILABLE",
          Boolean(value.error.fatal),
        ),
      );
      return;
    }
    const heading = normalizeHeading(value, now());
    if (!heading) {
      report(
        failure(
          "Датчик пока не даёт надёжного направления.",
          "HEADING_UNRELIABLE",
        ),
      );
      return;
    }
    if (heading.timestamp <= lastTimestamp) return;
    lastTimestamp = heading.timestamp;
    clearTimeout(startup);
    clearTimeout(expiry);
    onHeading?.(heading);
    expiry = setTimeout(
      () =>
        report(
          failure(
            "Направление устарело. Поверните телефон или повторите позже.",
            "HEADING_STALE",
          ),
        ),
      Math.max(1, heading.timestamp + HEADING_MAX_AGE_MS - now()),
    );
  };
  const background = (e) => {
    if (
      documentTarget?.hidden ||
      e?.type === "pagehide" ||
      e?.detail?.isActive === false
    )
      report(aborted());
  };
  signal?.addEventListener("abort", cancel, { once: true });
  add(documentTarget, "visibilitychange", background);
  add(windowTarget, "atlas:app-state", background);
  add(windowTarget, "pagehide", background);
  startup = setTimeout(
    () =>
      report(
        failure(
          "Компас пока не отвечает. Направление не показано.",
          "HEADING_TIMEOUT",
        ),
      ),
    8_000,
  );
  try {
    if (native) {
      listener = await plugin.addListener("heading", receive);
      if (stopped) {
        await listener?.remove?.();
        throw aborted();
      }
      nativeStarted = true;
      await plugin.start({ id });
      if (stopped) {
        await plugin.stop({ id });
        throw aborted();
      }
    } else {
      const Orientation = windowTarget?.DeviceOrientationEvent;
      if (!Orientation)
        throw failure(
          "На этом устройстве компас недоступен.",
          "HEADING_UNAVAILABLE",
          true,
        );
      // This is reached directly from the location button gesture on iOS web.
      if (typeof Orientation.requestPermission === "function") {
        const permission = await Orientation.requestPermission();
        if (permission !== "granted")
          throw failure(
            "Доступ к направлению телефона не разрешён.",
            "HEADING_PERMISSION_DENIED",
            true,
          );
      }
      if (stopped) throw aborted();
      const orientation = (event) => {
        const rotation =
          windowTarget?.screen?.orientation?.angle ??
          windowTarget?.orientation ??
          0;
        let degrees = null,
          accuracy = null,
          reference = "magnetic";
        if (Number.isFinite(event.webkitCompassHeading)) {
          degrees =
            (((event.webkitCompassHeading + rotation) % 360) + 360) % 360;
          accuracy = Number.isFinite(event.webkitCompassAccuracy)
            ? event.webkitCompassAccuracy
            : null;
        } else degrees = absoluteOrientationHeading(event, rotation);
        // Relative alpha has an arbitrary origin and cannot point north.
        if (degrees == null) return;
        receive({
          degrees,
          timestamp: now(),
          accuracyDegrees: accuracy,
          reference,
        });
      };
      add(windowTarget, "deviceorientationabsolute", orientation);
      add(windowTarget, "deviceorientation", orientation);
    }
    return stop;
  } catch (error) {
    await stop();
    if (error?.name === "AbortError") throw error;
    throw failure(
      error?.message || "Не удалось включить компас.",
      error?.code || "HEADING_UNAVAILABLE",
      true,
    );
  }
}
