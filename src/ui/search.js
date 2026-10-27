import { icon } from "./icons.js";
import { $, escape } from "./dom.js";
import {
  findPlaces,
  PLACE_CATEGORIES,
  categoryForPlaceQuery,
  placeCategory,
} from "../data/place-search.js";
import { placeLocation, presentPlaceIdentity } from "../data/place-location.js";
import {
  rankNearbyPlaces,
  nearbyDistanceLabel,
} from "../data/nearby-places.js";
import placeLandmarks from "../data/place-landmarks.json" with { type: "json" };

export function bindSearch({
  state,
  navigateRoom,
  onOpen,
  onLocate,
  getPosition,
}) {
  let category = null,
    expanded = false,
    revision = 0,
    worker = null;
  const pending = new Map();

  function close() {
    revision++;
    $("#results").hidden = true;
    $("#search-status").textContent = "";
    $("#search").setAttribute("aria-expanded", "false");
  }

  function requestNearby(records, position, id) {
    if (typeof Worker !== "function") return Promise.resolve(null);
    if (!worker) {
      try {
        worker = new Worker(
          new URL("../data/nearby-worker.js", import.meta.url),
          { type: "module" },
        );
      } catch {
        return Promise.resolve(null);
      }
      worker.onmessage = ({ data }) => {
        pending.get(data.id)?.(data.error ? null : data.result);
        pending.delete(data.id);
      };
      worker.onerror = () => {
        for (const resolve of pending.values()) resolve(null);
        pending.clear();
        worker.terminate();
        worker = null;
      };
    }
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), 15000);
      pending.set(id, finish);
      try {
        worker.postMessage({ id, records, position, manifest: state.manifest });
      } catch {
        finish(null);
      }
    });
  }

  function placeButton(room, entry = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-result";
    button.setAttribute("role", "option");
    const campus = state.manifest?.campuses.find(
      (campus) => campus.id === room.campusId,
    );
    const floor = campus?.floors.find((floor) => floor.id === room.floorId);
    const identity = presentPlaceIdentity(room, floor);
    const location = placeLocation(identity, floor, placeLandmarks.hints);
    button.innerHTML = `<span class="result-icon">${icon(room.kind === "stairs" ? "stair" : "pin", 17)}</span><span><b>${escape(identity.label)}</b><small>${escape(location.summary)}</small>${location.landmark ? `<small>${escape(location.landmark)}</small>` : ""}${entry ? `<small class="nearby-distance">${escape(nearbyDistanceLabel(entry))}</small>` : ""}</span>${icon("arrow", 14)}`;
    button.onclick = () => {
      close();
      $("#search").blur();
      navigateRoom(room);
    };
    return button;
  }

  function showNearby(matches, ranking) {
    const results = $("#results");
    results.replaceChildren();
    const intro = document.createElement("div");
    intro.className = "nearby-intro";
    const positionKnown = ranking.mode !== "no-location";
    intro.innerHTML = `<b>${ranking.nearest ? (ranking.mode === "routes" ? "Ближайшие по маршруту" : "Ближайшие по прямой") : "Места на карте"}</b><p>${!positionKnown ? "Укажите, где вы сейчас, чтобы найти ближайшее место." : !ranking.nearest ? "Расстояние от вашей точки не подтверждено. Можно открыть места на карте." : ranking.mode === "routes" ? "Пути сравниваются по данным карты; доступность на месте уточняйте." : ranking.floorContext === "view" ? "На выбранном этаже карты. Проходы и лестницы в расстоянии не учтены." : "На вашем отмеченном этаже. Расстояние по прямой, проходы не учтены."}</p>`;
    if (
      (!positionKnown || !ranking.nearest) &&
      typeof onLocate === "function"
    ) {
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "nearby-locate";
      locate.textContent = positionKnown ? "Уточнить, где я" : "Указать, где я";
      locate.onclick = () => onLocate();
      intro.append(locate);
    }
    results.append(intro);
    const entries = ranking.items;
    const shown = expanded ? entries.slice(0, 60) : entries.slice(0, 5);
    for (const entry of shown)
      results.append(placeButton(entry.room, positionKnown ? entry : null));
    if (entries.length > 5) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "nearby-more";
      more.textContent = expanded
        ? "Скрыть другие места"
        : `Все места · ${entries.length}`;
      more.setAttribute("aria-expanded", String(expanded));
      more.onclick = () => {
        expanded = !expanded;
        showNearby(matches, ranking);
      };
      results.append(more);
    }
    $("#search-status").textContent = ranking.nearest
      ? `Показано ${shown.length} из ${matches.length}${ranking.unreachableCount ? ` · для ${ranking.unreachableCount} путь не подтверждён` : ""}`
      : `Найдено: ${matches.length}`;
    results.hidden = false;
  }

  async function searchRooms() {
    const id = ++revision;
    const navigationRevision = state.loading;
    const results = $("#results");
    results.replaceChildren();
    const query = $("#search").value;
    const active = Boolean(query.trim() || category);
    $("#search-clear").hidden = !active;
    $("#search").setAttribute("aria-expanded", String(active));
    if (!active) {
      results.hidden = true;
      $("#search-status").textContent = "";
      return;
    }
    const matches = findPlaces(state.search, {
      query,
      category,
      floorId: state.floor?.id,
    });
    const nearbyCategory = category || categoryForPlaceQuery(query);
    if (!matches.length) {
      results.innerHTML = /unifood|унифуд|юнифуд/iu.test(query)
        ? '<div class="search-empty">Unifood пока отдельно не отмечен на карте. Другие места питания — в разделе «Еда».</div>'
        : '<div class="search-empty">Ничего не найдено. Попробуйте номер аудитории или другую категорию.</div>';
      $("#search-status").textContent = "Ничего не найдено";
      results.hidden = false;
      return;
    }
    if (nearbyCategory) {
      const position = getPosition ? getPosition() : state.userLocation;
      let ranking = rankNearbyPlaces(matches, {
        position,
        manifest: state.manifest,
      });
      if (
        position?.source === "manual" &&
        position.placeId &&
        position.floorId
      ) {
        results.innerHTML =
          '<div class="search-empty">Ищем ближайшее место…</div>';
        results.hidden = false;
        $("#search-status").textContent = "Сравниваем пути…";
        ranking = (await requestNearby(matches, position, id)) || ranking;
        if (id !== revision || state.loading !== navigationRevision) return;
      }
      showNearby(matches, ranking);
      return;
    }
    for (const room of matches.slice(0, 60)) results.append(placeButton(room));
    $("#search-status").textContent =
      matches.length > 60
        ? `Найдено ${matches.length}. Показаны первые 60 — уточните запрос.`
        : `Найдено: ${matches.length}`;
    results.hidden = false;
  }

  function renderCategories() {
    $("#place-categories").innerHTML = PLACE_CATEGORIES.filter((item) =>
      state.search.some((room) => placeCategory(room) === item.id),
    )
      .map(
        (item) =>
          `<button type="button" data-category="${item.id}" aria-pressed="${category === item.id}">${item.label}</button>`,
      )
      .join("");
    for (const button of $("#place-categories").querySelectorAll("button"))
      button.onclick = () => {
        category =
          category === button.dataset.category ? null : button.dataset.category;
        expanded = false;
        $("#search").value = "";
        onOpen?.();
        for (const option of $("#place-categories").querySelectorAll("button"))
          option.setAttribute(
            "aria-pressed",
            String(category === option.dataset.category),
          );
        searchRooms();
      };
  }
  $("#search-clear").onclick = () => {
    category = null;
    expanded = false;
    $("#search").value = "";
    renderCategories();
    searchRooms();
    $("#search").focus();
  };
  $("#search").addEventListener("focus", () => {
    onOpen?.();
    searchRooms();
  });
  $("#search").addEventListener("input", () => {
    expanded = false;
    searchRooms();
  });
  $("#search").addEventListener("keydown", (event) => {
    const buttons = [...$("#results").querySelectorAll("button")];
    if (
      (event.key === "Enter" || event.key === "ArrowDown") &&
      !$("#results").hidden
    ) {
      event.preventDefault();
      event.key === "Enter" ? buttons[0]?.click() : buttons[0]?.focus();
    }
    if (event.key === "Escape") {
      close();
    }
  });
  $("#results").onkeydown = (event) => {
    const buttons = [...$("#results").querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index <= 0) $("#search").focus();
      else buttons[index - 1].focus();
    }
    if (event.key === "Escape") {
      $("#search").focus();
      close();
    }
  };
  return {
    renderCategories,
    refresh: searchRooms,
    refreshPosition: () => {
      if (!$("#results").hidden) return searchRooms();
    },
    close,
  };
}
