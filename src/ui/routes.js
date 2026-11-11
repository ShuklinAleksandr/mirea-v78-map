import { $, escape } from "./dom.js";
import { icon } from "./icons.js";
import { shareView } from "./experience.js";
import {
  isCompactLandscape,
  landscapeMapPadding,
  portraitMapPadding,
  desktopMapPadding,
} from "./map-viewport.js";
import { makeCurrentRouteEndpoint } from "../data/current-route-origin.js";
import { isCurrentUserLocation } from "../data/user-location.js";
import {
  createRouteTracker,
  ROUTE_TRACKING_MAX_AGE_MS,
} from "../data/route-tracking.js";
import { createRouteTrackingSurfaceGuard } from "../data/route-tracking-surface.js";
import { createRouteLocationDisplay } from "../data/route-location-display.js";
import { findNextPlaces } from "../data/next-place-search.js";
import { placeLocation, presentPlaceIdentity } from "../data/place-location.js";
import placeLandmarks from "../data/place-landmarks.json" with { type: "json" };
import { isNextInterface } from "./variant.js";
import { nextRouteReadout, partialRouteInfo } from "./next-route.js";
import {
  createRouteGuidance,
  sampleRouteGuidance,
  guidanceAnchorForStep,
} from "../map/route-guidance.js";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[\s−–—._-]/g, "")
    .replace(
      /[abcegkmoptxy]/g,
      (c) =>
        ({
          a: "а",
          b: "в",
          c: "с",
          e: "е",
          g: "г",
          k: "к",
          m: "м",
          o: "о",
          p: "р",
          t: "т",
          x: "х",
          y: "у",
        })[c],
    );
