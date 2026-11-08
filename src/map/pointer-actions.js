import { createMapTapGuard } from "./gestures.js";

// Labels and the canvas share one pointer stream. A drag which starts on a
// label must manipulate the map, never become a room selection on release.
export function bindMapTapActions(surface, onTap) {
  let guard = createMapTapGuard();
  let label = null;
  const reset = () => {
    guard = createMapTapGuard();
    label = null;
  };
  const down = (event) => {
    guard.down(event);
    const target = event.target?.closest?.(".map-label");
    label = target && surface.contains(target) ? target : null;
  };
  const move = (event) => guard.move(event);
  const up = (event) => {
    const target = label;
    label = null;
    if (guard.up(event)) onTap(event, target);
  };
  const cancel = (event) => {
    guard.cancel(event);
    label = null;
  };
  const click = (event) => {
    // Pointer taps are delivered once by onTap, even after pointer capture
    // retargets the release to the map. Keep keyboard/assistive clicks intact.
    if (event.detail > 0 && event.target?.closest?.(".map-label")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const events = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", up],
    ["pointercancel", cancel],
    ["lostpointercapture", cancel],
    ["click", click],
  ];
  for (const [name, listener] of events)
    surface.addEventListener(name, listener, true);
  const window = surface.ownerDocument?.defaultView;
  window?.addEventListener("blur", reset);
  return {
    dispose() {
      for (const [name, listener] of events)
        surface.removeEventListener(name, listener, true);
      window?.removeEventListener("blur", reset);
      reset();
    },
  };
}
