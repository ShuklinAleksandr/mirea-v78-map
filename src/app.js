import { $, escape } from "./ui/dom.js";
import { icon } from "./ui/icons.js";
import { layout } from "./ui/layout.js";
import {
  initializeInterface,
  getInterfaceVariant,
  isNextInterface,
  getInterfaceStorage,
} from "./ui/variant.js";
import "./ui/interface-comparison.css";
import "./ui/next-route.css";
import { bindBuildingRooms } from "./ui/building-rooms.js";
import "./ui/building-rooms.css";
import { getJSON } from "./data/client.js";
import { loadBootstrapData } from "./data/bootstrap.js";
import { mainEntranceFraming, resolveInitialView } from "./data/navigation.js";
import { mergedFloorView } from "./data/floor-view.js";
import {
  resolveFloorContext,
  resolveGpsFloorContext,
  resolveRouteFloorContext,
} from "./data/floor-context.js";
import { bindSearch } from "./ui/search.js";
import { bindExperience, readSaved, shareView } from "./ui/experience.js";
import { bindRoutes } from "./ui/routes.js";
import { bindLocation } from "./ui/location.js";
import { bindCleanMap } from "./ui/clean-map.js";
import { bindMapHud } from "./ui/map-hud.js";
import { bindDesktopNavigation } from "./ui/desktop.js";
import { isCurrentUserLocation } from "./data/user-location.js";
import { resolveRoom, geometryEvidence } from "./data/utils.js";
import {
  placeDescription,
  placeLocation,
  presentPlaceIdentity,
} from "./data/place-location.js";
import placeLandmarks from "./data/place-landmarks.json" with { type: "json" };
import {
  getMapStairMarkers,
  presentStairIdentity,
  resolveStairTarget,
  getStairDisplayCutouts,
  withConfirmedStairSearch,
} from "./map/stairs.js";
import { AtlasScene } from "./map/scene.js";
import { getHallAdjacencyView } from "./map/hall-adjacency.js";
import { entranceHint } from "./data/entrance-hints.js";
import { pickLocationSurface } from "./map/location-view.js";
import { getBuildingFloorView } from "./map/building-view.js";
import {
  isCompactLandscape,
  landscapeMapPadding,
  portraitMapPadding,
  desktopMapPadding,
} from "./ui/map-viewport.js";

const state = {
  campus: null,
  floor: null,
  building: null,
  mode: "overview",
  floorData: [],
  selected: null,
  labels: true,
  photos: [],
  manifest: null,
  search: [],
  loading: 0,
  userLocation: null,
  floorContext: null,
  locationTracking: null,
  neighborsPreference: null,
};
let lastCameraFloorProbe = null;
let floorContextOwner = "camera";
$("#app").innerHTML = layout;
initializeInterface();
bindBuildingRooms({
  state,
  navigateRoom,
  getBuilding: () => floorContextBuilding(),
});

