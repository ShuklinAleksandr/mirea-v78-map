import { $, escape } from "./ui/dom.js";
import { icon } from "./ui/icons.js";
import { layout } from "./ui/layout.js";
import { getJSON } from "./data/client.js";
import { loadBootstrapData } from "./data/bootstrap.js";
import { resolveInitialView } from "./data/navigation.js";
import { bindSearch } from "./ui/search.js";
import { bindExperience, readSaved, shareView } from "./ui/experience.js";
import { bindRoutes } from "./ui/routes.js";
import { bindLocation } from "./ui/location.js";
import { bindWifiSurvey } from "./ui/wifi-survey.js";
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
import { pickLocationSurface } from "./map/location-view.js";
import { getBuildingFloorView } from "./map/building-view.js";

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
  surveyLocation: null,
  locationTracking: null,
};
$("#app").innerHTML = layout;

const searchUI = bindSearch({
  state,
  navigateRoom,
  floorName,
  onOpen: () => {
    dismissRoom();
    experience?.expand(true);
  },
  onLocate: () =>
    state.userLocation?.point
      ? userPosition?.beginPicking()
      : userPosition?.locate(),
  getPosition: () => userPosition?.nearbyOrigin(),
});
let scene, experience, routes, userPosition, wifiSurvey;
try {
  scene = new AtlasScene($("#viewport"), {
    getViewportPadding: () => roomPadding(),
    onMapInteraction: () => {
      routes?.pauseGuidance?.();
      userPosition?.pauseFollowing();
    },
    onRoom: (r) => selectRoom(r),
    onPositionPickPreview: () => userPosition?.previewPicking(),
    onBuilding: (b) => chooseBuilding(b),
    onRouteFloor: (id) =>
      routes?.getRoute()
        ? scene.routeOverview
          ? routes.focusStackFloor(id)
          : routes.showFloor(id)
        : chooseFloor(id),
    onEmpty: () => dismissRoom(),
    onUncertainty: () => toast("Положение этого участка требует уточнения"),
    onExternal: (b) => showExternal(b),
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
  experience = bindExperience({ state, scene, navigateRoom, toast });
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
  userPosition = bindLocation({
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
    allowTrackingPoint: (point, selection) => {
      const source = state.floorData.find((f) => f.id === selection?.floorId);
      if (!source) return false;
      const hall = getHallAdjacencyView(source);
      const floor = selection.building
        ? getBuildingFloorView(hall, selection.building)
        : hall;
      const surface = pickLocationSurface(floor, point, {
        building: selection.building,
        cutouts: getStairDisplayCutouts(floor),
      });
      return Boolean(
        surface &&
          (!Number.isFinite(selection.physicalLevel) ||
            !surface.building ||
            source.buildingLevels?.[surface.building] ===
              selection.physicalLevel) &&
          (!surface.building ||
            !selection.building ||
            surface.building === selection.building),
      );
    },
    onChange: () => {
      searchUI.refreshPosition?.();
      routes?.locationChanged?.();
      wifiSurvey?.refresh();
      if (state.campus) updateUI();
    },
  });
  wifiSurvey = bindWifiSurvey({ state, userPosition, toast });
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
  const railBuilding = state.building || routeBuilding;
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
      if (activeRoute?.segments.some((s) => s.floorId === id))
        scene.routeOverview ? routes.focusStackFloor(id) : routes.showFloor(id);
      else {
        state.building = railBuilding || null;
        chooseFloor(id);
      }
      if (scene.locationPicking) experience.minimize();
      else experience.expand(false);
    };
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
  $("#overview").classList.toggle("active", state.mode === "overview");
  $("#nav-stack").classList.toggle(
    "active",
    Boolean(scene.routeOverview || scene.buildingOverview),
  );
  const activeRoute = routes?.getRoute?.();
  $("#nav-stack").hidden =
    !state.building &&
    new Set(activeRoute?.segments?.map((segment) => segment.floorId) || [])
      .size < 2;
  $("#facades").closest("label").hidden = state.mode !== "overview";
  $("#context").closest("label").hidden = state.mode !== "overview";
  $("#neighbors").closest("label").hidden =
    state.mode !== "floor" || !state.building;
  if (scene.routeOverview || scene.buildingOverview) {
    $("#nav-inside").classList.remove("active");
    $("#nav-outside").classList.remove("active");
  }
  $("#exterior-actions").hidden = state.mode !== "overview";
  for (const b of $("#buildings").children)
    b.classList.toggle("active", b.dataset.building === (state.building || ""));
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
  $("#osm-attribution")?.remove();
  if (
    state.mode === "overview" &&
    state.campus.id === "v-78" &&
    scene.contextOn !== false
  ) {
    const a = document.createElement("a");
    a.id = "osm-attribution";
    a.href = "https://www.openstreetmap.org/copyright";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "© OpenStreetMap contributors";
    $(".map-shell").append(a);
  }
  $("#metric-badge").textContent =
    state.campus.id === "mp-1" ? "Схема ≈" : "Высоты ≈";
  $("#scale-note").textContent =
    state.campus.id === "mp-1"
      ? "Условные единицы · не измерительные данные"
      : "Масштаб источника: метры · высоты приблизительны";
  $("#mode-plan").classList.toggle("active", scene.plan);
  $("#mode-plan").setAttribute("aria-pressed", scene.plan);
  $("#mode-3d").setAttribute("aria-pressed", !scene.plan);
  const touch = matchMedia("(pointer: coarse)").matches;
  $("#interaction-hint").textContent = touch
    ? scene.plan
      ? "Один палец — перемещение · два — масштаб"
      : "Один палец — перемещение · два — поворот и масштаб"
    : scene.plan
      ? "Перетаскивание — перемещение · колесо — масштаб"
      : "Перетаскивание — вращение · ПКМ — перемещение · колесо — масштаб";
  $("#mode-3d").classList.toggle("active", !scene.plan);
  renderFloors();
  const selectedLocation = placeLocation(state.selected, state.floor);
  const focusBuilding = selectedLocation.building || state.building;
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
      : "Обзор кампуса";
  $("#focus-floor-status").innerHTML =
    `${icon("layers", 16)}<span>${escape(level)}</span>`;
  routes?.syncView();
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
    state.mode = "overview";
    $("#address").textContent = campus.address;
    const buildings = [
      ...new Set(
        floors.flatMap((f) =>
          (f.polygons || []).map((p) => p.building).filter(Boolean),
        ),
      ),
    ].sort((a, b) => a.localeCompare(b, "ru"));
    $("#building-count").textContent = `${buildings.length} корпусов`;
    $("#buildings").innerHTML =
      `<button data-building="" class="active">Все</button>` +
      buildings
        .map(
          (b) =>
            `<button data-building="${escape(b)}" aria-label="Корпус ${escape(b)}">${escape(b)}</button>`,
        )
        .join("");
    for (const b of $("#buildings").children)
      b.onclick = () => chooseBuilding(b.dataset.building || null);
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
function chooseBuilding(b) {
  cancelPendingNavigation();
  state.building = b;
  if (state.mode === "overview") {
    closeRoom();
    scene.setOverview(b);
    updateUI();
    saveView();
    return;
  }
  const fs = availableFloors();
  const candidate =
    fs.find((f) => f.id === state.floor?.id) ||
    fs.find((f) => floorPhysical(f, b) === 2) ||
    fs.find((f) => f.level === 1) ||
    fs[0];
  if (candidate) {
    chooseFloor(candidate.id);
    if (scene.locationPicking) experience.minimize();
  }
}
function chooseFloor(id, { fit = true, navigationToken = null } = {}) {
  if (navigationToken == null) cancelPendingNavigation();
  else if (navigationToken !== state.loading) return false;
  busy(false);
  const floor = state.floorData.find((f) => f.id === id);
  if (!floor) return false;
  state.floor = { ...floor, ...state.campus.floors.find((f) => f.id === id) };
  state.mode = "floor";
  closeRoom();
  const keepPicking = Boolean(scene.locationPicking);
  scene.setFloor(state.floor, state.building, { fit });
  if (keepPicking) scene.setLocationPicking(true);
  updateUI();
  saveView();
  return true;
}
function overview() {
  cancelPendingNavigation();
  userPosition?.cancelPicking();
  if (!state.campus) return;
  busy(false);
  state.mode = "overview";
  state.building = null;
  state.floor = null;
  closeRoom();
  scene.setOverview();
  updateUI();
  saveView();
}
function saveView() {
  const p = new URLSearchParams({
    campus: state.campus.id,
    view: state.mode,
    projection: scene.plan ? "2d" : "3d",
  });
  if (state.building) p.set("building", state.building);
  if (state.floor) p.set("floor", state.floor.id);
  routes?.appendURL(p);
  if (state.selected?.id) p.set("room", state.selected.id);
  history.replaceState(null, "", `#${p}`);
}
function showExternal(b) {
  state.selected = null;
  $(".sidebar").dataset.place = "true";
  $("#room-card").hidden = false;
  $("#room-card").innerHTML =
    `<button class="card-close icon-button" aria-label="Закрыть карточку">${icon("close", 17)}</button><div class="eyebrow">Рядом с кампусом</div><h2>${escape(b.name)}</h2><p class="room-location">${escape(b.address || "Площадка Вернадского, 78")}</p><p class="room-note">Внутренняя карта этого здания пока недоступна.</p>`;
  $(".card-close").onclick = dismissRoom;
  saveView();
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
  const panel = $(".sidebar").getBoundingClientRect();
  return innerWidth <= 700
    ? {
        top: 164,
        bottom: Math.max(0, innerHeight - panel.top + 16),
        left: 64,
        right: 64,
      }
    : {
        top: 110,
        bottom: 90,
        left: Math.max(390, panel.right + 24),
        right: 90,
      };
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
  const card = $("#room-card");
  card.hidden = false;
  $(".sidebar").dataset.place = "true";
  const stairTargets = (room.targets || [])
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
        label:
          physical != null
            ? `${physical === -1 ? "Цоколь" : `${physical} этаж`}${targetLocation.building ? ` корпуса ${targetLocation.building}` : " · корпус уточняется"}`
            : Number.isFinite(targetFloor?.level)
              ? `Уровень ${targetFloor.level} плана`
              : "Этаж пока недоступен",
      };
    });
  const stairDescription =
    room.note ||
    (stairTargets.length
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
  const availableTargets = stairTargets.filter(
    (target, index, targets) =>
      target.targetFloor &&
      target.targetMarker &&
      targets.findIndex(
        (other) =>
          other.floorId === target.floorId &&
          other.targetMarker?.id === target.targetMarker.id,
      ) === index,
  );
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
              `<button data-target="${i}">↕ ${escape(t.label)} →</button>`,
          )
          .join("")}</div>`
      : ""
  }${nearbyStairs.length ? `<div class="stair-targets">${nearbyStairs.map((marker, i) => `<button data-stair-variant="${i}">${escape(marker.destinationLabel || marker.label)} →</button>`).join("")}</div>` : ""}`;
  for (const button of card.querySelectorAll("[data-stair-variant]"))
    button.onclick = () =>
      selectRoom(nearbyStairs[+button.dataset.stairVariant], true);
  for (const b of document.querySelectorAll("[data-target]"))
    b.onclick = () => {
      const t = availableTargets[+b.dataset.target];
      if (!t?.targetFloor || !t.targetMarker) return;
      const previousBuilding = state.building;
      // The source stair's selected wing does not establish the destination's
      // ownership or physical floor (e.g. the library corridor at edge 20734).
      state.building = t.targetBuilding;
      if (!chooseFloor(t.floorId, { fit: false })) {
        state.building = previousBuilding;
        return;
      }
      selectRoom(t.targetMarker, true);
    };
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
        if (!routes.getEndpoints().from)
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

