import { APP_VERSION } from "../version.js";
import { watchGpsLocation } from "../location.js";
import {
  readGpsMeasurements,
  saveGpsMeasurement,
  finishGpsMeasurement,
  prepareGpsMeasurementExport,
} from "../data/gps-measurements.js";
import { startGpsMeasurementSession } from "../data/gps-measurement-session.js";
import { readGpsCalibrationSurvey } from "../data/gps-calibration-survey.js";
import { exportGpsCalibrationJson } from "../data/gps-calibration-export.js";

export function gpsSurveyAvailable({ native, platform }) {
  return native === true && platform === "android";
}

/** Mounted only in the Android app; never starts GPS until the record button. */
export function bindGpsSurvey({
  native,
  platform,
  storage,
  beginPicking,
  closeLocation,
  toast,
  startWatching = watchGpsLocation,
}) {
  if (!gpsSurveyAvailable({ native, platform })) return null;
  const settings = document.querySelector("#location-options");
  const entry = document.createElement("button");
  entry.id = "gps-survey-open";
  entry.type = "button";
  entry.className = "secondary-button";
  entry.textContent = "Замеры GPS";
  settings.insertAdjacentElement("afterend", entry);
  const dialog = document.createElement("dialog");
  dialog.id = "gps-survey-dialog";
  dialog.innerHTML = `<div class="dialog-heading"><h2>Замеры GPS</h2><button type="button" class="icon-button" data-action="close" aria-label="Закрыть замеры">×</button></div>
    <div class="location-content gps-survey-content">
      <p>Встаньте у понятного ориентира. Отметьте точное место на плане, затем стойте здесь 30 секунд. Замеры сохраняются только на телефоне и не меняют карту или вашу точку.</p>
      <button type="button" data-action="pick" class="secondary-button">Выбрать место на карте</button>
      <p data-field="anchor">Место ещё не выбрано.</p>
      <label>Ориентир <input data-field="landmark" type="text" maxlength="160" placeholder="Например, угол коридора у буфета" autocomplete="off" /></label>
      <label>Этаж по указателю в вузе <select data-field="floor"><option value="">Не знаю</option><option value="-1">Цоколь</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} этаж</option>`).join("")}</select></label>
      <button type="button" data-action="start" class="primary-button" disabled>Начать замер · 30 секунд</button>
      <button type="button" data-action="stop" class="secondary-button" hidden>Закончить раньше и сохранить</button>
      <p data-field="status" role="status" aria-live="polite"></p>
      <p data-field="count" class="micro-note"></p>
      <button type="button" data-action="export" class="secondary-button">Выгрузить все замеры одним файлом</button>
      <p class="micro-note">В файл входят выбранные места, исходные GPS-координаты, время, заявленная телефоном погрешность и сведения о версии приложения. Погрешность GPS не равна точности карты. При сворачивании запись остановится и сохранится как неполная.</p>
      <ol data-field="records" class="gps-survey-records"></ol>
    </div>`;
  document.body.appendChild(dialog);
  const field = (name) => dialog.querySelector(`[data-field="${name}"]`);
  const action = (name) => dialog.querySelector(`[data-action="${name}"]`);
  let records = [],
    anchor = null,
    session = null,
    active = false,
    pendingRecord = null,
    clock = null,
    message = "",
    exporting = false,
    storageError = false,
    cachedLegacy = null,
    signalWarning = "";
  function read() {
    try {
      records = pendingRecord
        ? saveGpsMeasurement(storage, pendingRecord)
        : readGpsMeasurements(storage);
      pendingRecord = null;
      for (const record of records.filter(
        (item) => item.status === "recording",
      ))
        records = saveGpsMeasurement(
          storage,
          finishGpsMeasurement(record, {
            now: record.updatedAt,
            reason: "app-restart",
          }),
        );
      storageError = false;
      try {
        cachedLegacy = readGpsCalibrationSurvey(storage);
      } catch {}
    } catch (error) {
      storageError = true;
      message = error.message;
    }
  }
  function refresh() {
    action("pick").disabled = active || exporting;
    field("landmark").disabled = active;
    field("floor").disabled = active;
    action("start").hidden = active;
    action("start").disabled =
      !anchor || !field("landmark").value.trim() || storageError || exporting;
    action("stop").hidden = !active;
    action("export").disabled = active || exporting;
    action("export").textContent = exporting
      ? "Готовим файл…"
      : "Выгрузить все замеры одним файлом";
    const current = session?.record;
    field("status").textContent =
      active && current
        ? `Стойте на месте · осталось ${Math.max(0, Math.ceil((current.startedAt + 30_000 - Date.now()) / 1000))} с · ${current.samples.length} отсчётов${current.samples.length ? ` · последнее GPS ±${Math.round(current.samples.at(-1).accuracyMeters)} м` : " · ждём GPS"}${signalWarning ? ` · ${signalWarning}` : ""}`
        : message;
    field("count").textContent =
      `Сохранено мест: ${records.length}. Повторный замер того же ориентира сохраняется отдельно.`;
    field("records").replaceChildren();
    for (const item of records.slice().reverse()) {
      const row = document.createElement("li");
      const state =
        item.status === "recording"
          ? "идёт запись"
          : item.status === "complete"
            ? "30 секунд"
            : "неполный";
      row.textContent = `${item.anchor.landmark} · ${new Date(item.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${state} · ${item.samples.length} отсчётов${item.status !== "recording" && !item.summary.usableForReview ? " · стоит повторить" : ""}`;
      field("records").appendChild(row);
    }
  }
  function open() {
    if (!active) read();
    closeLocation?.();
    const settingsDialog = document.querySelector("#settings-dialog");
    if (settingsDialog?.open) settingsDialog.close();
    refresh();
    if (!dialog.open) dialog.showModal();
  }
  function finish(reason) {
    session?.stop(reason);
    active = false;
    clearInterval(clock);
    refresh();
  }
  entry.onclick = open;
  action("close").onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    if (active) finish("dialog-closed");
  });
  action("pick").onclick = () => {
    dialog.close();
    const started = beginPicking({
      purpose: "gps-survey",
      onPicked(location) {
        anchor = location;
        field("anchor").textContent =
          `${location.label}${location.building ? ` · корпус ${location.building}` : ""} · план ${location.floorId.replace("v-78-floor", "")}. Этаж подтвердите ниже.`;
        field("floor").value = "";
        message =
          "Место выбрано. Укажите ориентир и этаж, затем начните запись.";
        open();
      },
      onCanceled: open,
    });
    if (!started) open();
  };
  field("landmark").addEventListener("input", refresh);
  action("start").onclick = () => {
    if (active || !anchor || !field("landmark").value.trim()) return;
    active = true;
    message = "Включаем GPS…";
    pendingRecord = null;
    signalWarning = "";
    const physicalLevel =
      field("floor").value === "" ? null : Number(field("floor").value);
    session = startGpsMeasurementSession({
      anchor: {
        ...anchor,
        landmark: field("landmark").value.trim(),
        physicalLevel,
      },
      metadata: { appVersion: APP_VERSION, userAgent: navigator.userAgent },
      startWatching,
      onRecord(record) {
        pendingRecord = record;
        signalWarning = "";
        records = saveGpsMeasurement(storage, record);
        pendingRecord = null;
        refresh();
      },
      onState(status, error, record) {
        if (status === "finished" || status === "error") {
          active = false;
          clearInterval(clock);
          message =
            error?.message ||
            (record?.samples.length
              ? `Замер сохранён: ${record.samples.length} отсчётов. ${record.summary.usableForReview ? "Можно перейти к следующему месту." : "Замер неполный или мало данных — при возможности повторите."}`
              : "Свежих GPS-отсчётов нет. Попробуйте повторить замер.");
          if (record?.summary.medianReportedAccuracyMeters > 15)
            message +=
              " GPS был неточным; запись сохранена для диагностики, точность карты не подтверждена.";
          if (status === "error" && pendingRecord) {
            storageError = true;
            message +=
              " Данные в памяти доступны через выгрузку файла. Новый замер временно недоступен, чтобы не потерять эту запись.";
          }
        } else if (status === "signal-warning")
          signalWarning = error?.message || "Ждём свежий GPS.";
        refresh();
      },
    });
    clock = setInterval(refresh, 1000);
    refresh();
  };
  action("stop").onclick = () => finish("manual-stop");
  action("export").onclick = async () => {
    if (active || exporting) return;
    exporting = true;
    refresh();
    try {
      const { json, warnings } = prepareGpsMeasurementExport(storage, {
        cachedRecords: records,
        cachedLegacy,
        pendingRecord,
      });
      await exportGpsCalibrationJson(json);
      message = warnings.length
        ? "Выгружены доступные записи из памяти. Часть старых данных не удалось прочитать — это отмечено в файле. Записи не удалены."
        : "Один файл со всеми замерами подготовлен. Записи остались на телефоне.";
      toast(message);
    } catch (error) {
      if (error?.message !== "Share canceled")
        message =
          error.message || "Не удалось выгрузить файл. Записи не удалены.";
    } finally {
      exporting = false;
      refresh();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && active) finish("background");
  });
  window.addEventListener("pagehide", () => {
    if (active) finish("background");
  });
  read();
  refresh();
  return { open, stop: finish };
}
