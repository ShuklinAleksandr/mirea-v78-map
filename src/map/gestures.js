import { TOUCH } from "three";

export const TWO_FINGER_ROTATION_MULTIPLIER = 2.5;
const touchRotationBindings = new WeakMap();

export function configureMapTouchControls(controls, plan) {
  controls.touches.ONE = TOUCH.PAN;
  controls.touches.TWO = plan ? TOUCH.DOLLY_PAN : TOUCH.DOLLY_ROTATE;
  touchRotationBindings.get(controls)?.refresh();
}

/** Boost only a two-finger 3D rotation. OrbitControls reads rotateSpeed for
 * mouse rotation too, so restore its original value before desktop input,
 * when returning to one finger, or when switching to the locked 2D plan.
 * Capture listeners run before OrbitControls' handlers on a real canvas.
 */
export function bindMapTouchRotation(
  controls,
  {
    element = controls.domElement,
    multiplier = TWO_FINGER_ROTATION_MULTIPLIER,
  } = {},
) {
  if (!element?.addEventListener || !element?.removeEventListener)
    throw new TypeError("Touch rotation needs a canvas event target.");
  if (!Number.isFinite(multiplier) || multiplier < 1)
    throw new RangeError("Touch rotation multiplier must be at least 1.");
  touchRotationBindings.get(controls)?.dispose();
  const touches = new Set();
  const mousePointers = new Set();
  let originalSpeed = controls.rotateSpeed;
  let boosted = false;
  let disposed = false;
  const restore = () => {
    if (boosted) controls.rotateSpeed = originalSpeed;
    boosted = false;
  };
  const refresh = () => {
    if (disposed) return;
    const rotateTouch =
      touches.size === 2 &&
      mousePointers.size === 0 &&
      controls.enabled !== false &&
      controls.enableRotate !== false &&
      controls.touches.TWO === TOUCH.DOLLY_ROTATE;
    if (!rotateTouch) {
      restore();
      return;
    }
    if (!boosted) originalSpeed = controls.rotateSpeed;
    controls.rotateSpeed = originalSpeed * multiplier;
    boosted = true;
  };
  const down = (event) => {
    (event.pointerType === "touch" ? touches : mousePointers).add(
      event.pointerId,
    );
    refresh();
  };
  const move = (event) => {
    if (event.pointerType !== "touch") restore();
    else refresh();
  };
  const finish = (event) => {
    touches.delete(event.pointerId);
    mousePointers.delete(event.pointerId);
    refresh();
  };
  const reset = () => {
    touches.clear();
    mousePointers.clear();
    restore();
  };
  const events = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", finish],
    ["pointercancel", finish],
    ["lostpointercapture", finish],
  ];
  for (const [name, listener] of events)
    element.addEventListener(name, listener, true);
  const window = element.ownerDocument?.defaultView;
  window?.addEventListener("blur", reset);
  // OrbitControls may end an interaction while a finger remains in contact.
  // Pointer releases own the contact list so adding a second finger works again.
  controls.addEventListener("end", restore);
  const binding = {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      for (const [name, listener] of events)
        element.removeEventListener(name, listener, true);
      window?.removeEventListener("blur", reset);
      controls.removeEventListener("end", restore);
      touchRotationBindings.delete(controls);
    },
  };
  touchRotationBindings.set(controls, binding);
  return binding;
}

// A tap must remain a single, unmoved pointer for its entire lifetime. Checking
// only the release position would also select a room after a pinch or a drag
// that returned to its starting point.
export function createMapTapGuard() {
  const pointers = new Set();
  let candidate = null;
  const nearStart = (event) =>
    Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) < 5;
  return {
    down(event) {
      if (pointers.has(event.pointerId)) return;
      pointers.add(event.pointerId);
      candidate =
        pointers.size === 1 &&
        event.isPrimary !== false &&
        (event.button == null || event.button === 0)
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
    },
    move(event) {
      if (candidate?.id === event.pointerId && !nearStart(event))
        candidate = null;
    },
    up(event) {
      const tapped =
        pointers.size === 1 &&
        candidate?.id === event.pointerId &&
        nearStart(event);
      pointers.delete(event.pointerId);
      candidate = null;
      return Boolean(tapped);
    },
    cancel(event) {
      pointers.delete(event.pointerId);
      candidate = null;
    },
  };
}
