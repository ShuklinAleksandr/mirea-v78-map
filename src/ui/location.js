import { $ } from "./dom.js";
import { watchGpsLocation } from "../location.js";
import { watchHeading } from "../heading.js";
import {
  manualPlaceLocation,
  manualMapLocation,
  describeUserLocation,
  isCurrentUserLocation,
} from "../data/user-location.js";
import {
  normalizeTrackingFloor,
  createLocationCalibration,
  applyLocationTracking,
} from "../data/location-tracking.js";

/** Foreground location, optional phone heading and explicit point confirmation. */
export function bindLocation({
  state,
  scene,
  experience,
  routes,
  closeRoom,
  chooseFloor,
  openForPicking,
  toast,
  onChange,
  allowTrackingPoint,
  startWatching = watchGpsLocation,
  startHeading = watchHeading,
}) {
  const dialog = $("#location-dialog");
  const tracking = (state.locationTracking = {
    enabled: false,
    status: "off",
    reason: "",
    following: true,
  });
  let floorSelection = null,
    calibration = null,
    rawFix = null,
    holdManual = false,
    controller = null,
    stopWatch = null,
    generation = 0,
    expiryTimer = null,
    headingController = null,
    stopHeading = null,
    headingGeneration = 0,
    pickCompletion = null,
    pickPurpose = "manual",
    closeOnFix = false;
  state.headingStatus = "off";

  function refresh() {
    $("#location-current").textContent = describeUserLocation(
      state.userLocation,
      state.floorData,
    );
    $("#location-feedback").textContent = tracking.reason;
    $("#location-gps").textContent = tracking.enabled
      ? "Остановить геопозицию"
      : "Включить геопозицию";
    $("#location-tracking-state").textContent =
      {
        off: "Геопозиция выключена",
        acquiring: "Определяем положение…",
        live: "Положение обновляется",
        paused: "Обновление приостановлено в фоне",
        "signal-lost": "Нет свежей геопозиции",
        "needs-refinement": "Нужно уточнить точку",
        error: "Геопозиция недоступна",
        stopped: "Обновление остановлено",
      }[tracking.status] || "Нет свежей геопозиции";
    $("#location-clear").hidden = !state.userLocation && !tracking.enabled;
    $("#location-reset-correction").hidden = !calibration && !holdManual;
    $("#location-follow-row").hidden = !tracking.enabled;
    $("#location-follow").checked = tracking.following;
    $("#location-heading-state").textContent =
      state.headingStatus === "live"
        ? "Стрелка показывает направление телефона."
        : state.headingStatus === "unavailable"
          ? "Направление телефона недоступно на этом устройстве."
          : "";
    $("#locate-open").classList.toggle(
      "active",
      tracking.enabled && tracking.following,
    );
    $("#locate-open").dataset.tracking = tracking.status;
    $("#locate-open").setAttribute(
      "aria-label",
      tracking.enabled
        ? "К моему местоположению — включить следование"
        : "Показать моё местоположение",
    );
    $("#locate-open").setAttribute(
      "aria-pressed",
      String(tracking.enabled && tracking.following),
    );
  }
  function publish(location, status = tracking.status) {
    state.userLocation = location
      ? {
          ...location,
          point: location.point?.slice(),
          ...(tracking.enabled || location.trackingStatus
            ? { trackingStatus: status }
            : {}),
        }
      : null;
    scene.setUserLocation(state.userLocation);
    clearTimeout(expiryTimer);
    if (state.userLocation?.source === "gps") {
      const until = Math.min(
        state.userLocation.expiresAt ?? state.userLocation.timestamp + 60000,
        state.userLocation.correction?.expiresAt ?? Infinity,
      );
      if (until > Date.now())
        expiryTimer = setTimeout(
          () => {
            if (!state.userLocation) return;
            if (tracking.enabled) {
              tracking.status =
                calibration && Date.now() >= calibration.expiresAt
                  ? "needs-refinement"
                  : "signal-lost";
              tracking.reason =
                tracking.status === "needs-refinement"
                  ? "Поправка устарела. Уточните точку на карте."
                  : "Показана последняя позиция. Ждём свежую геопозицию.";
              if (tracking.status === "needs-refinement")
                calibration = { ...calibration, valid: false };
              state.userLocation = {
                ...state.userLocation,
                trackingStatus: tracking.status,
              };
              scene.setUserLocation(state.userLocation);
            }
            refresh();
            onChange?.();
          },
          until - Date.now() + 20,
        );
    }
    refresh();
    onChange?.();
  }
  function releaseHeading() {
    headingGeneration++;
    headingController?.abort();
    headingController = null;
    const stop = stopHeading;
    stopHeading = null;
    if (stop) Promise.resolve(stop()).catch(() => {});
    scene.setUserHeading?.(null);
    state.headingStatus = "off";
  }
  async function beginHeading() {
    if (!tracking.enabled || headingController || document.hidden) return;
    const token = ++headingGeneration;
    headingController = new AbortController();
    try {
      const stop = await startHeading({
        signal: headingController.signal,
        onHeading: (heading) => {
          if (token !== headingGeneration || !tracking.enabled) return;
          state.headingStatus = "live";
          scene.setUserHeading?.(heading);
          refresh();
        },
        onError: (error) => {
          if (token !== headingGeneration) return;
          if (error?.fatal) releaseHeading();
          scene.setUserHeading?.(null);
          state.headingStatus = "unavailable";
          refresh();
        },
      });
      if (token !== headingGeneration || !tracking.enabled) await stop();
      else stopHeading = stop;
    } catch (error) {
      if (token !== headingGeneration) return;
      headingController = null;
      scene.setUserHeading?.(null);
      state.headingStatus =
        error?.name === "AbortError" ? "off" : "unavailable";
      refresh();
    }
  }
  function releaseWatch() {
    generation++;
    controller?.abort();
    controller = null;
    const stop = stopWatch;
    stopWatch = null;
    if (stop) Promise.resolve(stop()).catch(() => {});
  }
  function stopTracking() {
    tracking.enabled = false;
    releaseWatch();
    releaseHeading();
    tracking.status = "stopped";
    tracking.reason =
      "Последняя точка сохранена. Новые координаты не запрашиваются.";
    if (state.userLocation) publish(state.userLocation, "stopped");
    else refresh();
  }
  function applyFix(fix, { center = true, reapply = false } = {}) {
    rawFix = fix;
    if (holdManual) {
      tracking.status = "needs-refinement";
      tracking.reason =
        "Ручная точка сохранена. Для движения от неё нужен свежий сигнал и новое уточнение.";
      refresh();
      return;
    }
    const result = applyLocationTracking(fix, {
      floor: floorSelection,
      calibration,
      previous: state.userLocation,
      reapply,
      ...(calibration && allowTrackingPoint
        ? { allowPoint: allowTrackingPoint }
        : {}),
    });
    calibration = result.calibration;
    tracking.status = result.status === "tracking" ? "live" : result.status;
    tracking.reason =
      tracking.status === "live"
        ? ""
        : tracking.status === "needs-refinement"
          ? "Уточните точку заново или сбросьте поправку."
          : fix?.status === "outside"
            ? fix.message
            : "Нет надёжного обновления. Показана последняя точка.";
    publish(result.location, tracking.status);
    if (
      tracking.status === "live" &&
      center &&
      tracking.following &&
      !scene.locationPicking
    ) {
      if (closeOnFix) {
        closeOnFix = false;
        if (dialog.open) dialog.close();
        experience.minimize();
        scene.focusUserLocation();
      } else if (!dialog.open) scene.followUserLocation?.();
    }
  }
  async function beginWatch() {
    if (!tracking.enabled || controller || document.hidden) return;
    const token = ++generation;
    controller = new AbortController();
    tracking.status = "acquiring";
    tracking.reason = "";
    refresh();
    const fail = (error) => {
      if (token !== generation || !tracking.enabled) return;
      if (error?.name === "AbortError") {
        releaseWatch();
        releaseHeading();
        tracking.status = "paused";
        tracking.reason = "Обновление продолжится при возврате в приложение.";
      } else {
        if (
          ["1", "OS-PLUG-GLOC-0003", "OS-PLUG-GLOC-0007"].includes(
            String(error?.code || ""),
          )
        ) {
          tracking.enabled = false;
          releaseWatch();
          releaseHeading();
        }
        tracking.status = "signal-lost";
        tracking.reason = error?.message || "Уточните место на карте.";
        if (!state.userLocation && !dialog.open) dialog.showModal();
      }
      if (state.userLocation) publish(state.userLocation, tracking.status);
      else refresh();
    };
    try {
      const stop = await startWatching({
        signal: controller.signal,
        onPosition: (fix) => {
          if (token === generation && tracking.enabled) applyFix(fix);
        },
        onError: fail,
      });
      if (token !== generation || !tracking.enabled) await stop();
      else stopWatch = stop;
    } catch (error) {
      if (token !== generation) return;
      if (error?.name === "AbortError") fail(error);
      else {
        tracking.enabled = false;
        releaseWatch();
        releaseHeading();
        tracking.status = "error";
        tracking.reason = error.message;
        refresh();
        if (!dialog.open) dialog.showModal();
      }
    }
  }
  function startTracking() {
    if (tracking.enabled) return;
    calibration = null;
    holdManual = false;
    tracking.enabled = true;
    tracking.following = true;
    closeOnFix = true;
    // Called by the explicit button so browser orientation permission keeps its gesture.
    beginHeading();
    beginWatch();
  }
  function stopPicking() {
    pickCompletion = null;
    scene.setLocationPicking(false);
    $("#location-pick-banner").hidden = true;
    $("#location-crosshair").hidden = true;
    document.body.dataset.locationPicking = "false";
  }
  function open() {
    stopPicking();
    refresh();
    if (!dialog.open) dialog.showModal();
  }
  function locate() {
    stopPicking();
    closeRoom();
    if (dialog.open) dialog.close();
    experience.minimize();
    tracking.following = true;
    if (!tracking.enabled) startTracking();
    else beginHeading();
    if (state.userLocation?.point) scene.focusUserLocation();
    refresh();
  }
  function setSurveyLocation(location) {
    if (
      location?.source !== "manual" ||
      !location.floorId ||
      !location.campusId ||
      !Array.isArray(location.point) ||
      !location.point.slice(0, 2).every(Number.isFinite)
    )
      return false;
    state.surveyLocation = { ...location, point: location.point.slice() };
    scene.setSurveyLocation(state.surveyLocation);
    onChange?.();
    return true;
  }
  function assignManual(location, purpose) {
    if (purpose === "survey") return setSurveyLocation(location);
    floorSelection = normalizeTrackingFloor(location, state.floorData);
    if (tracking.enabled) {
      try {
        calibration = createLocationCalibration(location, rawFix, {
          floor: floorSelection,
        });
        holdManual = false;
        state.userLocation = location;
        applyFix(rawFix, { reapply: true });
        toast(
          tracking.status === "live"
            ? "Точка уточнена. Дальше показаны приблизительные смещения геопозиции."
            : tracking.reason,
        );
      } catch (error) {
        calibration = null;
        holdManual = true;
        tracking.status = "needs-refinement";
        tracking.reason = error.message;
        publish(location, "needs-refinement");
        toast(error.message);
      }
    } else {
      tracking.status = "off";
      tracking.reason = "Точка указана вручную.";
      publish(location);
    }
    return true;
  }
  function previewPicking() {
    if (!scene.locationPicking) return null;
    const pick = scene.getCenterLocationPick?.() || null;
    $("#location-pick-confirm").disabled = !pick;
    $("#location-crosshair").dataset.valid = String(Boolean(pick));
    const floor = state.floorData.find((f) => f.id === pick?.floorId);
    const location = pick && manualMapLocation(pick, floor, state.search);
    $("#location-pick-validity").textContent = location
      ? [
          location.label,
          location.building ? `корпус ${location.building}` : null,
          Number.isFinite(location.physicalLevel)
            ? `${location.physicalLevel} этаж`
            : "этаж участка не установлен",
        ]
          .filter(Boolean)
          .join(" · ")
      : "Передвиньте карту: метка должна быть на полу, вне стены и лестничного проёма.";
    return pick;
  }
  function beginPicking({ onPicked, purpose = "manual" } = {}) {
    stopPicking();
    document.activeElement?.blur?.();
    if (dialog.open) dialog.close();
    closeRoom();
    routes.pauseGuidance();
    tracking.following = false;
    if (openForPicking) {
      if (openForPicking() === false) return false;
    } else if (
      state.floor &&
      chooseFloor(state.floor.id, { fit: false }) === false
    )
      return false;
    experience.minimize();
    if (!scene.setLocationPicking(true)) {
      toast("Откройте нужный этаж карты, затем уточните точку.");
      return false;
    }
    pickPurpose = purpose;
    pickCompletion = onPicked || null;
    $("#location-pick-banner").hidden = false;
    $("#location-crosshair").hidden = false;
    $("#location-pick-banner-text").textContent =
      purpose === "survey"
        ? "Выберите этаж и двигайте карту под меткой: здесь вы стоите во время замера."
        : "Выберите этаж и передвиньте карту под меткой к своему месту.";
    $("#location-pick-confirm").textContent =
      purpose === "survey" ? "Здесь замер" : "Я здесь";
    document.body.dataset.locationPicking = "true";
    previewPicking();
    refresh();
    return true;
  }
  function pick(pick) {
    const floor = state.floorData.find((f) => f.id === pick?.floorId);
    const location = manualMapLocation(pick, floor, state.search);
    if (!location) return false;
    const complete = pickCompletion,
      purpose = pickPurpose;
    if (purpose === "survey" && !Number.isFinite(location.physicalLevel)) {
      toast(
        "Для этого участка этаж не установлен. Выберите корпус и этаж переключателями карты.",
      );
      return false;
    }
    stopPicking();
    assignManual(location, purpose);
    if (purpose !== "survey") {
      tracking.following = true;
      experience.minimize();
      scene.focusUserLocation();
      refresh();
    }
    complete?.(location);
    if (purpose === "survey")
      toast("Точка замера закреплена отдельно от геопозиции.");
    return true;
  }
  // A route/search action may use the floor the user is explicitly viewing.
  // This context is not written back as a GPS measurement of the actual floor.
  function mapPositionContext() {
    const location = state.userLocation;
    if (!isCurrentUserLocation(location)) return null;
    if (location.floorId) return { ...location, point: location.point.slice() };
    if (state.mode !== "floor" || !state.floor) return null;
    return {
      ...location,
      point: location.point.slice(),
      floorId: state.floor.id,
      building: state.building || null,
      physicalLevel: state.floor.buildingLevels?.[state.building] ?? null,
      floorEvidence: "manual-view-selection",
      placeId: null,
    };
  }
  function routeOrigin() {
    const context = mapPositionContext();
    return context &&
      (!allowTrackingPoint || allowTrackingPoint(context.point, context))
      ? context
      : null;
  }
  $("#locate-open").onclick = locate;
  $("#location-options").onclick = open;
  $("#location-close").onclick = () => dialog.close();
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  $("#location-gps").onclick = () =>
    tracking.enabled ? stopTracking() : locate();
  $("#location-map").onclick = () => beginPicking();
  $("#location-pick-cancel").onclick = stopPicking;
  $("#location-pick-confirm").onclick = () => {
    const point = previewPicking();
    if (point) pick(point);
  };
  $("#location-clear").onclick = () => {
    stopTracking();
    calibration = null;
    rawFix = null;
    holdManual = false;
    floorSelection = null;
    stopPicking();
    tracking.status = "off";
    tracking.reason = "";
    publish(null);
  };
  $("#location-reset-correction").onclick = () => {
    calibration = null;
    holdManual = false;
    if (state.userLocation?.correction) {
      const location = state.userLocation;
      state.userLocation = {
        ...location,
        point: (location.rawPoint || location.point).slice(),
        correction: null,
      };
    }
    if (rawFix && tracking.enabled) applyFix(rawFix, { reapply: true });
    else refresh();
  };
  $("#location-follow").onchange = (e) => {
    tracking.following = e.target.checked;
    if (tracking.following) locate();
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopPicking();
  });
  window.addEventListener("atlas:back", (e) => {
    if (!$("#location-pick-banner").hidden) {
      stopPicking();
      e.preventDefault();
    }
  });
  const suspend = () => {
    releaseHeading();
    if (!tracking.enabled) return;
    releaseWatch();
    tracking.status = "paused";
    tracking.reason = "Обновление продолжится при возврате в приложение.";
    if (state.userLocation) publish(state.userLocation, "paused");
    else refresh();
  };
  const resume = () => {
    beginHeading();
    beginWatch();
  };
  document.addEventListener("visibilitychange", () =>
    document.hidden ? suspend() : resume(),
  );
  window.addEventListener("atlas:app-state", (e) => {
    if (e.detail?.isActive === true) resume();
  });
  window.addEventListener("pagehide", suspend);
  refresh();
  return {
    open,
    locate,
    refresh,
    beginPicking,
    previewPicking,
    cancelPicking: stopPicking,
    setSurveyLocation,
    startTracking,
    stopTracking,
    routeOrigin,
    nearbyOrigin: mapPositionContext,
    pick,
    pauseFollowing() {
      tracking.following = false;
      refresh();
    },
    setPlace(place) {
      const floor = state.floorData.find((f) => f.id === place.floorId);
      const location = manualPlaceLocation(place, floor, state.campus?.id);
      if (!location) return false;
      assignManual(location, "manual");
      if (tracking.enabled) tracking.following = true;
      refresh();
      if (location.placeId) routes.setOrigin(place, { open: false });
      return true;
    },
  };
}
