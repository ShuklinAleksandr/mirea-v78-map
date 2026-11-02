import { Capacitor, registerPlugin } from "@capacitor/core";
import { Share } from "@capacitor/share";

const GpsCalibrationExport = registerPlugin("GpsCalibrationExport");
export const GPS_CALIBRATION_EXPORT_MAX_BYTES = 4 * 1024 * 1024;

function validateJson(json) {
  if (
    typeof json !== "string" ||
    !json.length ||
    json.length > GPS_CALIBRATION_EXPORT_MAX_BYTES ||
    new TextEncoder().encode(json).byteLength > GPS_CALIBRATION_EXPORT_MAX_BYTES
  )
    throw new Error(
      "Файл GPS-замеров пустой или слишком большой (не больше 4 МБ).",
    );
  let record;
  try {
    record = JSON.parse(json);
  } catch {
    throw new Error("Файл GPS-замеров содержит некорректный JSON.");
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.campusId !== "v-78"
  )
    throw new Error("Это не файл GPS-замеров Вернадского, 78.");
}

/** Export an actual local JSON file; never send records to a server. Optional
 * adapters allow boundary tests without replacing native/file implementations. */
export async function exportGpsCalibrationJson(
  json,
  {
    native = Capacitor.isNativePlatform(),
    plugin = GpsCalibrationExport,
    share = (options) => Share.share(options),
    document = globalThis.document,
    url = globalThis.URL,
    Blob: BlobClass = globalThis.Blob,
    schedule = globalThis.setTimeout,
    now = Date.now,
    desktop = globalThis.window?.mireaDesktop,
  } = {},
) {
  validateJson(json);
  if (desktop?.exportGpsJson) return desktop.exportGpsJson(json);
  if (native) {
    const file = await plugin.exportSurvey({ json });
    if (
      typeof file?.uri !== "string" ||
      !/^(?:file|content):\/\//u.test(file.uri) ||
      typeof file.filename !== "string" ||
      !/^MIREA-V78-GPS-[A-Za-z0-9-]+\.json$/u.test(file.filename)
    )
      throw new Error("Приложение не вернуло локальный файл GPS-замеров.");
    await share({
      title: "GPS-замеры В78",
      files: [file.uri],
      dialogTitle: "Экспорт GPS-замеров",
    });
    return { method: "share", filename: file.filename, uri: file.uri };
  }
  if (
    !document?.body ||
    typeof document.createElement !== "function" ||
    typeof url?.createObjectURL !== "function" ||
    typeof url?.revokeObjectURL !== "function" ||
    typeof BlobClass !== "function" ||
    typeof schedule !== "function"
  )
    throw new Error(
      "Этот браузер не поддерживает скачивание файла GPS-замеров.",
    );
  const filename = `MIREA-V78-GPS-${new Date(now()).toISOString().replace(/[:.]/gu, "-")}.json`;
  const blob = new BlobClass([json], {
    type: "application/json;charset=utf-8",
  });
  const uri = url.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = uri;
  link.download = filename;
  link.hidden = true;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // The download needs time to read the object URL after the click event.
    schedule(() => url.revokeObjectURL(uri), 1_000);
  }
  return { method: "download", filename };
}
