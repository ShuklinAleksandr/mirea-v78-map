import { Capacitor, registerPlugin } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { $, escape } from "./dom.js";
import { icon } from "./icons.js";
import {
  WIFI_SURVEY_SSID,
  WIFI_SURVEY_LIMIT,
  WIFI_SURVEY_STORAGE_KEY,
  createWifiSurveyRecorder,
  wifiSurveyAnchor,
  readWifiSurvey,
  wifiSurveyLocationCount,
  exportWifiSurvey,
  exportWifiSurveyBackup,
} from "../data/wifi-survey.js";

const WifiSurvey = registerPlugin("WifiSurvey");
const nativeError = (error) => {
  const messages = {
    BUSY: "Сканирование уже идёт. Дождитесь его завершения.",
    WIFI_DISABLED:
      "Включите Wi-Fi в настройках Android и откройте сбор замеров снова.",
    LOCATION_DISABLED:
      "Включите геолокацию в настройках Android: система требует её для сканирования Wi-Fi.",
    PRECISE_LOCATION_REQUIRED:
      "Разрешите приложению точную геопозицию в настройках Android и повторите замер.",
    SCAN_THROTTLED:
      "Android временно ограничил сканирование. Дождитесь окончания паузы и попробуйте снова.",
    SCAN_FAILED:
      "Android не выполнил новый скан. Старые результаты не записаны.",
    SCAN_TIMEOUT:
      "Новый скан не получен вовремя. Повторите замер; старые данные не записаны.",
    SCAN_EMPTY: "Android не вернул свежих точек Wi-Fi. Замер не записан.",
    CANCELLED: "Замер отменён и не записан.",
  };
  return (
    messages[error?.code] ||
    error?.message ||
    "Не удалось записать замер. Повторите попытку."
  );
};

const anchorLabel = (anchor) =>
  [
    anchor.label,
    anchor.building ? `корпус ${anchor.building}` : "корпус не указан",
    anchor.physicalLevel === -1 ? "цоколь" : `${anchor.physicalLevel} этаж`,
  ].join(" · ");
const dateLabel = (value) => new Date(value).toLocaleString("ru-RU");

/** Android-only collection tool. Status reads do not start a Wi-Fi scan.
 * Hardware results and system file sharing remain native boundaries. */