const searchUI = bindSearch({
  state,
  navigateRoom,
  floorName,
  onOpen: () => {
    dismissRoom();
    experience?.expand(true);
  },
  onFinishEditing: () => experience?.finishInputEditing(),
  onLocate: () =>
    state.userLocation?.point
      ? userPosition?.beginPicking()
      : userPosition?.locate(),
  getPosition: () => userPosition?.nearbyOrigin(),
});
let scene, experience, routes, userPosition, mapHud;
try {
  scene = new AtlasScene($("#viewport"), {
    interfaceVariant: getInterfaceVariant(),
    getViewportPadding: () =>
      isNextInterface() && routes?.getRoute()
        ? routes.getViewportPadding()
        : roomPadding(),
    shouldFollowHeading: () => routes?.isFollowingHeading(),
    shouldFollowRouteCamera: () => routes?.isFollowingHeading(),
    shouldFollowUserLocation: () =>
      state.locationTracking?.enabled && state.locationTracking.following,
    shouldFollowRouteLine: () => state.routeSnapEnabled,
    getRouteLocationMatch: (location) => routes?.routeLocationMatch(location),
    getResizePadding: () =>
      routes?.getRoute() ? routes.getViewportPadding() : roomPadding(),
    onMapInteraction: () => {
      floorContextOwner = "camera";
      userPosition?.pauseFollowing();
      routes?.pauseGuidance?.();
    },
    onFrame: () => refreshCameraFloorContext(),
    onMapTap: () => mapHud?.onMapTap(),
    onRoom: (r) => selectRoom(r),
    getStairTargets: stairTargetsFor,
    onStairTarget: (target) => openStairTarget(target, { keepCamera: true }),
    getRouteStairAction: () => routes?.getStairAction(),
    onPositionPickPreview: () => userPosition?.previewPicking(),
    onBuilding: (b) => chooseBuilding(b),
    onRouteFloor: (id) =>
      routes?.getRoute()
        ? routes.showFloor(id, false, { keepCamera: true })
        : chooseFloor(id, { keepCamera: true }),
    onEmpty: () => dismissRoom(),
    onUncertainty: () => toast("Положение этого участка требует уточнения"),
    onHover: (r) => {
      const tip = $("#hover-tip");
      tip.hidden = !r?.label;
      tip.textContent = r?.label || "";
    },
  });
} catch (e) {
  showError(
    "Не удалось запустить WebGL. Откройте карту в браузере с аппаратным ускорением.",
    e,
  );
}
if (scene) {
  bindCleanMap(scene, () => userPosition?.cancelPicking());
  experience = bindExperience({
    state,
    scene,
    navigateRoom,
    toast,
    onRouteSnapChange: () => routes?.routeSnapChanged(),
    onOpenSearch: () => routes?.showSearch(),
  });
  routes = bindRoutes({
    state,
    scene,
    loadCampus,
    chooseFloor,
    closeRoom,
    toast,
    experience,
    saveView,
    updateUI,
    getUserOrigin: () => userPosition?.routeOrigin(),
    onLocate: () => userPosition?.locate(),
    onPauseFollowing: () => userPosition?.pauseFollowing(),
    getLiveFloorContext: (location) =>
      state.mode === "floor" && state.campus?.id === location?.campusId
        ? resolveGpsFloorContext(state.floor, location)
        : null,
    onFloorContext: (sample, nodes) => {
      if (sample.floorId !== state.floor?.id) return;
      floorContextOwner = "route";
      const context =
        resolveRouteFloorContext(state.floor, sample.position, nodes) ||
        resolveFloorContext(state.floor, sample.position);
      applyFloorContext(context, "route");
    },
    onConfirmFloor: (selection) => userPosition?.confirmRouteFloor(selection),
    onRefineLocation: () =>
      userPosition?.beginPicking({
        onPicked: () => {
          const destination = routes.getEndpoints().to;
          if (
            routes.useCurrentLocation?.({ open: !destination }) &&
            destination
          )
            routes.build();
        },
      }),
  });
  bindDesktopNavigation({ experience, dismissRoom });
  userPosition = bindLocation({
    surveyStorage: getInterfaceStorage(),
    state,
    scene,
    experience,
    routes,
    closeRoom,
    chooseFloor,
    openForPicking: () => {
      if (state.floor) return chooseFloor(state.floor.id, { fit: false });
      state.building = "А";
      const floor = state.floorData.find((f) => f.buildingLevels?.А === 2);
      return floor ? chooseFloor(floor.id) : false;
    },
    toast,
    allowTrackingPoint: (
      point,
      selection,
      { acrossBuildings = false } = {},
    ) => {
      const source = state.floorData.find((f) => f.id === selection?.floorId);
      if (!source) return false;
      const hall = getHallAdjacencyView(source);
      const building = acrossBuildings ? null : selection.building;
      const floor = building
        ? getBuildingFloorView(hall, selection.building)
        : hall;
      const surface = pickLocationSurface(floor, point, {
        building,
        cutouts: getStairDisplayCutouts(floor),
      });
      return Boolean(
        surface &&
          (acrossBuildings
            ? !surface.building ||
              Number.isFinite(source.buildingLevels?.[surface.building])
            : (!Number.isFinite(selection.physicalLevel) ||
                !surface.building ||
                source.buildingLevels?.[surface.building] ===
                  selection.physicalLevel) &&
              (!surface.building ||
                !selection.building ||
                surface.building === selection.building)),
      );
    },
    onChange: () => {
      searchUI.refreshPosition?.();
      routes?.locationChanged?.();
      refreshLocationFloorContext();
      if (state.campus) updateUI();
    },
  });
  mapHud = bindMapHud(() => scene.invalidate());
}
function showError(message, e) {
  console.error(e);
  $("#loading").hidden = true;
  $("#error").hidden = false;
  $("#error").innerHTML =
    `${icon("info", 30)}<h2>Карта пока недоступна</h2><p>${escape(message)}</p><button onclick="location.reload()">Попробовать снова</button>`;
}
function busy(value, message = "Читаем планы кампуса") {
  $("#loading").hidden = !value;
  $("#load-message").textContent = message;
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 4000);
}
function floorPhysical(f, building = state.building) {
  return f.buildingLevels?.[building] ?? f.level;
}
function floorContextBuilding() {
  const contextual =
    state.floorContext && state.floorContext.floorId === state.floor?.id
      ? state.floorContext.building
      : null;
  return (
    contextual ||
    placeLocation(state.selected, state.floor).building ||
    state.building ||
    null
  );
}
function applyFloorContext(context, source) {
  if (!context?.building || !state.floor || state.mode !== "floor") return;
  if (
    state.floorContext?.floorId === state.floor.id &&
    state.floorContext.building === context.building
  )
    return;
  state.floorContext = { ...context, floorId: state.floor.id, source };
  // This changes the physical-floor readout, never the current plan, geometry,
  // camera, GPS fix, or route. Connecting corridors keep the last clear context.
  renderFloors();
  renderFocusedFloorStatus();
}
function refreshLocationFloorContext() {
  const location = state.userLocation;
  if (
    !location?.point ||
    !state.floor ||
    state.mode !== "floor" ||
    location.campusId !== state.campus?.id ||
    (location.floorId && location.floorId !== state.floor.id)
  )
    return;
  if (
    location.source === "gps" &&
    (!state.locationTracking?.following ||
      scene.locationPicking ||
      state.selected)
  )
    return;
  const context =
    location.source === "gps"
      ? resolveGpsFloorContext(state.floor, location)
      : resolveFloorContext(state.floor, location.point);
  if (!context) return;
  floorContextOwner = "location";
  applyFloorContext(context, "location");
}
function refreshCameraFloorContext() {
  if (
    !scene ||
    floorContextOwner !== "camera" ||
    !state.floor ||
    state.mode !== "floor" ||
    scene.transition ||
    scene.locationPicking ||
    (state.locationTracking?.following && state.locationTracking?.enabled) ||
    routes?.isFollowingHeading?.()
  )
    return;
  const point = scene.floorFocusPoint(roomPadding(), { maxSpan: 120 });
  if (!point) {
    lastCameraFloorProbe = null;
    return;
  }
  const floor = scene.locationFloor || state.floor;
  const last = lastCameraFloorProbe;
  // Rendering can continue for route or HUD updates while the map is still.
  if (
    last?.floor === floor &&
    last.context === state.floorContext &&
    Math.hypot(point[0] - last.point[0], point[1] - last.point[1]) < 0.2
  )
    return;
  applyFloorContext(resolveFloorContext(floor, point), "camera");
  lastCameraFloorProbe = { floor, point, context: state.floorContext };
}
function floorName(f, building = state.building) {
  return building ? `${floorPhysical(f, building)} этаж` : `Уровень ${f.level}`;
}
function availableFloors() {
  if (!state.building) return state.campus.floors;
  return state.campus.floors.filter((f) =>
    state.floorData
      .find((d) => d.id === f.id)
      ?.polygons.some((p) => p.building === state.building),
  );
}
function renderFloors() {
  const activeRoute = routes?.getRoute();
  const routeBuilding = activeRoute?.segments.find(
    (s) => s.floorId === state.floor?.id,
  )?.nodes[0]?.building;
  const railBuilding = floorContextBuilding() || routeBuilding;
  const railFloors = state.campus.floors.filter(
    (f) => !railBuilding || Object.hasOwn(f.buildingLevels || {}, railBuilding),
  );
  $("#floor-rail").hidden = state.mode !== "floor";
  $("#floor-rail").innerHTML =
    `<span>${railBuilding ? "ЭТАЖ" : "УРОВЕНЬ"}</span>` +
    railFloors
      .slice()
      .reverse()
      .map(
        (f) =>
          `<button data-rail-floor="${escape(f.id)}" aria-label="${railBuilding ? "Этаж" : "Уровень плана"} ${floorPhysical(f, railBuilding)}${railBuilding ? ` корпуса ${escape(railBuilding)}` : ""}" aria-pressed="${state.floor?.id === f.id}" class="${state.floor?.id === f.id ? "active" : ""}">${floorPhysical(f, railBuilding)}</button>`,
      )
      .join("");
  for (const button of $("#floor-rail").querySelectorAll("button"))
    button.onclick = () => {
      const id = button.dataset.railFloor;
      if (activeRoute?.segments.some((s) => s.floorId === id)) {
        if (routes.showFloor(id, false, { keepCamera: true }) === false) return;
        floorContextOwner = "selection";
        applyFloorContext(
          {
            building: railBuilding,
            physicalLevel: floorPhysical(state.floor, railBuilding),
          },
          "selection",
        );
      } else {
        state.building = railBuilding || null;
        chooseFloor(id, { keepCamera: true });
      }
    };
  {
    const picker = $("#next-floor-open");
    picker.hidden = state.mode !== "floor";
    const number = floorPhysical(state.floor || {}, railBuilding);
    const description = railBuilding
      ? `Корпус ${railBuilding} · ${number} этаж`
      : `Уровень плана ${state.floor?.level ?? ""}`;
    picker.innerHTML = `${icon("layers", 18)}<span class="floor-picker-number" aria-hidden="true">${number === -1 ? "Ц" : (number ?? "—")}</span><span class="floor-picker-description">${escape(description)}</span><span class="floor-picker-chevron">${icon("down", 16)}</span>`;
    picker.setAttribute("aria-label", `Выбрать этаж. ${description}`);
    picker.title = description;
    $("#next-floor-title").textContent = railBuilding
      ? `Корпус ${railBuilding} · этажи`
      : "Уровни карты";
    $("#next-floor-list").innerHTML = railFloors
      .slice()
      .reverse()
      .map(
        (f) =>
          `<button type="button" data-next-floor="${escape(f.id)}" aria-label="${railBuilding ? `${floorPhysical(f, railBuilding)} этаж корпуса ${escape(railBuilding)}` : `Уровень плана ${f.level}`}" aria-pressed="${state.floor?.id === f.id}"><span class="floor-option-number">${floorPhysical(f, railBuilding) === -1 ? "Ц" : floorPhysical(f, railBuilding)}</span><span class="floor-option-description">${railBuilding ? `${floorPhysical(f, railBuilding)} этаж` : `Уровень плана ${f.level}`}</span>${state.floor?.id === f.id ? "<small>На экране</small>" : ""}</button>`,
      )
      .join("");
    $("#next-floor-rooms").hidden = !railBuilding;
    for (const button of $("#next-floor-list").querySelectorAll("button"))
      button.onclick = () => {
        $("#next-floor-dialog").close();
        const original = [...$("#floor-rail").querySelectorAll("button")].find(
          (item) => item.dataset.railFloor === button.dataset.nextFloor,
        );
        original?.click();
      };
  }
}
function updateUI() {
  if (
    document.body?.dataset?.locationPicking === "true" &&
    !scene.locationPicking
  )
    userPosition?.cancelPicking();
  const building = state.building ? `Корпус ${state.building}` : "Все корпуса";
  $(".map-shell").dataset.mode = state.mode;
  for (const id of ["outside", "inside"])
    $("#nav-" + id).classList.toggle(
      "active",
      state.mode === { outside: "overview", inside: "floor" }[id],
    );
  $("#breadcrumb").innerHTML =
    `${escape(state.campus.title)} <span>/</span> ${escape(building)}${state.mode === "floor" ? ` <span>/</span> ${floorName(state.floor)}` : ""}`;
  $("#campus-overview").hidden = !state.building && state.mode !== "floor";
  $("#facades").closest("label").hidden = state.mode !== "overview";
  $("#neighbors").closest("label").hidden =
    state.mode !== "floor" || !state.building;
  $("#exterior-actions").hidden = state.mode !== "overview";
  $("#building-rooms-open").hidden = !state.building;
  $("#view-eyebrow").textContent =
    state.mode === "overview" ? "ПРОСТРАНСТВО УНИВЕРСИТЕТА" : "ВНУТРИ КАМПУСА";
  $("#view-title").innerHTML =
    state.mode === "overview"
      ? `${escape(state.campus.title)}<span class="title-level">${state.building ? escape(building) : "Внешний вид кампуса"}</span>`
      : `${escape(building)}<span class="title-level">${floorName(state.floor)}</span>`;
  $("#open-interior").hidden = !state.building;
  $("#view-description").textContent =
    state.mode === "overview"
      ? "Выберите корпус, чтобы заглянуть внутрь"
      : "Наведите на помещение или найдите его по номеру";
  $("#caption-title").textContent =
    state.mode === "overview"
      ? "Контуры и связи корпусов"
      : `${building} · ${floorName(state.floor)}`;
  const count =
    state.mode === "floor"
      ? (state.floor.polygons || []).filter(
          (p) => p.label && (!state.building || p.building === state.building),
        ).length
      : state.floorData.reduce(
          (s, f) => s + (f.polygons || []).filter((p) => p.label).length,
          0,
        );
  $("#caption-subtitle").textContent =
    state.mode === "overview"
      ? `${state.campus.floors.length} уровней · ${count} подписанных объектов`
      : `${count} подписанных объектов · верхние этажи скрыты`;
  $("#metric-badge").textContent =
    state.campus.id === "mp-1" ? "Схема ≈" : "Высоты ≈";
  $("#scale-note").textContent =
    state.campus.id === "mp-1"
      ? "Условные единицы · не измерительные данные"
      : "Масштаб источника: метры · высоты приблизительны";

  const modeToggle = $("#mode-toggle");
  modeToggle.setAttribute("aria-pressed", scene.plan);
  modeToggle.textContent = scene.plan ? "2D" : "3D";

  const touch = matchMedia("(pointer: coarse)").matches;
  $("#interaction-hint").textContent = touch
    ? "Один палец — перемещение · щипок — масштаб · разворот двух пальцев — поворот"
    : scene.plan
      ? "Перетаскивание — перемещение · колесо — масштаб"
      : "Перетаскивание — перемещение · ПКМ или Shift — поворот 3D · колесо — масштаб";
  renderFloors();
  renderFocusedFloorStatus();
  routes?.syncView();
}
function renderFocusedFloorStatus() {
  const selectedLocation = placeLocation(state.selected, state.floor);
  const focusBuilding = floorContextBuilding();
  const building = state.building ? `Корпус ${state.building}` : "Все корпуса";
  const focusLocation = focusBuilding
    ? placeLocation({ building: focusBuilding }, state.floor)
    : selectedLocation;
  const level =
    state.mode === "floor"
      ? focusBuilding
        ? focusLocation.physicalLevel == null
          ? focusLocation.summary
          : `${focusLocation.physicalLevel === -1 ? "Цоколь" : `${focusLocation.physicalLevel} этаж`} · корпус ${focusBuilding}`
        : focusLocation.physicalLevel != null
          ? `${focusLocation.physicalLevel} этаж · корпус уточняется`
          : `Уровень плана ${state.floor.level}`
      : state.building
        ? building
        : "Обзор кампуса";
  $("#focus-floor-status").innerHTML =
    `${icon("layers", 16)}<span>${escape(level)}</span>`;
  if (state.mode === "floor" && focusBuilding) {
    const focusedBuilding = `Корпус ${focusBuilding}`;
    const focusedFloor = floorName(state.floor, focusBuilding);
    $("#breadcrumb").innerHTML =
      `${escape(state.campus.title)} <span>/</span> ${escape(focusedBuilding)} <span>/</span> ${focusedFloor}`;
    $("#view-title").innerHTML =
      `${escape(focusedBuilding)}<span class="title-level">${focusedFloor}</span>`;
    $("#caption-title").textContent = `${focusedBuilding} · ${focusedFloor}`;
  }
}
function cancelPendingNavigation() {
  state.loading++;
  busy(false);
}
async function loadCampus(id, { navigationToken = null } = {}) {
  const token = navigationToken ?? ++state.loading;
  if (token !== state.loading) return false;
  busy(true);
  $("#error").hidden = true;
  closeRoom();
  try {
    const campus = state.manifest.campuses.find((c) => c.id === id);
    if (!campus) throw new Error("Кампус отсутствует в доступном каталоге.");
    const floors = await Promise.all(campus.floors.map((f) => getJSON(f.url)));
    if (token !== state.loading) return false;
    state.campus = campus;
    state.floorData = floors;
    state.search = withConfirmedStairSearch(state.search, floors);
    state.building = null;
    state.floor = null;
    state.floorContext = null;
    state.mode = "overview";
    $("#address").textContent = campus.address;
    scene.setCampus(campus, floors);
    if (typeof userPosition !== "undefined") userPosition?.refresh?.();
    if (typeof routes !== "undefined") routes?.changedCampus();
    updateUI();
    busy(false);
    saveView();
    return true;
  } catch (e) {
    if (token !== state.loading) return false;
    showError(e.message, e);
    return false;
  }
}
function revealMap() {
  if (innerWidth <= 700 || isCompactLandscape(innerWidth, innerHeight))
    experience?.minimize?.();
}
function defaultBuildingFloor(floors, building = state.building) {
  if (!building) return null;
  return (
    floors.find((f) => floorPhysical(f, building) === 3) ||
    floors.reduce(
      (highest, f) =>
        !highest ||
        floorPhysical(f, building) > floorPhysical(highest, building)
          ? f
          : highest,
      null,
    )
  );
}
function chooseBuilding(b) {
  cancelPendingNavigation();
  state.building = b;
  revealMap();
  if (state.mode === "overview") {
    closeRoom();
    scene.setOverview(b);
    updateUI();
    saveView();
    return;
  }
  const fs = availableFloors();
  const candidate =
    defaultBuildingFloor(fs, b) ||
    fs.find((f) => f.id === state.floor?.id) ||
    fs.find((f) => floorPhysical(f, b) === 2) ||
    fs.find((f) => f.level === 1) ||
    fs[0];
  if (candidate) {
    chooseFloor(candidate.id);
    if (scene.locationPicking) experience.minimize();
  }
}
function chooseFloor(
  id,
  {
    fit = true,
    preserveViewport = false,
    keepCamera = false,
    navigationToken = null,
    showNeighbors,
  } = {},
) {
  if (navigationToken == null) cancelPendingNavigation();
  else if (navigationToken !== state.loading) return false;
  busy(false);
  const floor = state.floorData.find((f) => f.id === id);
  if (!floor) return false;
  if (typeof showNeighbors === "boolean") {
    scene.neighborsOn = showNeighbors;
    $("#neighbors").checked = showNeighbors;
  }
  state.floor = mergedFloorView(
    floor,
    state.campus.floors.find((f) => f.id === id),
  );
  state.mode = "floor";
  floorContextOwner = "selection";
  state.floorContext = state.building
    ? { floorId: floor.id, building: state.building, source: "selection" }
    : null;
  closeRoom();
  const keepPicking = Boolean(scene.locationPicking);
  scene.setFloor(state.floor, state.building, {
    fit: fit && !preserveViewport && !keepCamera,
    ...(keepCamera ? { keepCamera: true } : {}),
  });
  if (preserveViewport && !keepCamera) scene.keepFloorViewport();
  if (keepPicking) scene.setLocationPicking(true);
  updateUI();
  saveView();
  return true;
}
function overview() {
  cancelPendingNavigation();
  userPosition?.cancelPicking();
  if (!state.campus) return;
  revealMap();
  busy(false);
  state.mode = "overview";
  state.building = null;
  state.floor = null;
  state.floorContext = null;
  closeRoom();
  scene.setOverview();
  updateUI();
  saveView();
}
function saveView({ mainEntrance = false } = {}) {
  const p = new URLSearchParams({
    campus: state.campus.id,
    view: state.mode,
    projection: scene.plan ? "2d" : "3d",
  });
  if (state.building) p.set("building", state.building);
  if (state.floor) p.set("floor", state.floor.id);
  routes?.appendURL(p);
  if (state.selected?.id) p.set("room", state.selected.id);
  history.replaceState(
    mainEntrance ? { atlasMainEntrance: true } : null,
    "",
    `#${p}`,
  );
}
function closeRoom() {
  state.selected = null;
  $("#room-card").hidden = true;
  $(".sidebar").dataset.place = "false";
  scene?.selectRoom(null);
}
function dismissRoom() {
  closeRoom();
  if (state.campus) {
    updateUI();
    saveView();
  }
}
function roomPadding() {
  if (document.body?.dataset.cleanMap === "true")
    return { top: 64, bottom: 16, left: 16, right: 16 };
  if (isCompactLandscape(innerWidth, innerHeight)) return landscapeMapPadding();
  if (innerWidth <= 700) return portraitMapPadding();
  return desktopMapPadding();
}
const kindNames = {
  room: "Аудитория",
  stairs: "Лестница",
  toilet: "Туалет",
  elevator: "Лифт",
  corridor: "Коридор",
  entrance: "Вход",
  cafeteria: "Еда",
  medical: "Медпункт",
  cloakroom: "Гардероб",
  unknown: "Назначение не уточнено",
  hall: "Холл",
};
function stairTargetsFor(room) {
  return (room.targets || [])
    .filter((target) => target.floorId !== state.floor.id)
    .map((target) => {
      const targetFloor = state.floorData.find(
        (floor) => floor.id === target.floorId,
      );
      const resolved = targetFloor
        ? resolveStairTarget(room, state.floor, targetFloor, target)
        : null;
      const targetMarker = targetFloor
        ? presentPlaceIdentity(
            {
              ...(resolved || {
                id: "transition-target",
                label: "Лестничный переход",
                kind: "stairs",
                center: target.center,
                hasPolygon: false,
              }),
              floorId: targetFloor.id,
              campusId: state.campus.id,
            },
            targetFloor,
          )
        : null;
      const targetLocation = targetMarker
        ? placeLocation(targetMarker, targetFloor)
        : null;
      const physical = targetLocation?.physicalLevel;
      return {
        ...target,
        targetFloor,
        targetMarker,
        targetBuilding: targetLocation?.building || null,
        buttonLabel:
          physical === -1
            ? "В цоколь"
            : `На этаж ${physical ?? targetFloor?.level}`,
        label:
          physical != null
            ? `${physical === -1 ? "Цоколь" : `${physical} этаж`}${targetLocation.building ? ` корпуса ${targetLocation.building}` : " · корпус уточняется"}`
            : Number.isFinite(targetFloor?.level)
              ? `Уровень ${targetFloor.level} плана`
              : "Этаж пока недоступен",
      };
    })
    .filter(
      (target, index, targets) =>
        target.targetFloor &&
        target.targetMarker &&
        targets.findIndex(
          (other) =>
            other.floorId === target.floorId &&
            other.targetMarker?.id === target.targetMarker.id,
        ) === index,
    );
}
function openStairTarget(target, { keepCamera = false } = {}) {
  if (!target?.targetFloor || !target.targetMarker) return;
  const previousBuilding = state.building;
  // The source stair's wing does not establish the destination's floor.
  state.building = target.targetBuilding;
  if (!chooseFloor(target.floorId, { fit: false, keepCamera })) {
    state.building = previousBuilding;
    return;
  }
  if (!keepCamera) selectRoom(target.targetMarker, true);
}
function selectRoom(room, focus = true) {
  if (!room || !state.floor || !state.campus || state.mode !== "floor") return;
  room = presentPlaceIdentity(
    presentStairIdentity(
      resolveRoom(getHallAdjacencyView(state.floor), room) || room,
      state.floor,
    ),
    state.floor,
  );
  state.selected = room;
  floorContextOwner = "selection";
  const selectedBuilding = placeLocation(room, state.floor).building;
  if (selectedBuilding)
    state.floorContext = {
      floorId: state.floor.id,
      building: selectedBuilding,
      source: "selection",
    };
  const card = $("#room-card");
  card.hidden = false;
  $(".sidebar").dataset.place = "true";
  const availableTargets = stairTargetsFor(room);
  const stairDescription =
    room.note ||
    (availableTargets.length
      ? "Выберите этаж, чтобы посмотреть продолжение пути."
      : "Переход на другой этаж пока не указан.");
  const evidence =
    room.shapeReviewStatus === "requires-correction" ||
    room.shapeReviewStatus === "user-confirmed-schematic" ||
    room.displayEvidence?.type === "user-confirmed-room-adjacency"
      ? geometryEvidence(room, state.campus).label
      : room.existenceStatus === "user-confirmed-existence"
        ? "Спуск подтверждён командой · форма приблизительная"
        : "Местоположение по плану";
  const placeInfo = placeLocation(room, state.floor, placeLandmarks.hints);
  const nearbyStairs =
    room.kind === "stairs" && room.layoutId && room.center
      ? getMapStairMarkers(state.floor).filter(
          (marker) =>
            marker.layoutId &&
            marker.layoutId !== room.layoutId &&
            marker.center &&
            Math.hypot(
              marker.center[0] - room.center[0],
              marker.center[1] - room.center[1],
            ) < 1,
        )
      : [];
  const description =
    room.kind === "stairs"
      ? stairDescription
      : room.kind === "room"
        ? ""
        : placeDescription(room);
  card.innerHTML = `<button class="card-close icon-button" aria-label="Закрыть карточку">${icon("close", 17)}</button><div class="eyebrow">${escape(kindNames[room.kind] || "Место на карте")}</div><h2>${escape(room.label || "Без подписи")}</h2><p class="room-location">${escape(placeInfo.summary)}</p>${placeInfo.landmark ? `<p class="room-note">${escape(placeInfo.landmark)}</p>` : ""}${description ? `<details class="place-details"><summary>Подробнее о месте</summary><p class="room-note">${escape(description)}</p><p class="source-status">${escape(evidence)}</p></details>` : ""}${
    availableTargets.length
      ? `<div class="stair-targets">${availableTargets
          .map(
            (t, i) =>
              `<button data-target="${i}" title="${escape(t.label)}">${escape(t.buttonLabel)}</button>`,
          )
          .join("")}</div>`
      : ""
  }${nearbyStairs.length ? `<div class="stair-targets">${nearbyStairs.map((marker, i) => `<button data-stair-variant="${i}">${escape(marker.destinationLabel || marker.label)} →</button>`).join("")}</div>` : ""}`;
  for (const button of card.querySelectorAll("[data-stair-variant]"))
    button.onclick = () =>
      selectRoom(nearbyStairs[+button.dataset.stairVariant], true);
  for (const b of card.querySelectorAll("[data-target]"))
    b.onclick = () => openStairTarget(availableTargets[+b.dataset.target]);
  const indexed = state.search?.find(
    (r) => r.id === room.roomId || r.id === room.id,
  ) || { ...room, campusId: state.campus.id, floorId: state.floor.id };
  if (typeof experience !== "undefined" && experience) {
    experience.remember(indexed);
    const actions = document.createElement("div");
    actions.className = "room-actions";
    const displayOnly =
      room.routingStatus === "display-only-no-source-transition";
    actions.innerHTML = displayOnly
      ? ""
      : '<button id="room-from">Я здесь</button><button id="room-to">Маршрут сюда</button>';
    card.querySelector(".room-location").after(actions);
    const utilities = document.createElement("div");
    utilities.className = "room-utilities";
    utilities.innerHTML = `<button id="room-favorite">${icon("star", 16)}${readSaved("favorites", []).includes(indexed.id) ? "В избранном" : "В избранное"}</button><button id="room-share">${icon("share", 16)}Поделиться</button>`;
    actions.after(utilities);
    const entrance = isNextInterface() ? entranceHint(indexed) : null;
    if (entrance) {
      const hint = document.createElement("div");
      hint.className = "entrance-hint";
      hint.innerHTML = `<strong>${escape(entrance.label)}</strong><p>${escape(entrance.note)}</p>`;
      const via = state.search.find((item) => item.id === entrance.viaRoomId);
      if (via) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "secondary-button";
        open.textContent = `Показать ${entrance.viaLabel}`;
        open.onclick = () => navigateRoom(via);
        hint.append(open);
      }
      actions.before(hint);
    }
    if (!displayOnly)
      $("#room-from").onclick = () => {
        if (userPosition.setPlace(indexed)) {
          dismissRoom();
          experience.minimize();
          scene.focusUserLocation();
        }
      };
    if (!displayOnly)
      $("#room-to").onclick = () => {
        if (
          !routes.getEndpoints().from &&
          (innerWidth <= 700 ||
            isCompactLandscape(innerWidth, innerHeight) ||
            isCurrentUserLocation(state.userLocation))
        )
          routes.useCurrentLocation?.({ open: false, quiet: true });
        const hasOrigin = Boolean(routes.getEndpoints().from);
        routes.setEndpoint("to", indexed, { open: !hasOrigin });
        if (hasOrigin) routes.build();
        else $("#route-from").focus();
      };
    $("#room-favorite").onclick = () => {
      const saved = experience.favorite(indexed);
      $("#room-favorite").innerHTML =
        `${icon("star", 16)}${saved ? "В избранном" : "В избранное"}`;
    };
    $("#room-share").onclick = () => {
      saveView();
      shareView(location.hash, toast);
    };
    experience.expand(false);
    saveView();
  }
  $(".card-close").onclick = dismissRoom;
  scene.selectRoom(room, { focus, padding: roomPadding() });
  updateUI();
}
async function navigateRoom(r) {
  const token = ++state.loading;
  $("#results").hidden = true;
  if (r.campusId !== state.campus?.id) {
    if (!(await loadCampus(r.campusId, { navigationToken: token })))
      return false;
  }
  if (token !== state.loading || r.campusId !== state.campus?.id) return false;
  const targetFloor = state.floorData.find((f) => f.id === r.floorId);
  if (!targetFloor) return false;
  // A numbered facility can name its own wing even when the source catalog's
  // building field is empty. A nearby landmark never supplies this identity.
  state.building = placeLocation(r, targetFloor).building;
  if (!chooseFloor(r.floorId, { fit: false, navigationToken: token }))
    return false;
  const polygon = resolveRoom(state.floor, r);
  selectRoom(polygon || r, true);
  $("#search").value = r.label;
  return true;
}