$("#overview").onclick = overview;
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
$("#mode-plan").onclick = () => {
  if (!scene.plan) scene.setProjection(true);
  routes?.projectionChanged();
  updateUI();
  saveView();
};
$("#mode-3d").onclick = () => {
  if (scene.plan) scene.setProjection(false);
  routes?.projectionChanged();
  updateUI();
  saveView();
};
$("#context").onchange = () => {
  scene.contextOn = $("#context").checked;
  if (state.mode === "overview") scene.setOverview();
  updateUI();
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
  if (
    state.mode === "floor" &&
    state.floor &&
    !scene.routeOverview &&
    !scene.buildingOverview
  )
    return true;
  const fs = availableFloors();
  const f =
    fs.find((f) => floorPhysical(f) === 2) ||
    fs.find((f) => f.level === 1) ||
    fs[0];
  if (f) chooseFloor(f.id);
}
$("#neighbors").onchange = () => {
  scene.neighborsOn = $("#neighbors").checked;
  if (state.mode === "floor")
    scene.setFloor(state.floor, state.building, { fit: false });
};
$("#nav-outside").onclick = overview;
$("#nav-inside").onclick = openInterior;
$("#nav-stack").onclick = () => {
  if (routes?.getRoute()) {
    $("#route-all-floors")?.click();
    return;
  }
  if (!state.building) {
    toast("Выберите корпус на карте или в панели поиска");
    experience.expand(true);
    return;
  }
  if (!state.floor) openInterior();
  scene.setBuildingOverview?.(state.building, {
    padding:
      innerWidth <= 700
        ? {
            top: 170,
            bottom: Math.min(
              $(".sidebar").getBoundingClientRect().height + 24,
              innerHeight * 0.55,
            ),
            left: 30,
            right: 70,
          }
        : { top: 100, bottom: 110, left: 390, right: 80 },
  });
  updateUI();
  $("#nav-stack").classList.add("active");
  $("#nav-inside").classList.remove("active");
  $("#focus-floor-status").innerHTML =
    `${icon("layers", 16)}<span>Корпус ${escape(state.building)} · этажи</span><small>Высоты приблизительные</small>`;
  saveView();
};
$("#open-interior").onclick = openInterior;
new ResizeObserver(() => {
  if (state.selected && state.mode === "floor")
    scene.selectRoom(state.selected, { focus: true, padding: roomPadding() });
}).observe($(".sidebar"));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap, #place-categories")) {
    searchUI.close();
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "SELECT"].includes(document.activeElement.tagName) &&
    !$("dialog[open]")
  ) {
    e.preventDefault();
    $("#explore-tab").click();
    $("#search").focus();
  }
  if (e.key === "Escape" && !$("dialog[open]")) dismissRoom();
});

async function boot() {
  try {
    const initial = new URLSearchParams(location.hash.slice(1));
    const data = await loadBootstrapData();
    const {
      manifest,
      assumptions,
      photos,
      exterior,
      context,
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
    scene.setExterior(exterior, context, facadeStyle, hall, special);
    const restored = resolveInitialView(initial, manifest);
    if (!restored || !(await loadCampus(restored.campusId))) return;
    state.building = restored.building;
    if (restored.mode === "floor")
      chooseFloor(restored.floorId, { navigationToken: state.loading });
    else if (restored.building) scene.setOverview(restored.building);
    if (restored.projection === "2d") {
      scene.setProjection(true, { fit: true });
    }
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
    saveView();
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
