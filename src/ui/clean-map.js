import { $ } from "./dom.js";
import "./clean-map.css";

export function bindCleanMap(scene, cancelPicking) {
  const exit = $("#clean-map-exit");
  const settings = $("#settings-dialog");

  function setEnabled(enabled) {
    document.body.dataset.cleanMap = String(enabled);
    scene.setCleanMap(enabled);
    exit.hidden = !enabled;
    (enabled ? exit : $("#settings-open")).focus({ preventScroll: true });
  }

  $("#clean-map-enter").onclick = () => {
    settings.close();
    cancelPicking();
    setEnabled(true);
  };
  exit.onclick = () => setEnabled(false);

  function closeCleanMap(event) {
    if (exit.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setEnabled(false);
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") closeCleanMap(event);
    },
    true,
  );
  window.addEventListener("atlas:back", closeCleanMap, true);
}