export function bindRoutes({
  state,
  scene,
  loadCampus,
  chooseFloor,
  closeRoom,
  toast,
  experience,
  saveView,
  updateUI,
  getUserOrigin,
  onLocate,
  onRefineLocation,
  onConfirmFloor,
  onPauseFollowing,
  onFloorContext,
  getLiveFloorContext,
}) {
  const nextInterface = isNextInterface();
  let from = null,
    to = null,
    route = null,
    activeInput = "from",
    revision = 0,
    stepIndex = 0,
    guiding = false,
    worker;
  let guide = { sections: [], anchors: [] },
    guideSection = 0,
    guideDistance = 0,
    previewing = false,
    previewFrame = null,
    previewTimestamp = null,
    previewRevision = 0;
  let pendingCurrentOrigin = null;
  let liveTracker = null,
    automatic = false,
    liveProgress = null,
    acceptedProgress = null,
    liveExpiryTimer = null,
    resumeAfterTimestamp = -Infinity;
  const surfaceGuards = new WeakMap();
  const routeDisplay = createRouteLocationDisplay();
  let displayExpiryTimer = null;
  const pending = new Map();
  function calculate(a, b, id) {
    if (!worker) {
      worker = new Worker(new URL("../data/route-worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = ({ data }) => {
        pending.get(data.id)?.(data.result);
        pending.delete(data.id);
      };
      worker.onerror = () => {
        for (const resolve of pending.values())
          resolve({
            ok: false,
            message: "Не удалось запустить расчёт. Повторите попытку.",
          });
        pending.clear();
        worker.terminate();
        worker = null;
      };
    }
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ from: a, to: b, id });
    });
  }
  function panel(routeMode) {
    if (!routeMode) {
      pausePreview(false);
      closeResults();
    }
    $("#explore-panel").hidden = routeMode;
    $("#route-panel").hidden = !routeMode;
    closeRoom();
  }
  $("#route-back-search").onclick = () => experience.openSearch();
  $("#route-open").onclick = () => {
    panel(true);
    experience.expand(!route);
    if (!route && (!from || !to)) {
      const key = to ? "from" : "to";
      if (innerWidth > 700 && !isCompactLandscape(innerWidth, innerHeight))
        focusEndpoint(key);
      else candidates(key);
    }
  };
  function status(text, error = false) {
    $("#route-status").textContent = text;
    $("#route-status").classList.toggle("error", error);
  }
  function invalidate() {
    pausePreview(false);
    automatic = false;
    liveTracker = liveProgress = null;
    resetAcceptedProgress();
    resumeAfterTimestamp = -Infinity;
    if (typeof clearTimeout === "function") clearTimeout(liveExpiryTimer);
    revision++;
    route = null;
    guiding = false;
    guide = { sections: [], anchors: [] };
    guideSection = guideDistance = 0;
    scene.setRouteGuidance?.(null);
    scene.clearRoute();
    if (state.routeSnapEnabled) scene.refreshUserLocation?.();
    $("#route-panel").dataset.complete = "false";
    $("#route-panel").dataset.guiding = "false";
    for (const id of ["route-summary", "route-steps", "route-actions"])
      $("#" + id).hidden = true;
    $("#route-build").disabled = false;
    $("#route-build").innerHTML = `${icon("route", 18)}Построить маршрут`;
    status("Выберите, откуда и куда идти.");
    renderDock();
    saveView();
  }
  function closeResults() {
    $("#route-results").hidden = true;
    for (const key of ["from", "to"])
      $("#route-" + key).setAttribute("aria-expanded", "false");
  }
  function setEndpoint(key, room) {
    if (key === "from") pendingCurrentOrigin = null;
    invalidate();
    if (key === "from") from = room;
    else to = room;
    $("#route-" + key).value = room.label;
    closeResults();
    if (room.kind !== "user-location") experience.remember(room);
    refreshCurrentOriginButton();
    saveView();
  }
  function refreshCurrentOriginButton() {
    const button = $("#route-use-location");
    if (!button) return;
    button.disabled = false;
    button.classList.toggle("active", from?.kind === "user-location");
    button.setAttribute(
      "aria-label",
      pendingCurrentOrigin
        ? "Получаем моё местоположение для начала маршрута"
        : "Начать маршрут от моего местоположения",
    );
    button.setAttribute("aria-pressed", String(from?.kind === "user-location"));
  }
  function currentOriginResult() {
    const observation = state.userLocation;
    if (state.routeSnapEnabled && observation?.source === "gps") {
      const context =
        observation.floorEvidence === "manual"
          ? getLiveFloorContext?.(observation)
          : null;
      return makeCurrentRouteEndpoint(
        context ? { ...observation, ...context } : observation,
        {
          snapToRoute: true,
          viewFloor: state.mode === "floor" ? state.floor : null,
          campusId: state.campus?.id,
        },
      );
    }
    const location = getUserOrigin ? getUserOrigin() : observation;
    return makeCurrentRouteEndpoint(location);
  }
  function useCurrentLocation({ open = true, quiet = false } = {}) {
    const result = currentOriginResult();
    if (result.ok) {
      pendingCurrentOrigin = null;
      setEndpoint("from", result.endpoint);
      if (open) {
        panel(true);
        experience.expand(true);
        focusEndpoint("to");
      }
      const location = result.endpoint.location;
      status(
        result.endpoint.snapToRoute
          ? location.floorEvidence === "manual-view-selection"
            ? "Подберём ближайший проход на открытом плане. GPS не определяет этаж."
            : "Подберём ближайший проход на указанном этаже."
          : "Начало — отмеченное местоположение. Выберите, куда идти.",
      );
      return true;
    }
    if (isCurrentUserLocation(state.userLocation)) {
      pendingCurrentOrigin = null;
      if (state.routeSnapEnabled && state.userLocation?.source === "gps") {
        status(result.message, true);
        if (!quiet) toast(result.message);
      } else {
        status(
          "Уточните свою точку на выбранном плане этажа для начала маршрута.",
          true,
        );
        if (!quiet)
          toast("Уточните точку на плане, чтобы начать маршрут от себя.");
        onRefineLocation?.();
      }
    } else if (onLocate) {
      pendingCurrentOrigin = { open, quiet };
      status("Получаем геопозицию для начала маршрута…");
      onLocate();
    } else {
      status(result.message, true);
      if (!quiet) toast(result.message);
    }
    refreshCurrentOriginButton();
    return false;
  }
  function locationChanged() {
    refreshCurrentOriginButton();
    // The location controller refreshes the marker once, after route matching.
    updateLiveGuidance(false);
    if (!pendingCurrentOrigin) return;
    const options = pendingCurrentOrigin;
    if (isCurrentUserLocation(state.userLocation)) {
      pendingCurrentOrigin = null;
      if (useCurrentLocation(options) && to) build();
    } else if (
      ["error", "stopped"].includes(state.locationTracking?.status) ||
      (state.locationTracking?.enabled === false &&
        state.locationTracking?.status !== "off")
    ) {
      pendingCurrentOrigin = null;
      status(
        "Геопозиция не получена. Уточните своё место на карте или выберите начало вручную.",
        true,
      );
      refreshCurrentOriginButton();
    }
  }
  function liveSurface(point, projectedPoint, section) {
    const floor = state.floorData?.find((item) => item.id === section.floorId);
    if (!floor) return false;
    let guard = surfaceGuards.get(floor);
    if (!guard) {
      guard = createRouteTrackingSurfaceGuard(floor);
      surfaceGuards.set(floor, guard);
    }
    return guard(point, projectedPoint);
  }
  function resetAcceptedProgress() {
    resetRouteDisplay();
    acceptedProgress = null;
    scene.setRoutePreviewProgress?.(null);
    scene.setLiveRouteProgress?.(null);
  }
  function resetRouteDisplay() {
    routeDisplay.reset();
    if (typeof clearTimeout === "function") clearTimeout(displayExpiryTimer);
    displayExpiryTimer = null;
  }
  function displayEnabled(location = state.userLocation) {
    return Boolean(
      state.routeSnapEnabled &&
        guiding &&
        automatic &&
        !previewing &&
        !document.hidden &&
        document.documentElement?.dataset?.appActive !== "false" &&
        !scene.locationPicking &&
        state.mode === "floor" &&
        state.locationTracking?.enabled !== false &&
        location === state.userLocation &&
        state.campus?.id === route?.campusId &&
        liveProgress?.floorId === state.floor?.id &&
        location?.source === "gps",
    );
  }
  function syncRouteDisplay() {
    if (typeof clearTimeout === "function") clearTimeout(displayExpiryTimer);
    displayExpiryTimer = null;
    const match = routeDisplay.update({
      progress: liveProgress,
      location: state.userLocation,
      sourceSegmentIndex:
        guide.sections[liveProgress?.sectionIndex]?.sourceSegmentIndex,
      enabled: displayEnabled(),
      now: Date.now(),
    });
    if (match?.held && typeof setTimeout === "function") {
      displayExpiryTimer = setTimeout(
        () => {
          displayExpiryTimer = null;
          // Expiry only changes the displayed position, never route progress.
          routeDisplay.read(Date.now());
          scene.refreshUserLocation?.();
          updateDockReadout();
        },
        Math.max(1, match.expiresAt - Date.now() + 1),
      );
    }
  }
  function commitLiveProgress() {
    if (
      !liveProgress.matchedPoint ||
      !["tracking", "floor-change", "arrived"].includes(liveProgress.status)
    )
      return;
    const { sectionIndex, distance, stepIndex: nextStepIndex } = liveProgress;
    if (
      acceptedProgress?.sectionIndex === sectionIndex &&
      acceptedProgress.distance === distance &&
      acceptedProgress.nextStepIndex === nextStepIndex
    )
      return;
    const sample = sampleRouteGuidance(guide, sectionIndex, distance);
    if (!sample) return;
    acceptedProgress = { ...sample, nextStepIndex };
    scene.setLiveRouteProgress?.(acceptedProgress);
  }
  function routeLocationMatch(location) {
    if (!displayEnabled(location)) {
      resetRouteDisplay();
      return null;
    }
    return routeDisplay.read(Date.now());
  }
  function updateLiveGuidance(refreshLocation = true) {
    if (!route || !guiding || !automatic || previewing || !liveTracker) return;
    if (typeof clearTimeout === "function") clearTimeout(liveExpiryTimer);
    if (
      document.hidden ||
      scene.locationPicking ||
      state.campus?.id !== route.campusId
    ) {
      resetRouteDisplay();
      liveProgress = {
        ...liveTracker.snapshot(),
        status: "stale",
        reason: "navigation-paused",
      };
      updateDockReadout();
      if (refreshLocation && state.routeSnapEnabled)
        scene.refreshUserLocation?.();
      return;
    }
    if (state.userLocation?.timestamp <= resumeAfterTimestamp) {
      resetRouteDisplay();
      const last = liveTracker.snapshot();
      liveProgress =
        last.reason === "manual-step" ? last : { ...last, status: "stale" };
      updateDockReadout();
      if (refreshLocation && state.routeSnapEnabled)
        scene.refreshUserLocation?.();
      return;
    }
    const previousTimestamp = liveProgress?.locationTimestamp;
    liveProgress = liveTracker.update(state.userLocation, {
      now: Date.now(),
      floorId: state.mode === "overview" ? null : state.floor?.id,
      floorBuildingLevels:
        state.mode === "floor" ? state.floor?.buildingLevels : null,
      allowPoint: liveSurface,
      pauseOnReverse: state.routeSnapEnabled === true,
    });
    guideSection = liveProgress.sectionIndex;
    guideDistance = liveProgress.distance;
    stepIndex = liveProgress.stepIndex;
    commitLiveProgress();
    syncRouteDisplay();
    // Context follows the same accepted point as the moving marker.
    // It must not override manual map browsing or a pending stair hand-off.
    if (
      liveProgress.matchedPoint &&
      ["tracking", "wrong-way", "floor-change", "arrived"].includes(
        liveProgress.status,
      ) &&
      liveProgress.locationTimestamp !== previousTimestamp &&
      state.locationTracking?.enabled &&
      state.locationTracking.following &&
      !state.selected &&
      state.mode === "floor"
    ) {
      const section = guide.sections[guideSection];
      if (section?.floorId === state.floor?.id)
        onFloorContext?.(
          {
            floorId: section.floorId,
            sourceSegmentIndex: section.sourceSegmentIndex,
            position: liveProgress.matchedPoint,
          },
          route.segments[section.sourceSegmentIndex]?.nodes || [],
        );
    }
    scene.setRouteGuidance?.(null);
    if (refreshLocation && state.routeSnapEnabled)
      scene.refreshUserLocation?.();
    updateProgressReadout();
    const expires =
      state.userLocation?.timestamp +
      ROUTE_TRACKING_MAX_AGE_MS +
      1 -
      Date.now();
    if (expires > 0 && typeof setTimeout === "function")
      liveExpiryTimer = setTimeout(updateLiveGuidance, expires);
  }
  function chooseCurrentOrigin() {
    if (!experience.finishInputEditing?.({ focusHandle: false }))
      $("#route-from").blur();
    closeResults();
    if (useCurrentLocation({ open: !to }) && to) build();
  }
  const currentOriginButton = $("#route-use-location");
  if (currentOriginButton) currentOriginButton.onclick = chooseCurrentOrigin;
  function focusEndpoint(key) {
    const input = $("#route-" + key);
    if (document.activeElement === input) candidates(key);
    else input.focus({ preventScroll: true });
  }
  function candidates(key) {
    activeInput = key;
    const value = $("#route-" + key).value;
    const selected = key === "from" ? from : to;
    const query = selected?.label === value ? "" : value;
    const q = norm(query);
    const list = $("#route-results");
    const records = (
      nextInterface
        ? findNextPlaces(state.search, {
            query,
            campusId: state.campus?.id,
            building: state.building,
            floorId: state.floor?.id,
            physicalLevel: state.floor?.buildingLevels?.[state.building],
            manifest: state.manifest,
          })
        : state.search
            .filter((r) => r.label && (!q || norm(r.label).includes(q)))
            .sort(
              (a, b) =>
                (norm(b.label) === q) - (norm(a.label) === q) ||
                (b.campusId === state.campus?.id) -
                  (a.campusId === state.campus?.id) ||
                a.label.localeCompare(b.label, "ru", { numeric: true }),
            )
    )
      .filter((record) => record.label)
      .slice(0, 30);
    list.innerHTML = records.length
      ? records
          .map((r) => {
            const c = state.manifest?.campuses.find((c) => c.id === r.campusId);
            const f = c?.floors.find((f) => f.id === r.floorId);
            const level = f?.buildingLevels?.[r.building];
            if (nextInterface) {
              const identity = presentPlaceIdentity(r, f);
              const location = placeLocation(identity, f, placeLandmarks.hints);
              return `<button role="option" data-id="${escape(r.id)}"><span class="result-icon">${icon(r.kind === "stairs" ? "stair" : "pin", 17)}</span><span><b>${escape(identity.label)}</b><small>${escape(location.summary)}</small>${location.landmark ? `<small>${escape(location.landmark)}</small>` : ""}</span></button>`;
            }
            return `<button role="option" data-id="${escape(r.id)}"><span class="result-icon">${icon("pin", 17)}</span><span><b>${escape(r.label)}</b><small>${escape(c?.title)}${r.building ? ` · корпус ${escape(r.building)}` : ""}${level != null ? ` · ${level} этаж` : ""}</small></span></button>`;
          })
          .join("")
      : nextInterface
        ? '<div class="search-empty">Ничего не найдено. Попробуйте номер аудитории или категорию: еда, туалеты, гардероб.</div>'
        : '<div class="search-empty">Ничего не найдено. Попробуйте номер аудитории.</div>';
    if (key === "from")
      list.innerHTML =
        `<button type="button" role="option" data-current-origin><span class="result-icon">${icon("locate", 17)}</span><span><b>От моего местоположения</b></span></button>` +
        list.innerHTML;
    list.hidden = false;
    list.scrollTop = 0;
    $("#route-" + (key === "from" ? "to" : "from")).setAttribute(
      "aria-expanded",
      "false",
    );
    $("#route-" + key).setAttribute("aria-expanded", "true");
    for (const b of list.querySelectorAll("button"))
      b.onclick = () => {
        if (b.dataset.currentOrigin !== undefined) {
          chooseCurrentOrigin();
          return;
        }
        const room = state.search.find((r) => r.id === b.dataset.id);
        if (!room) return;
        setEndpoint(key, room);
        if (!from || !to) {
          // The other input is hidden in focused mode. Reveal it before
          // transferring focus, within the same tap that chose this result.
          experience.finishInputEditing?.({ focusHandle: false });
          focusEndpoint(from ? "to" : "from");
        } else if (!experience.finishInputEditing?.()) {
          $("#route-" + key).blur();
        }
      };
  }
  for (const key of ["from", "to"]) {
    const input = $("#route-" + key);
    input.onfocus = () => {
      experience.expand(true);
      candidates(key);
    };
    input.onclick = () => {
      if ($("#route-results").hidden) candidates(key);
    };
    input.oninput = () => {
      if (key === "from") {
        from = null;
        pendingCurrentOrigin = null;
      } else to = null;
      invalidate();
      candidates(key);
    };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        $("#route-results button")?.focus();
        e.preventDefault();
      }
      if (e.key === "Escape") {
        closeResults();
        e.preventDefault();
      }
      if (e.key === "Enter" && !$("#route-results").hidden) {
        const selected = key === "from" ? from : to;
        if (selected?.label === input.value) {
          closeResults();
          if (!experience.finishInputEditing?.()) input.blur();
        } else {
          $("#route-results button[data-id]")?.click();
        }
        e.preventDefault();
      }
    };
  }
  $("#route-results").onkeydown = (e) => {
    const bs = [...$("#route-results").querySelectorAll("button")];
    const i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      bs[
        Math.max(
          0,
          Math.min(bs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)),
        )
      ]?.focus();
      e.preventDefault();
    }
    if (e.key === "Escape") {
      closeResults();
      e.preventDefault();
      $("#route-" + activeInput).focus();
      closeResults();
    }
  };
  $("#route-swap").onclick = () => {
    [from, to] = [to, from];
    $("#route-from").value = from?.label || "";
    $("#route-to").value = to?.label || "";
    invalidate();
    closeResults();
    refreshCurrentOriginButton();
  };
  const padding = () => {
    if (document.body?.dataset.cleanMap === "true")
      return { top: 64, bottom: 16, left: 16, right: 16 };
    if (isCompactLandscape(innerWidth, innerHeight))
      return landscapeMapPadding();
    if (innerWidth <= 700) return portraitMapPadding();
    return desktopMapPadding();
  };
  function minimizePanel() {
    if (experience.minimize) experience.minimize();
    else experience.expand(false);
  }
  function viewFloor(id, focus = true, { keepCamera = false } = {}) {
    if (!route) return false;
    pausePreview(false);
    scene.setRouteGuidance?.(null);
    if (!keepCamera) scene.setRouteOverview?.(false);
    const previousBuilding = state.building;
    state.building = null;
    if (chooseFloor(id, { fit: false, keepCamera }) === false) {
      state.building = previousBuilding;
      if (guiding) renderProgress();
      return false;
    }
    scene.setRoute(route, { focus: focus && !keepCamera, padding: padding() });
    renderFloors();
    const n = route.segments.find((s) => s.floorId === id)?.nodes[0];
    $("#focus-floor-status").innerHTML =
      `${icon("layers", 16)}<span>${n?.physicalLevel != null ? `${n.physicalLevel} этаж${n.building ? ` · корпус ${escape(n.building)}` : ""}` : "Этаж маршрута"}</span><small>В фокусе</small>`;
    if (guiding) renderProgress();
    return true;
  }
  function renderFloors() {
    if (!route) return;
    const floors = [...new Set(route.segments.map((s) => s.floorId))];
    $("#route-floor-chips").innerHTML = floors
      .map((id, i) => {
        const segment = route.segments.find((s) => s.floorId === id);
        const n = segment.nodes[0];
        const title =
          n?.physicalLevel != null
            ? `${n.physicalLevel} этаж${n.building ? ` · ${n.building}` : ""}`
            : `Уровень ${n?.sourceLevel ?? i + 1}`;
        return `<button data-route-floor="${escape(id)}" class="${state.floor?.id === id ? "active" : ""}">${escape(title)}</button>`;
      })
      .join("");
    for (const b of $("#route-floor-chips").children)
      if (b.dataset.routeFloor)
        b.onclick = () =>
          viewFloor(b.dataset.routeFloor, false, { keepCamera: true });
  }
  function syncView() {
    if (!route || route.campusId !== state.campus?.id) return;
    // A source level can contain different physical floors in several wings.
    // Keep an explicitly selected place/building's own header when a saved
    // route also happens to cross the same source level.
    if (
      state.selected ||
      state.building ||
      state.floorContext?.floorId === state.floor?.id
    )
      return;
    const n = route.segments.find((s) => s.floorId === state.floor?.id)
      ?.nodes[0];
    if (n) {
      const title =
        n.physicalLevel != null
          ? `${n.physicalLevel} этаж${n.building ? ` · корпус ${n.building}` : ""}`
          : `Уровень плана ${n.sourceLevel}`;
      $("#focus-floor-status").innerHTML =
        `${icon("layers", 16)}<span>${escape(title)}</span><small>В фокусе</small>`;
      $("#caption-title").textContent = title + " · маршрут";
    }
  }
  function focusStep(index, { keepCamera = false, correction = false } = {}) {
    if (!route?.steps?.length || index < 0 || index >= route.steps.length)
      return false;
    pausePreview(false);
    closeRoom();
    if (!keepCamera) minimizePanel();
    const previous = { stepIndex, guiding, guideSection, guideDistance };
    stepIndex = index;
    guiding = true;
    renderDock();
    const step = route.steps[index];
    const anchor = guidanceAnchorForStep(guide, index);
    let opened;
    if (anchor) {
      guideSection = anchor.sectionIndex;
      guideDistance = anchor.distance;
      opened = Boolean(
        applyGuidance({ animate: !keepCamera, keepStep: true, keepCamera }),
      );
    } else opened = viewFloor(step.floorId, !keepCamera, { keepCamera });
    if (!opened) {
      ({ stepIndex, guiding, guideSection, guideDistance } = previous);
      if (guiding)
        applyGuidance({ animate: false, keepStep: true, keepCamera });
      toast(
        "Не удалось открыть этаж этого шага. Выберите другой шаг или измените маршрут.",
      );
    } else if (automatic && liveTracker) {
      resetRouteDisplay();
      liveProgress = liveTracker.seekStep(index);
      const timestamp = state.userLocation?.timestamp;
      if (correction && Number.isFinite(timestamp))
        resumeAfterTimestamp = Math.max(resumeAfterTimestamp, timestamp);
      updateLiveGuidance();
    }
    renderSteps();
    return opened;
  }
  function renderSteps() {
    if (!route) return;
    $("#route-steps").innerHTML = route.steps
      .map(
        (s, i) =>
          `<button class="route-step ${i === stepIndex ? "active" : ""}" data-step="${i}"><span>${s.kind === "stairs" ? "↕" : i + 1}</span><span>${escape(s.text)}</span></button>`,
      )
      .join("");
    for (const b of $("#route-steps").children)
      b.onclick = () => focusStep(+b.dataset.step);
    renderProgress();
  }
  function startGuidance(index = 0) {
    if (!route) return;
    automatic = true;
    liveTracker ||= createRouteTracker(route);
    guiding = true;
    guideSection = guideDistance = 0;
    focusStep(index);
    onLocate?.();
    updateLiveGuidance();
  }
  function clear({ open = false, completed = false } = {}) {
    const completion =
      partialRouteInfo(route)?.completion || "Вы пришли. Маршрут завершён";
    pendingCurrentOrigin = null;
    from = to = null;
    refreshCurrentOriginButton();
    $("#route-from").value = $("#route-to").value = "";
    invalidate();
    if (completed) toast(completion);
    panel(open);
    if (open) {
      experience.expand(true);
      candidates("to");
    } else minimizePanel();
    updateUI();
    saveView();
  }
  function advanceStep(index, { keepCamera = false } = {}) {
    const targetFloorId = route?.steps[index]?.targetFloorId;
    const nextSection = targetFloorId
      ? guide.sections.find(
          (section, sectionIndex) =>
            sectionIndex > guideSection && section.floorId === targetFloorId,
        )
      : null;
    const target = nextSection
      ? route.segments[nextSection.sourceSegmentIndex]?.nodes?.[0]
      : null;
    if (
      focusStep(index + 1, { keepCamera, correction: true }) &&
      automatic &&
      targetFloorId
    ) {
      // Pressing the stair action is the user's explicit floor confirmation.
      onConfirmFloor?.({
        campusId: route.campusId,
        floorId: targetFloorId,
        building: target?.building,
        physicalLevel: target?.physicalLevel,
      });
      if (!keepCamera) onLocate?.();
      updateLiveGuidance();
    }
  }
  function getStairAction() {
    const section = guide.sections[guideSection];
    const next = guide.sections[guideSection + 1];
    const transition = section?.transition;
    if (
      !route ||
      previewing ||
      transition?.kind !== "stairs" ||
      transition.fromFloorId !== state.floor?.id ||
      transition.toFloorId === transition.fromFloorId ||
      next?.floorId !== transition.toFloorId
    )
      return null;
    const step = guide.anchors.find(
      (anchor) =>
        anchor.sectionIndex === guideSection &&
        route.steps[anchor.stepIndex]?.targetFloorId === next.floorId,
    )?.stepIndex;
    const target = route.segments[next.sourceSegmentIndex]?.nodes?.[0];
    const level = target?.physicalLevel;
    const sourceLevel =
      target?.sourceLevel ??
      state.floorData?.find((floor) => floor.id === next.floorId)?.level;
    if (
      step == null ||
      (!Number.isFinite(level) && !Number.isFinite(sourceLevel))
    )
      return null;
    const id = `route-${revision}-${step}`;
    return {
      id,
      point: transition.point,
      targetFloorId: next.floorId,
      label:
        level === -1
          ? "В цоколь"
          : `На этаж ${Number.isFinite(level) ? level : sourceLevel}`,
      nearby:
        automatic &&
        ["tracking", "floor-change"].includes(liveProgress?.status) &&
        liveProgress.sectionIndex === guideSection &&
        Date.now() - liveProgress.locationTimestamp <=
          ROUTE_TRACKING_MAX_AGE_MS &&
        section.length - liveProgress.distance <= 8,
      open: () => {
        if (getStairAction()?.id === id)
          advanceStep(step, { keepCamera: true });
      },
    };
  }
  function renderDock() {
    const dock = $("#route-guidance-dock");
    if (document.body) {
      document.body.dataset.routeNavigation = String(Boolean(route && guiding));
      document.body.dataset.routeAvailable = String(Boolean(route));
    }
    if (nextInterface) scene.setNavigationMode?.(Boolean(route && guiding));
    if (!dock) return;
    dock.hidden = !route;
    if (!route) {
      dock.innerHTML = "";
      return;
    }
    dock.classList.toggle("route-guidance-dock", true);
    const activeAction = dock.contains(document.activeElement)
      ? document.activeElement.id
      : null;
    const nextElements = nextInterface
      ? `<span class="next-route-distance" id="route-dock-distance" hidden></span>
        <div class="route-dock-progress" id="route-dock-progress" hidden>
          <progress id="route-dock-progress-bar" max="100" value="0" aria-label="Пройденная часть маршрута"></progress>
          <div class="route-dock-progress-labels" aria-hidden="true">
            <span id="route-dock-completed"></span><span id="route-dock-remaining"></span>
          </div>
        </div>`
      : "";
    dock.innerHTML = `
      ${nextInterface ? '<button type="button" id="route-dock-open" class="route-dock-open" aria-label="Открыть маршрут и поиск" aria-controls="sheet-content">Маршрут и поиск</button>' : ""}
      <div class="route-dock-header"><small class="route-dock-meta" id="route-dock-meta"></small><button type="button" class="route-dock-close icon-button" id="route-dock-close" aria-label="Закрыть маршрут">${icon("close", 18)}</button></div>
      ${nextInterface ? '<span class="next-route-symbol" id="route-dock-symbol" aria-hidden="true"></span>' : ""}
      <strong class="route-dock-instruction" id="route-dock-instruction" aria-live="polite"></strong>
      ${nextElements}
      <small class="route-dock-note" id="route-dock-note">Путь по карте · расстояние и время приблизительные</small>
      ${nextInterface ? '<button type="button" id="route-dock-context" class="route-dock-context primary-button" hidden></button>' : ""}
      <div class="route-dock-controls" role="group" aria-label="Шаги маршрута">
        <button type="button" class="route-dock-previous" id="route-dock-previous" aria-label="Предыдущий шаг">Назад</button>
        <button type="button" class="route-dock-next primary-button" id="route-dock-next"></button>
      </div>
      <div class="route-dock-secondary" role="group" aria-label="Управление маршрутом">
        <button type="button" id="route-dock-recenter" class="route-dock-recenter" aria-label="Вернуться к текущему шагу" title="Вернуться к текущему шагу">${icon("route", 20)}<span>К шагу</span></button>
        <button type="button" id="route-dock-details" class="route-dock-details">${icon("route", 16)}${guiding ? "Весь маршрут" : "Изменить"}</button>
      </div>`;
    if (nextInterface) {
      const open = () => {
        pausePreview(false);
        panel(true);
        experience.expand(true);
      };
      const grip = $("#route-dock-open");
      grip?.addEventListener("click", open);
      let touch;
      grip?.addEventListener("pointerdown", (event) => {
        if (
          event.isPrimary === false ||
          (event.button != null && event.button !== 0)
        )
          return;
        touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
        grip.setPointerCapture?.(event.pointerId);
      });
      grip?.addEventListener("pointerup", (event) => {
        if (!touch || touch.id !== event.pointerId) return;
        const { x, y } = touch;
        touch = null;
        if (grip.hasPointerCapture?.(event.pointerId))
          grip.releasePointerCapture(event.pointerId);
        if (
          y - event.clientY > 24 &&
          y - event.clientY > Math.abs(x - event.clientX)
        )
          open();
      });
      grip?.addEventListener("pointercancel", () => {
        touch = null;
      });
      $("#route-dock-context")?.addEventListener("click", () => {
        const action = $("#route-dock-context").dataset.action;
        if (action === "floor") {
          const picker = $("#next-floor-open");
          if (picker?.click) picker.click();
          else onRefineLocation?.();
        } else if (action === "refine") onRefineLocation?.();
        else if (action === "locate") onLocate?.();
      });
    }
    $("#route-dock-next")?.addEventListener("click", () => {
      if (!route) return;
      if (!guiding) {
        if (
          innerWidth > 700 &&
          !isCompactLandscape(innerWidth, innerHeight) &&
          from?.kind !== "user-location"
        ) {
          automatic = false;
          focusStep(0);
        } else startGuidance();
      } else if (stepIndex === route.steps.length - 1)
        clear({ completed: true });
      else advanceStep(stepIndex);
    });
    $("#route-dock-previous")?.addEventListener("click", () =>
      focusStep(stepIndex - 1, { correction: true }),
    );
    $("#route-dock-recenter")?.addEventListener("click", () => {
      if (guiding && onLocate) {
        pausePreview(false);
        automatic = true;
        liveTracker ||= createRouteTracker(route);
        scene.setRouteGuidance?.(null);
        onLocate();
        updateLiveGuidance();
      } else if (guiding) focusStep(stepIndex);
      else {
        minimizePanel();
        viewFloor(route.segments[0].floorId, !guide.sections.length);
        if (guide.sections.length) applyGuidance({ animate: true });
      }
    });
    $("#route-dock-details")?.addEventListener("click", () => {
      if (!guiding) {
        $("#route-edit").onclick();
        return;
      }
      pausePreview();
      panel(true);
      experience.expand(true);
    });
    $("#route-dock-close")?.addEventListener("click", () => clear());
    updateDockReadout();
    if (activeAction) {
      const active = $("#" + activeAction);
      const action =
        active && !active.disabled && !active.hidden
          ? active
          : $("#route-dock-next");
      action?.focus({ preventScroll: true });
    }
  }
  function updateDockReadout() {
    if (!route) return;
    const partial = partialRouteInfo(route);
    const manualEntry = Boolean(
      partial &&
        (route.steps[stepIndex]?.kind === "manual-entry" ||
          liveProgress?.arrived),
    );
    const meta = $("#route-dock-meta");
    const nextDistance =
      automatic &&
      liveProgress?.status !== "wrong-way" &&
      Number.isFinite(liveProgress?.distanceToNextMeters)
        ? ` · ≈ ${Math.round(liveProgress.distanceToNextMeters)} м до шага`
        : "";
    if (meta)
      meta.textContent = guiding
        ? `${partial ? `До ${partial.via} · ` : ""}Шаг ${stepIndex + 1} из ${route.steps.length}${nextDistance}`
        : `${route.durationMinutes != null ? `≈ ${route.durationMinutes} мин · ` : ""}${route.distanceMeters != null ? `≈ ${Math.round(route.distanceMeters)} м` : "Маршрут готов"}${partial ? ` · до ${partial.via}` : ""}`;
    const instruction = $("#route-dock-instruction");
    if (instruction)
      instruction.textContent = guiding
        ? liveProgress?.arrived && automatic
          ? partial?.instruction || `Вы пришли · ${to?.label || "назначение"}`
          : route.steps[stepIndex]?.text || "Следуйте по выделенному пути"
        : partial?.summary ||
          `${from?.label || "Начало"} → ${to?.label || "Назначение"}`;
    const note = $("#route-dock-note");
    if (note && guiding) {
      const notes = {
        waiting: "Ждём GPS. Пока можно переключать шаги вручную.",
        acquiring: "Уточняем положение…",
        uncertain: "Уточняем положение. Продолжайте по линии маршрута.",
        tracking: "По GPS · шаги меняются автоматически",
        "low-accuracy":
          "Точности GPS недостаточно для смены шагов. Уточните точку или идите по кнопке «Далее».",
        stale: "Нет свежего GPS. Автоматическое продвижение приостановлено.",
        "off-route":
          "Положение не совпадает с маршрутом. Можно уточнить точку.",
        "wrong-way": "Продолжайте по линии в сторону назначения.",
        "floor-mismatch":
          "Проверьте свой этаж и уточните точку. GPS не определяет этаж.",
        "floor-change":
          "После лестницы подтвердите, что перешли на следующий этаж.",
        arrived: "Вы у назначения по данным GPS. Проверьте указатель на месте.",
      };
      note.textContent = automatic
        ? routeDisplay.read(Date.now())?.held
          ? "Уточняем положение · показана последняя подтверждённая точка"
          : notes[liveProgress?.status] || notes.waiting
        : previewing
          ? "Демонстрация маршрута · это не ваше движение"
          : "Переключайте шаги, когда дойдёте до указанного места";
    }
    if (note && partial && (!guiding || manualEntry))
      note.textContent = previewing
        ? `Демонстрация до ${partial.via} · это не ваше движение`
        : guiding && automatic && liveProgress?.arrived
          ? `По GPS — у входа в ${partial.via}. ${partial.note}`
          : partial.note;
    const previous = $("#route-dock-previous");
    if (previous) previous.hidden = !guiding || stepIndex === 0;
    const next = $("#route-dock-next");
    if (next) {
      const transition =
        guiding && automatic && route.steps[stepIndex]?.targetFloorId;
      next.innerHTML = `${guiding ? (stepIndex === route.steps.length - 1 ? (partial ? "Закрыть маршрут" : "Завершить") : transition ? "Я на следующем этаже" : "Далее") : "В путь"}${icon("arrow", 17)}`;
    }
    const recenter = $("#route-dock-recenter");
    if (recenter && guiding && onLocate) {
      recenter.setAttribute("aria-label", "К моему местоположению");
      recenter.setAttribute("title", "К моему местоположению");
      recenter.innerHTML = `${icon("locate", 20)}<span>Ко мне</span>`;
    }
    if (nextInterface) {
      const step = route.steps[stepIndex];
      const targetSection = step?.targetFloorId
        ? guide.sections.find(
            (section, index) =>
              index > guideSection && section.floorId === step.targetFloorId,
          )
        : null;
      const transitionLevel = targetSection
        ? route.segments[targetSection.sourceSegmentIndex]?.nodes?.[0]
            ?.physicalLevel
        : null;
      const view = nextRouteReadout({
        route,
        to,
        guiding,
        automatic,
        previewing,
        stepIndex,
        liveProgress,
        userLocation: state.userLocation,
        following: state.locationTracking?.following,
        snapToRoute: state.routeSnapEnabled,
        locationHeld: Boolean(routeDisplay.read(Date.now())?.held),
        transitionLevel,
        guide,
        acceptedProgress,
        manualProgress: automatic
          ? null
          : sampleRouteGuidance(guide, guideSection, guideDistance),
      });
      if (meta) meta.textContent = view.meta;
      if (note)
        note.textContent =
          guiding &&
          !automatic &&
          !previewing &&
          innerWidth > 700 &&
          !isCompactLandscape(innerWidth, innerHeight)
            ? "Просмотр маршрута · переключайте шаги кнопками"
            : view.note;
      if (previous) {
        previous.hidden = !guiding;
        previous.disabled = stepIndex === 0;
      }
      if (next) {
        next.hidden = !view.showNext;
        const label =
          !guiding &&
          innerWidth > 700 &&
          !isCompactLandscape(innerWidth, innerHeight) &&
          from?.kind !== "user-location"
            ? "Посмотреть шаги"
            : view.nextLabel;
        next.innerHTML = `${escape(label)}${icon("arrow", 17)}`;
        next.classList.toggle("primary-button", !view.contextAction);
      }
      if (recenter) recenter.hidden = !view.showRecenter;
      const progress = $("#route-dock-progress");
      if (progress) {
        progress.hidden = !view.progress;
        if (view.progress) {
          const bar = $("#route-dock-progress-bar");
          bar.value = view.progress.percent;
          bar.setAttribute("aria-valuetext", view.progress.valueText);
          $("#route-dock-completed").textContent = view.progress.completed;
          $("#route-dock-remaining").textContent = view.progress.remaining;
        }
      }
      const distance = $("#route-dock-distance");
      if (distance) {
        distance.hidden = !view.distance;
        distance.textContent = view.distance;
      }
      const symbol = $("#route-dock-symbol");
      if (symbol) {
        symbol.hidden = !guiding;
        symbol.dataset.direction = view.direction;
        symbol.innerHTML = icon(
          view.direction === "manual-entry"
            ? "info"
            : view.direction === "stairs"
              ? "stair"
              : view.direction === "arrive"
                ? "pin"
                : "arrow",
          28,
        );
      }
      const context = $("#route-dock-context");
      if (context) {
        const available =
          view.contextAction === "refine"
            ? onRefineLocation
            : view.contextAction === "locate"
              ? onLocate
              : view.contextAction === "floor";
        context.hidden = !view.contextAction || !available;
        context.dataset.action = view.contextAction || "";
        context.textContent = view.contextLabel || "";
      }
    }
  }
  function renderProgress() {
    $("#route-panel").dataset.guiding = String(guiding);
    renderDock();
    const host = $("#route-progress");
    if (!host || !route) return;
    const sample = sampleRouteGuidance(guide, guideSection, guideDistance);
    // A demonstration is an optional tool in route details. It never starts
    // when the user presses “В путь”, nor is its moving marker a GPS position.
    const demoOpen = $("#route-demo")?.open;
    host.hidden = !sample;
    host.innerHTML = sample
      ? `<details class="route-demo" id="route-demo" ${demoOpen ? "open" : ""}><summary>Демонстрация маршрута</summary><p class="guidance-status" id="route-guidance-status"></p><label class="guidance-position" for="route-progress-position"><span id="route-progress-label"></span><input id="route-progress-position" type="range" min="0" max="1000" step="1" value="${Math.round(sample.progress * 1000)}" aria-label="Положение указателя в демонстрации маршрута"/></label><div class="guidance-controls"><button type="button" id="route-preview-play">Показать</button></div><button type="button" id="route-next-section" ${sample.atEnd && guideSection < guide.sections.length - 1 ? "" : "hidden"}>${escape(sample.transition?.label || "Следующий этаж")} →</button><p class="guidance-disclaimer">Движение указателя — демонстрация. Она не определяет ваше местоположение.</p></details>`
      : "";
    $("#route-preview-play")?.addEventListener("click", () =>
      previewing ? pausePreview() : playPreview(),
    );
    $("#route-demo")?.addEventListener("toggle", (event) => {
      if (!event.currentTarget.open && previewing) pausePreview();
    });
    $("#route-progress-position")?.addEventListener("input", (event) => {
      pausePreview(false);
      automatic = false;
      onPauseFollowing?.();
      const section = guide.sections[guideSection];
      if (!section) return;
      guideDistance =
        (section.length *
          Math.max(0, Math.min(1000, Number(event.currentTarget.value) || 0))) /
        1000;
      guiding = true;
      applyGuidance({ animate: false });
      updateProgressReadout();
    });
    $("#route-next-section")?.addEventListener("click", () => {
      if (
        !sampleRouteGuidance(guide, guideSection, guideDistance)?.atEnd ||
        guideSection >= guide.sections.length - 1
      )
        return;
      pausePreview(false);
      automatic = false;
      onPauseFollowing?.();
      guideSection++;
      guideDistance = 0;
      guiding = true;
      applyGuidance({ animate: true });
      renderSteps();
    });
    updateProgressReadout();
  }

  function updateProgressReadout() {
    const sample = sampleRouteGuidance(guide, guideSection, guideDistance);
    if (!sample || !route) return;
    $("#route-panel").dataset.guiding = String(guiding);
    if (document.body) document.body.dataset.routeNavigation = String(guiding);
    if (nextInterface) scene.setNavigationMode?.(Boolean(route && guiding));
    const label = $("#route-progress-label");
    if (label)
      label.textContent = `Участок ${guideSection + 1} из ${guide.sections.length} · ${Math.round(sample.progress * 100)}%`;
    const slider = $("#route-progress-position");
    if (slider) slider.value = String(Math.round(sample.progress * 1000));
    const guidanceStatus = $("#route-guidance-status");
    if (guidanceStatus)
      guidanceStatus.textContent = previewing
        ? "Демонстрация · указатель движется по схеме"
        : "Демонстрация · положение указателя задаётся вручную";
    const next = $("#route-next-section");
    if (next)
      next.hidden = !sample.atEnd || guideSection >= guide.sections.length - 1;
    const play = $("#route-preview-play");
    if (play)
      play.textContent = previewing
        ? "Пауза"
        : sample.atEnd
          ? "Повторить участок"
          : "Показать";
    updateDockReadout();
    for (const button of $("#route-steps").children)
      button.classList.toggle(
        "active",
        Number(button.dataset.step) === stepIndex,
      );
  }

  function pausePreview(render = true) {
    previewRevision++;
    previewing = false;
    if (previewFrame != null && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(previewFrame);
    previewFrame = null;
    previewTimestamp = null;
    if (render && route) renderProgress();
  }

  function applyGuidance({
    animate = false,
    keepStep = false,
    keepCamera = false,
  } = {}) {
    const sample = sampleRouteGuidance(guide, guideSection, guideDistance);
    if (!sample) return null;
    if (
      (scene.routeOverview ||
        (scene.mode && scene.mode !== "floor") ||
        (state.mode && state.mode !== "floor") ||
        state.floor?.id !== sample.floorId) &&
      !viewFloor(sample.floorId, false, { keepCamera })
    )
      return null;
    if (!keepStep) stepIndex = sample.stepIndex;
    onFloorContext?.(
      sample,
      route.segments[sample.sourceSegmentIndex]?.nodes || [],
    );
    if (automatic) {
      scene.setRoutePreviewProgress?.(null);
      if (
        scene.setRouteGuidance?.(sample, {
          padding: padding(),
          animate,
          keepCamera,
          showMarker: false,
        }) === false
      )
        return null;
      updateProgressReadout();
      return sample;
    }
    if (
      scene.setRouteGuidance?.(sample, {
        padding: padding(),
        animate,
        keepCamera,
      }) === false
    )
      return null;
    scene.setRoutePreviewProgress?.({ ...sample, nextStepIndex: stepIndex });
    updateProgressReadout();
    return sample;
  }

  function playPreview() {
    const section = guide.sections[guideSection];
    if (!section || typeof requestAnimationFrame !== "function") return;
    pausePreview(false);
    automatic = false;
    if (state.routeSnapEnabled) scene.refreshUserLocation?.();
    onPauseFollowing?.();
    guiding = true;
    if (guideDistance >= section.length) guideDistance = 0;
    if (!applyGuidance({ animate: true })) return;
    previewing = true;
    resetRouteDisplay();
    const activePreview = previewRevision;
    const navigationRevision = state.loading;
    renderProgress();
    const frame = (timestamp) => {
      if (!previewing || !route || activePreview !== previewRevision) return;
      // Navigation outside the route controller must remain the user's choice.
      // A queued frame cannot bring an overview, selected room or other floor
      // back to the preview's floor.
      if (
        state.campus?.id !== route.campusId ||
        state.loading !== navigationRevision ||
        state.floor?.id !== section.floorId ||
        (state.mode && state.mode !== "floor") ||
        state.selected ||
        scene.routeOverview
      ) {
        pausePreview();
        scene.setRouteGuidance?.(null);
        return;
      }
      // A backgrounded tab never jumps forward on its first visible frame.
      const elapsed =
        previewTimestamp == null
          ? 0
          : Math.max(0, Math.min(0.1, (timestamp - previewTimestamp) / 1000));
      previewTimestamp = timestamp;
      guideDistance = Math.min(section.length, guideDistance + elapsed * 2.2);
      const sample = applyGuidance();
      if (!sample || sample.atEnd) {
        pausePreview(false);
        renderProgress();
        return;
      }
      previewFrame = requestAnimationFrame(frame);
    };
    previewFrame = requestAnimationFrame(frame);
  }
  async function build() {
    if (!from || !to) {
      status("Выберите начало и конец из результатов поиска.", true);
      experience.expand(true);
      return;
    }
    if (
      from.kind === "user-location" &&
      from.location?.source === "gps" &&
      (from.snapToRoute || state.routeSnapEnabled)
    ) {
      const freshOrigin = currentOriginResult();
      if (!freshOrigin.ok) {
        useCurrentLocation({ open: false });
        return;
      }
      from = freshOrigin.endpoint;
    }
    closeResults();
    closeRoom();
    if (from.campusId !== to.campusId) {
      status(
        "Для разных площадок нужен внешний маршрут. Выберите точки на одной площадке.",
        true,
      );
      return;
    }
    pausePreview();
    const id = ++revision;
    const a = from,
      b = to;
    $("#route-build").disabled = true;
    $("#route-build").textContent = "Ищем путь…";
    status("Проверяем связи помещений и переходы между этажами…");
    try {
      if (state.campus.id !== a.campusId && !(await loadCampus(a.campusId)))
        throw Error("Не удалось открыть площадку");
      const campusRevision = state.loading;
      const result = await calculate(a, b, id);
      if (id !== revision) return;
      if (state.loading !== campusRevision || state.campus.id !== a.campusId) {
        status("Карта изменилась во время расчёта. Постройте маршрут ещё раз.");
        return;
      }
      if (!result.ok) {
        status(result.message, true);
        experience.expand(true);
        return;
      }
      route = result;
      guide = createRouteGuidance(result);
      liveTracker = createRouteTracker(result);
      liveProgress = null;
      resetAcceptedProgress();
      automatic = false;
      guideSection = guideDistance = 0;
      stepIndex = 0;
      guiding = false;
      $("#route-panel").dataset.complete = "true";
      $("#route-share").hidden =
        a.kind === "user-location" || b.kind === "user-location";
      const partial = partialRouteInfo(result);
      const originFloorNote =
        a.snapToRoute && a.location.floorEvidence === "manual-view-selection"
          ? '<p class="route-estimate">Начало привязано к проходу на открытом плане. GPS не определяет этаж.</p>'
          : "";
      $("#route-summary").innerHTML =
        `<div class="route-summary-head">${icon("route", 30)}<div><b>${result.durationMinutes != null ? `≈ ${result.durationMinutes} мин` : "Путь найден"}</b><small>${escape(a.label)} → ${escape(partial?.via || b.label)}${result.distanceMeters != null ? ` · ≈ ${Math.round(result.distanceMeters)} м` : ""}</small></div></div>${partial ? `<p class="route-estimate">${escape(partial.summary)} ${escape(partial.note)}</p>` : ""}${originFloorNote}<p class="route-estimate">${escape(result.durationModel || "Время и расстояние оценочные.")}</p><div id="route-floor-chips" class="route-floor-chips" aria-label="Этажи маршрута"></div><div id="route-progress" class="route-progress"></div>`;
      for (const key of ["route-summary", "route-steps", "route-actions"])
        $("#" + key).hidden = false;
      status(
        partial?.summary ||
          "Маршрут готов. Проходы и доступность на месте могут изменяться.",
      );
      minimizePanel();
      renderSteps();
      viewFloor(route.segments[0].floorId, !guide.sections.length);
      if (state.routeSnapEnabled && guide.sections.length) startGuidance();
      else if (guide.sections.length) applyGuidance({ animate: true });
      saveView();
    } catch (error) {
      if (id === revision) status(error.message, true);
    } finally {
      if (id === revision) {
        $("#route-build").disabled = false;
        $("#route-build").innerHTML = `${icon("route", 18)}Построить маршрут`;
      }
    }
  }
  $("#route-build").onclick = build;
  $("#route-edit").onclick = () => {
    invalidate();
    updateUI();
    panel(true);
    experience.expand(true);
    focusEndpoint("to");
    $("#route-to").select?.();
  };
  $("#route-fit").onclick = () => {
    pausePreview();
    scene.setRouteGuidance?.(null);
    experience.expand(false);
    if (
      !scene.routeOverview &&
      (scene.mode !== "floor" ||
        !route?.segments.some((s) => s.floorId === state.floor?.id))
    )
      viewFloor(route.segments[0].floorId);
    else scene.focusRoute({ padding: padding() });
  };
  $("#route-clear").onclick = () => clear({ open: true });
  $("#route-share").onclick = () => shareView(location.hash, toast);
  document.addEventListener("click", (event) => {
    // Focusing the other endpoint can replace the clicked suggestion before
    // this listener runs. Its event path still includes the result list.
    const path = event.composedPath();
    // Mobile focus can move the field before the tap's click is delivered.
    // The click may land on the sheet around the still-focused route input.
    if (
      document.activeElement === $("#route-" + activeInput) &&
      path.includes($(".sidebar"))
    )
      return;
    if (
      !path.includes($(".route-inputs")) &&
      !path.includes($("#route-results")) &&
      !path.includes($("#route-open")) &&
      !path.includes($("#route-use-location")) &&
      !path.includes($("#route-edit")) &&
      !path.includes($("#route-clear")) &&
      !path.some((element) =>
        ["room-to", "route-dock-details"].includes(element?.id),
      )
    )
      closeResults();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetRouteDisplay();
      pausePreview();
      resumeAfterTimestamp = Date.now();
    }
    updateLiveGuidance();
  });
  window.addEventListener("atlas:app-state", (event) => {
    if (event.detail?.isActive === false) {
      resetRouteDisplay();
      pausePreview();
    }
    if (automatic && event.detail?.isActive === false) {
      resumeAfterTimestamp = Date.now();
      if (typeof clearTimeout === "function") clearTimeout(liveExpiryTimer);
      liveProgress = { ...liveTracker.snapshot(), status: "stale" };
      if (state.routeSnapEnabled) scene.refreshUserLocation?.();
      updateDockReadout();
    } else updateLiveGuidance();
  });
  window.addEventListener("pagehide", () => {
    resetRouteDisplay();
    pausePreview();
    resumeAfterTimestamp = Date.now();
    if (automatic) {
      if (typeof clearTimeout === "function") clearTimeout(liveExpiryTimer);
      liveProgress = { ...liveTracker.snapshot(), status: "stale" };
      if (state.routeSnapEnabled) scene.refreshUserLocation?.();
      updateDockReadout();
    }
  });
  window.addEventListener("resize", () => {
    if (route) updateDockReadout();
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (automatic) return;
      const section = guide.sections[guideSection];
      if (
        guiding &&
        route &&
        section &&
        scene.mode === "floor" &&
        state.campus?.id === route.campusId &&
        state.floor?.id === section.floorId &&
        !state.selected &&
        !scene.routeOverview
      )
        applyGuidance({ animate: false, keepStep: true });
    });
    observer.observe($(".sidebar"));
    const dock = $("#route-guidance-dock");
    if (dock) observer.observe(dock);
  }
  return {
    getViewportPadding: padding,
    showSearch: () => panel(false),
    getStairAction,
    routeLocationMatch,
    routeSnapChanged() {
      if (
        state.routeSnapEnabled &&
        route &&
        !automatic &&
        guide.sections.length
      )
        startGuidance(stepIndex);
      else {
        if (!state.routeSnapEnabled && automatic) {
          resetRouteDisplay();
          automatic = false;
          liveProgress = null;
          clearTimeout(liveExpiryTimer);
          updateProgressReadout();
        }
        scene.refreshUserLocation?.();
      }
    },
    isFollowingHeading: () =>
      Boolean(
        route &&
          guiding &&
          automatic &&
          !previewing &&
          !document.hidden &&
          !state.selected &&
          state.locationTracking?.enabled &&
          state.locationTracking.following &&
          route.segments.some((segment) => segment.floorId === state.floor?.id),
      ),
    useCurrentLocation,
    locationChanged,
    refreshCurrentOrigin: locationChanged,
    showFloor: viewFloor,
    syncView,
    projectionChanged() {
      if (route) {
        pausePreview(false);
        const floorId = state.floor?.id || route.segments[0].floorId;
        if (guide.sections[guideSection]?.floorId === floorId) {
          viewFloor(floorId, false);
          applyGuidance({ animate: true, keepStep: true });
        } else viewFloor(floorId);
      }
    },
    pauseGuidance: () => pausePreview(),
    setEndpoint: (key, room, { open = true } = {}) => {
      setEndpoint(key, room);
      if (open) {
        panel(true);
        experience.expand(true);
        focusEndpoint(key === "from" ? "to" : "from");
      }
    },
    setOrigin: (room, { open = false } = {}) => {
      setEndpoint("from", room);
      if (open) {
        panel(true);
        experience.expand(true);
        focusEndpoint("to");
      }
    },
    getEndpoints: () => ({ from, to }),
    startGuidance,
    clear: () => clear(),
    build,
    appendURL(params) {
      if (from?.kind !== "user-location" && from?.id)
        params.set("from", from.id);
      else params.delete("from");
      if (to?.kind !== "user-location" && to?.id) params.set("to", to.id);
      else params.delete("to");
    },
    async restore(params) {
      const a = state.search.find((r) => r.id === params.get("from")),
        b = state.search.find((r) => r.id === params.get("to"));
      if (a || b) {
        from = a || null;
        to = b || null;
        $("#route-from").value = from?.label || "";
        $("#route-to").value = to?.label || "";
        panel(true);
        if (a && b) await build();
        else candidates(b ? "from" : "to");
      }
    },
    changedCampus() {
      if (route && route.campusId !== state.campus.id) invalidate();
      if (
        activeInput &&
        !$("#route-panel").hidden &&
        !$("#route-results").hidden
      )
        candidates(activeInput);
    },
    getRoute: () => route,
  };
}
