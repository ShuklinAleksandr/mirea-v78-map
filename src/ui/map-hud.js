import { $ } from "./dom.js";
import { isCompactLandscape } from "./map-viewport.js";
import "./map-hud.css";

const idleDelay = 6000;

export function bindMapHud(onVisibilityChange) {
  const body = document.body;
  const sidebar = $(".sidebar");
  const loading = $("#loading");
  const error = $("#error");
  const reveal = $("#map-hud-reveal");
  const dialogs = Array.from(document.querySelectorAll("dialog"));
  const pointers = new Set();
  let timer;
  let hidden = false;

  function setHidden(value) {
    if (hidden === value) return;
    hidden = value;
    body.dataset.mapHudHidden = String(value);
    reveal.hidden = !value;
    onVisibilityChange();
  }

  function keepVisible() {
    const active = document.activeElement;
    return (
      (innerWidth > 700 && !isCompactLandscape(innerWidth, innerHeight)) ||
      !loading.hidden ||
      !error.hidden ||
      body.dataset.cleanMap === "true" ||
      body.dataset.locationPicking === "true" ||
      body.dataset.routeAvailable === "true" ||
      sidebar.classList.contains("expanded") ||
      sidebar.dataset.inputEditing === "true" ||
      sidebar.dataset.place === "true" ||
      dialogs.some((dialog) => dialog.open) ||
      (active !== reveal && active?.matches(":focus-visible"))
    );
  }

  function schedule() {
    clearTimeout(timer);
    if (keepVisible()) {
      setHidden(false);
      return;
    }
    if (hidden || document.hidden || pointers.size) return;
    timer = setTimeout(() => {
      if (!keepVisible()) setHidden(true);
    }, idleDelay);
  }

  function wake() {
    if (!hidden) return false;
    setHidden(false);
    schedule();
    return true;
  }

  const stateChanges = new MutationObserver((records) => {
    if (
      records.some(
        ({ target, attributeName, oldValue }) =>
          target.getAttribute(attributeName) !== oldValue,
      )
    )
      schedule();
  });
  const observe = (element, attributeFilter) =>
    stateChanges.observe(element, { attributeFilter, attributeOldValue: true });
  observe(body, [
    "data-clean-map",
    "data-location-picking",
    "data-route-available",
  ]);
  observe(sidebar, ["class", "data-input-editing", "data-place"]);
  for (const dialog of dialogs) observe(dialog, ["open"]);
  for (const element of [loading, error]) observe(element, ["hidden"]);

  document.addEventListener(
    "pointerdown",
    (event) => {
      pointers.add(event.pointerId);
      clearTimeout(timer);
    },
    true,
  );
  function release(event) {
    pointers.delete(event.pointerId);
    schedule();
  }
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  document.addEventListener("wheel", schedule, { passive: true });
  document.addEventListener("click", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("blur", () => {
    pointers.clear();
    schedule();
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab" || event.key === "/") wake();
      schedule();
    },
    true,
  );
  reveal.addEventListener("click", () => {
    wake();
    $("#sheet-toggle").focus({ preventScroll: true });
  });

  schedule();
  // Consume the first tap after idle so revealing controls can't select a
  // room or change floors at the same time. Pan and pinch never call this.
  return { onMapTap: wake };
}
