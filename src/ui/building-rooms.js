import { buildingRoomFloors } from "../data/building-rooms.js";
import { $, escape } from "./dom.js";

export function bindBuildingRooms({ state, navigateRoom }) {
  const dialog = $("#building-rooms-dialog");
  const floor = $("#building-rooms-floor");
  const list = $("#building-rooms-list");
  let floors = [];
  let markers = [];

  function markerButton(marker, text, label = text) {
    const index = markers.push(marker) - 1;
    return `<button type="button" data-room-choice="${index}" aria-label="${escape(label)}">${escape(text)}</button>`;
  }

  function showFloor() {
    markers = [];
    const entry = floors.find(({ id }) => id === floor.value);
    list.innerHTML = entry
      ? entry.rooms
          .map(({ label, markers }) =>
            markers.length === 1
              ? markerButton(markers[0], label)
              : `<details><summary>${escape(label)}<small>Отметок на плане: ${markers.length}</small></summary>${markers
                  .map((marker, index) =>
                    markerButton(
                      marker,
                      `Отметка ${index + 1}`,
                      `${label}, отметка ${index + 1}`,
                    ),
                  )
                  .join("")}</details>`,
          )
          .join("")
      : "<p>В этом корпусе пока нет подписанных аудиторий.</p>";
    dialog.scrollTop = 0;
  }

  $("#building-rooms-open").onclick = () => {
    if (!state.building || dialog.open) return;
    floors = buildingRoomFloors(state.campus, state.building, state.search);
    $("#building-rooms-title").textContent =
      `Аудитории корпуса ${state.building}`;
    $("#building-rooms-filter").hidden = floors.length === 0;
    floor.innerHTML = floors
      .map(
        ({ id, label }) =>
          `<option value="${escape(id)}">${escape(label)}</option>`,
      )
      .join("");
    floor.value =
      floors.find(({ id }) => id === state.floor?.id)?.id ||
      floors[0]?.id ||
      "";
    showFloor();
    dialog.showModal();
  };
  $("#building-rooms-close").onclick = () => dialog.close();
  floor.onchange = showFloor;
  list.onclick = (event) => {
    const button = event.target.closest("[data-room-choice]");
    const room = button && markers[button.dataset.roomChoice];
    if (!room) return;
    dialog.close();
    navigateRoom(room);
  };
}