$("#campus-overview").onclick = overview;
$("#next-floor-open").onclick = () => $("#next-floor-dialog").showModal();
$("#next-floor-close").onclick = () => $("#next-floor-dialog").close();
$("#next-floor-dialog").addEventListener("click", (event) => {
  if (event.target === $("#next-floor-dialog")) event.target.close();
});
$("#next-floor-rooms").onclick = () => {
  $("#next-floor-dialog").close();
  $("#building-rooms-open").click();
};
$(".brand").onclick = (e) => {
  e.preventDefault();
  overview();
};
$("#fit").onclick = () =>
  scene.fit(
    state.building
      ? scene.boundsForBuilding(
          state.building,
          state.mode === "floor" ? state.floor : null,
        )
      : null,
    false,
    roomPadding(),
  );
$("#zoom-in").onclick = () => scene.zoom(0.75);
$("#zoom-out").onclick = () => scene.zoom(1.33);
$("#labels").onchange = () => {
  scene.labelsOn = $("#labels").checked;
  scene.invalidate();
};
$("#mode-toggle").onclick = () => {
  scene.setProjection(!scene.plan);
  routes?.projectionChanged();
  updateUI();
  saveView();
};
$("#facades").onchange = () => {
  scene.facadesOn = $("#facades").checked;
  if (state.mode === "overview") scene.setOverview();
};
$("#street-view").onclick = () => {
  scene.streetView();
  updateUI();
  saveView();
};
$("#aerial-view").onclick = () => scene.fit();
function openInterior() {
  if (state.mode === "floor" && state.floor) return true;
  const fs = availableFloors();
  const f =
    defaultBuildingFloor(fs) ||
    fs.find((f) => floorPhysical(f) === 2) ||
    fs.find((f) => f.level === 1) ||
    fs[0];
  if (!f) return false;
  return chooseFloor(f.id, {
    preserveViewport: state.mode === "overview",
    // The outside building is a camera focus, not a request to remove the rest
    // of this source plan. A later explicit visibility choice wins in this session.
    showNeighbors: state.neighborsPreference ?? true,
  });
}
$("#neighbors").onchange = () => {
  state.neighborsPreference = $("#neighbors").checked;
  scene.neighborsOn = state.neighborsPreference;
  if (state.mode === "floor")
    scene.setFloor(state.floor, state.building, { fit: false });
};
$("#nav-outside").onclick = overview;
$("#nav-inside").onclick = openInterior;
$("#open-interior").onclick = openInterior;
new ResizeObserver(() => {
  if (state.selected && state.mode === "floor")
    scene.selectRoom(state.selected, { focus: true, padding: roomPadding() });
}).observe($(".sidebar"));
document.addEventListener("click", (e) => {
  if (
    !e.target.closest(
      ".search-wrap, #place-categories, #sheet-toggle, #route-back-search, #desktop-search",
    )
  ) {
    searchUI.close();
  }
});