export function bindWifiSurvey({ state, userPosition, toast }) {
  const opener = $("#wifi-survey-open");
  const dialog = $("#wifi-survey-dialog");
  const supported =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  opener.hidden = !supported;
  if (!supported) return { refresh() {}, open() {} };

  dialog.innerHTML = `
    <div class="dialog-heading"><h2>Замеры Wi-Fi</h2><button type="button" id="wifi-survey-close" class="icon-button" aria-label="Закрыть замеры Wi-Fi">${icon("close")}</button></div>
    <div class="settings-content wifi-survey-content">
      <p class="micro-note">Передвиньте карту под меткой, подтвердите конкретное место и запишите сигнал Wi-Fi. Замеры помогут проверить возможность определения положения внутри вуза. Сейчас приложение по ним положение не определяет.</p>
      <section class="wifi-survey-point"><h3>Точка замера</h3><p id="wifi-survey-anchor"></p><p class="micro-note">Эта точка закреплена отдельно от текущей геопозиции и не движется вместе с GPS. Метка сохраняет точные координаты выбранного места на плане, а не центр кабинета. После перехода укажите новое место перед замером.</p><button type="button" id="wifi-survey-pick">Указать место замера</button></section>
      <label class="toggle-row" for="wifi-survey-other"><span>Включать другие сети</span><input id="wifi-survey-other" type="checkbox"/></label>
      <p class="micro-note">По умолчанию сохраняется только ${escape(WIFI_SURVEY_SSID)}. С этой галочкой в файл попадут также названия и адреса точек доступа других видимых сетей. Все замеры хранятся на этом телефоне; экспорт запускаете вы.</p>
      <button type="button" id="wifi-survey-scan" class="primary-button">Записать замер</button>
      <p id="wifi-survey-system" class="micro-note" role="status"></p>
      <dl class="wifi-survey-summary"><div><dt>Замеров</dt><dd id="wifi-survey-count">0</dd></div><div><dt>Мест замера</dt><dd id="wifi-survey-locations">0</dd></div></dl>
      <p class="wifi-survey-last" id="wifi-survey-last">Замеров пока нет.</p>
      <button type="button" id="wifi-survey-export">Экспорт JSON</button>
      <p class="wifi-survey-feedback" id="wifi-survey-feedback" role="status" aria-live="polite"></p>
    </div>`;

  let status = null,
    statusRevision = 0,
    statusPending = false,
    exportRevision = 0,
    exporting = false,
    retryAt = 0,
    timer = null,
    appActive = document.documentElement.dataset.appActive !== "false";
  // Accessing the localStorage property itself can fail in a restricted WebView.
  // Delay that access until the data layer's guarded read/write operations.
  const storage = {
    getItem(key) {
      return globalThis.localStorage.getItem(key);
    },
    setItem(key, value) {
      globalThis.localStorage.setItem(key, value);
    },
  };
  const recorder = createWifiSurveyRecorder({
    storage,
    plugin: WifiSurvey,
    getPosition: surveyPosition,
    getFloors: () => state.floorData || [],
    isActive: () => dialog.open && !document.hidden && appActive,
    onChange: () => refresh(),
  });

  function surveyPosition() {
    // Keep the collection reference independent of live GPS updates. The
    // manual user position remains a fallback for older app state only.
    return (
      state.surveyLocation ||
      (state.userLocation?.source === "manual" ? state.userLocation : null)
    );
  }
  function currentAnchor() {
    try {
      return wifiSurveyAnchor(surveyPosition(), state.floorData || []);
    } catch {
      return null;
    }
  }
  function snapshot() {
    try {
      return { session: readWifiSurvey(storage), error: null, hasRaw: false };
    } catch (error) {
      let hasRaw = false;
      try {
        hasRaw = storage.getItem(WIFI_SURVEY_STORAGE_KEY) !== null;
      } catch {
        /* Keep the original storage error. */
      }
      return { session: null, error, hasRaw };
    }
  }
  function feedback(message) {
    $("#wifi-survey-feedback").textContent = message;
  }
  function refresh() {
    const anchor = currentAnchor();
    const saved = snapshot();
    const session = saved.session;
    const sample = session?.samples.at(-1);
    $("#wifi-survey-anchor").textContent = anchor
      ? anchorLabel(anchor)
      : "Нужна ручная точка В78 с известным этажом. Выберите её в нужном корпусе; GPS для привязки замера не подходит.";
    $("#wifi-survey-count").textContent = saved.error
      ? "—"
      : `${session?.samples.length || 0} / ${WIFI_SURVEY_LIMIT}`;
    $("#wifi-survey-locations").textContent = saved.error
      ? "—"
      : String(wifiSurveyLocationCount(session));
    $("#wifi-survey-last").textContent = saved.error
      ? saved.error.message
      : sample
        ? `Последний замер: ${dateLabel(sample.timestamp)}. ${anchorLabel(sample.anchor)}. Сохранено точек доступа: ${sample.networks.length} из ${sample.observedNetworkCount} видимых.${sample.ssidFilter && !sample.networks.length ? ` Сеть ${WIFI_SURVEY_SSID} не обнаружена.` : ""}`
        : "Замеров пока нет.";
    const waitSeconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    const scan = $("#wifi-survey-scan");
    scan.disabled =
      recorder.pending ||
      exporting ||
      statusPending ||
      !status?.supported ||
      !status.wifiEnabled ||
      !status.locationEnabled ||
      !anchor ||
      Boolean(saved.error) ||
      session?.samples.length >= WIFI_SURVEY_LIMIT ||
      waitSeconds > 0;
    scan.textContent = recorder.pending
      ? "Получаем свежий замер…"
      : waitSeconds
        ? `Повторить через ${waitSeconds} с`
        : "Записать замер";
    $("#wifi-survey-other").disabled = recorder.pending || exporting;
    $("#wifi-survey-pick").disabled = exporting;
    $("#wifi-survey-export").disabled =
      recorder.pending ||
      exporting ||
      (!session?.samples.length && !saved.hasRaw);
    $("#wifi-survey-export").hidden = !session?.samples.length && !saved.hasRaw;
    $("#wifi-survey-export").textContent = exporting
      ? "Готовим файл…"
      : saved.error && saved.hasRaw
        ? "Экспорт резервной копии JSON"
        : "Экспорт JSON";
    $("#wifi-survey-system").textContent = statusPending
      ? "Проверяем настройки Android…"
      : !status?.supported
        ? "Сбор замеров недоступен. Нужна актуальная Android-сборка с модулем Wi-Fi."
        : !status.wifiEnabled
          ? "Wi-Fi выключен. Включите его в настройках Android."
          : !status.locationEnabled
            ? "Для сканирования включите геолокацию в настройках Android."
            : waitSeconds
              ? "Пауза Android между активными сканированиями. Автоматического сканирования нет."
              : !status.preciseLocationGranted
                ? "При записи Android попросит разрешение на точную геопозицию. Замер привязывается к вашей ручной точке, а не к GPS."
                : "Сканирование запускается только кнопкой «Записать замер».";
    clearTimeout(timer);
    if (dialog.open && waitSeconds) timer = setTimeout(refresh, 1000);
  }
  async function refreshStatus() {
    const token = ++statusRevision;
    statusPending = true;
    refresh();
    try {
      const result = await WifiSurvey.getStatus();
      if (token !== statusRevision || !dialog.open) return;
      status = result;
      retryAt = Date.now() + Math.max(0, Number(result.nextScanInMs) || 0);
    } catch (error) {
      if (token !== statusRevision || !dialog.open) return;
      status = null;
      feedback(nativeError(error));
    } finally {
      if (token === statusRevision) {
        statusPending = false;
        refresh();
      }
    }
  }
  function open() {
    if ($("#settings-dialog")?.open) $("#settings-dialog").close();
    if (!state.surveyLocation && state.userLocation?.source === "manual") {
      try {
        // Adopt an existing valid manual pin only when the collector opens.
        // Subsequent GPS fixes must not change this measurement reference.
        wifiSurveyAnchor(state.userLocation, state.floorData || []);
        userPosition.setSurveyLocation?.(state.userLocation);
      } catch {
        /* An unknown physical floor still requires an explicit map pick. */
      }
    }
    $("#wifi-survey-other").checked = false;
    feedback("");
    if (!dialog.open) dialog.showModal();
    refreshStatus();
  }
  function cancelPending() {
    statusRevision++;
    exportRevision++;
    statusPending = exporting = false;
    clearTimeout(timer);
    recorder.cancel();
  }
  opener.onclick = open;
  $("#wifi-survey-close").onclick = () => dialog.close();
  dialog.addEventListener("close", cancelPending);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  $("#wifi-survey-pick").onclick = () => {
    dialog.close();
    if (!userPosition.beginPicking({ purpose: "survey", onPicked: open }))
      toast("Откройте нужный корпус и этаж, затем выберите точку замера.");
  };
  $("#wifi-survey-scan").onclick = async () => {
    if (recorder.pending) return;
    feedback("Не двигайтесь: получаем новый скан Wi-Fi.");
    try {
      const { sample } = await recorder.capture({
        includeOtherSsids: $("#wifi-survey-other").checked,
      });
      if (!dialog.open) return;
      feedback(
        `Замер сохранён. Точек доступа в записи: ${sample.networks.length}.${sample.ssidFilter && !sample.networks.length ? ` ${WIFI_SURVEY_SSID} не обнаружена; это отсутствие сигнала тоже записано.` : ""}`,
      );
    } catch (error) {
      if (dialog.open && !["cancelled", "CANCELLED"].includes(error?.code))
        feedback(nativeError(error));
    } finally {
      if (dialog.open && appActive && !document.hidden) refreshStatus();
    }
  };
  $("#wifi-survey-export").onclick = async () => {
    const token = ++exportRevision;
    exporting = true;
    refresh();
    try {
      const saved = snapshot();
      const json = saved.error
        ? exportWifiSurveyBackup(storage)
        : exportWifiSurvey(storage);
      const file = await WifiSurvey.exportSurvey({ json });
      if (
        token !== exportRevision ||
        !dialog.open ||
        document.hidden ||
        !appActive
      )
        return;
      if (
        typeof file.uri !== "string" ||
        !/^(file|content):\/\//u.test(file.uri)
      )
        throw new Error("Android не вернул файл экспорта.");
      await Share.share({
        title: "Wi-Fi карта В78",
        files: [file.uri],
        dialogTitle: "Экспорт замеров Wi-Fi",
      });
      if (token === exportRevision && dialog.open)
        feedback("Файл подготовлен. Исходные замеры остались на телефоне.");
    } catch (error) {
      if (
        token === exportRevision &&
        dialog.open &&
        error?.message !== "Share canceled"
      )
        feedback(
          error?.message ||
            "Не удалось экспортировать замеры. Они остались на телефоне.",
        );
    } finally {
      if (token === exportRevision) {
        exporting = false;
        refresh();
      }
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelPending();
    else if (dialog.open) refreshStatus();
  });
  window.addEventListener("pagehide", cancelPending);
  window.addEventListener("atlas:app-state", (event) => {
    appActive = event.detail?.isActive !== false;
    // A permission prompt can pause the Activity without hiding the document.
    // Native onStop cancels a real background scan; the commit guard also
    // requires an active visible dialog before writing any result.
    if (!appActive && document.hidden) cancelPending();
    else if (appActive && dialog.open && !recorder.pending) refreshStatus();
  });
  refresh();
  return { open, refresh };
}
