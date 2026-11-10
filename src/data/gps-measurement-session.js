import {
  createGpsMeasurement,
  appendGpsMeasurementSample,
  finishGpsMeasurement,
  GPS_MEASUREMENT_DURATION_MS,
} from "./gps-measurements.js";

/** One explicitly started foreground stationary measurement. This observer has
 * no access to the navigation marker, calibration offset or map registration. */
export function startGpsMeasurementSession({
  anchor,
  metadata,
  startWatching,
  onRecord,
  onState = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const controller = new AbortController();
  let ended = false,
    record = null,
    timer = null,
    release = null;
  const publish = () => onRecord(record);
  function stop(reason = "manual-stop") {
    if (ended) return record;
    ended = true;
    clearTimer(timer);
    controller.abort();
    if (release) Promise.resolve(release()).catch(() => {});
    if (record) {
      record = finishGpsMeasurement(record, { now: now(), reason });
      try {
        publish();
      } catch (error) {
        onState("error", error, record);
        return record;
      }
    }
    onState("finished", null, record);
    return record;
  }
  onState("starting");
  const ready = (async () => {
    try {
      const stopWatch = await startWatching({
        signal: controller.signal,
        onPosition(fix) {
          if (ended || !record) return;
          const next = appendGpsMeasurementSample(record, fix, { now: now() });
          if (next === record) return;
          record = next;
          try {
            publish();
          } catch (error) {
            stop("storage-error");
            onState("error", error, record);
          }
        },
        onError(error) {
          if (ended) return;
          if (error?.name === "AbortError") stop("background");
          else if (
            ["1", "OS-PLUG-GLOC-0003", "OS-PLUG-GLOC-0007"].includes(
              String(error?.code || ""),
            )
          ) {
            stop("permission-error");
            onState("error", error, record);
          } else onState("signal-warning", error, record);
        },
      });
      if (ended) {
        await stopWatch();
        return null;
      }
      release = stopWatch;
      record = createGpsMeasurement(anchor, { ...metadata, now: now() });
      publish();
      onState("recording", null, record);
      timer = setTimer(() => stop("timer"), GPS_MEASUREMENT_DURATION_MS);
      return record;
    } catch (error) {
      if (!ended) {
        stop(error?.name === "AbortError" ? "background" : "start-error");
        onState("error", error, record);
      }
      return null;
    }
  })();
  return {
    stop,
    ready,
    get record() {
      return record;
    },
  };
}