function restoreInitialCamera(view) {
  const source = state.floorData.find((floor) => floor.id === view.floorId);
  const entranceBounds = view.focusMainEntrance
    ? mainEntranceFraming(source)
    : null;
  if (entranceBounds) revealMap();
  if (view.mode === "floor")
    chooseFloor(view.floorId, {
      fit: !entranceBounds,
      navigationToken: state.loading,
    });
  else if (view.building) scene.setOverview(view.building);
  if (view.projection === "2d")
    scene.setProjection(true, { fit: !entranceBounds });
  if (entranceBounds)
    scene.fit(entranceBounds, false, roomPadding(), {
      direction: [0.08, 1.3, 1],
    });
  return Boolean(entranceBounds);
}

async function boot() {
  try {
    const initial = new URLSearchParams(location.hash.slice(1));
    const resumeMainEntrance = history.state?.atlasMainEntrance === true;
    const data = await loadBootstrapData();
    const {
      manifest,
      assumptions,
      photos,
      exterior,
      nearbyRoads,
      facadeStyle,
      hall,
      special,
    } = data;
    state.manifest = manifest;
    state.search = data.search.map((place) =>
      presentPlaceIdentity(presentStairIdentity(place)),
    );
    state.photos = Array.isArray(photos)
      ? photos
      : photos.photos || photos.images;
    scene.setAssumptions(assumptions);
    scene.setExterior(exterior, facadeStyle, hall, special, nearbyRoads);
    const restored = resolveInitialView(initial, manifest, {
      resumeMainEntrance,
    });
    if (!restored || !(await loadCampus(restored.campusId))) return;
    state.building = restored.building;
    const mainEntrance = restoreInitialCamera(restored);
    updateUI();
    searchUI.renderCategories();
    experience.renderSaved();
    const initialRoom =
      state.search.find((r) => r.id === initial.get("room")) ||
      (state.floor &&
        getMapStairMarkers(state.floor).find(
          (marker) =>
            marker.id === initial.get("room") ||
            marker.sourceIds?.includes(initial.get("room")) ||
            marker.graphAnchors?.some(
              (anchor) => anchor.id === initial.get("room"),
            ),
        ));
    if (initialRoom) await navigateRoom(initialRoom);
    await routes.restore(initial);
    saveView({ mainEntrance });
    if (data.unavailable.length)
      toast(
        "Часть дополнительных материалов недоступна. Поиск и карта этажей работают.",
      );
    window.__atlas = {
      state,
      scene,
      routes,
      getStats: () => scene.stats(),
      navigateRoom,
      chooseFloor,
      chooseBuilding,
      overview,
    };
  } catch (e) {
    showError(e.message, e);
  }
}
export function startApp() {
  if (scene) boot();
}
