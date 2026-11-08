import { TOUCH } from "three";

export const TWO_FINGER_ROTATION_MULTIPLIER = 2.5;
const touchRotationBindings = new WeakMap();
const INTENT_WAIT_MS = 80;
const MIN_SPAN = 12;

export function configureMapTouchControls(controls, plan) {
  controls.touches.ONE = TOUCH.PAN;
  controls.touches.TWO = plan ? TOUCH.DOLLY_PAN : TOUCH.DOLLY_ROTATE;
  touchRotationBindings.get(controls)?.refresh();
}

function pairShape(points) {
  const [a, b] = points;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    span: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

function gestureIntent(initial, current, allowSingle) {
  const movement = current.map((point, i) => ({
    x: point.x - initial[i].x,
    y: point.y - initial[i].y,
  }));
  const lengths = movement.map((point) => Math.hypot(point.x, point.y));
  const bothMoved = lengths.every((length) => length >= 3);
  if (!bothMoved && !allowSingle) return null;
  const start = pairShape(initial),
    end = pairShape(current);
  const spanChange = Math.abs(end.span - start.span);
  const centerMove = Math.hypot(end.x - start.x, end.y - start.y);
  const angle = Math.atan2(
    Math.sin(end.angle - start.angle),
    Math.cos(end.angle - start.angle),
  );
  const twistTravel = Math.abs(angle) * start.span;
  // Pointer events arrive separately. Do not confuse the temporary separation
  // change of the first moving finger with an intentional pinch.
  if (
    spanChange >= 6 &&
    spanChange > centerMove * 0.85 &&
    spanChange > twistTravel * 1.25
  )
    return "pinch";
  const parallel =
    bothMoved &&
    (movement[0].x * movement[1].x + movement[0].y * movement[1].y) /
      (lengths[0] * lengths[1]) >
      0.85;
  if (
    parallel &&
    centerMove >= 8 &&
    spanChange < Math.max(6, centerMove * 0.5) &&
    Math.abs(angle) < 0.12
  )
    return "parallel";
  return null;
}

/** Distinguish a pinch from the two-finger parallel drag used to turn 3D.
 * OrbitControls normally applies both to every pointer event. Muting the
 * competing speed keeps its internal positions current without a camera jump.
 * The intent is fixed until a finger lifts; one finger and mouse input retain
 * their normal settings. Capture works for either a canvas or its map host.
 */
export function bindMapTouchRotation(
  controls,
  {
    element = controls.domElement,
    multiplier = TWO_FINGER_ROTATION_MULTIPLIER,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = {},
) {
  if (!element?.addEventListener || !element?.removeEventListener)
    throw new TypeError("Touch rotation needs a map event target.");
  if (!Number.isFinite(multiplier) || multiplier < 1)
    throw new RangeError("Touch rotation multiplier must be at least 1.");
  touchRotationBindings.get(controls)?.dispose();
  const touches = new Map();
  const mousePointers = new Set();
  let original = null;
  let initial = null;
  let mode = null;
  let timer = null;
  let allowSingle = false;
  let blocked = false;
  let disposed = false;
  const restore = () => {
    if (!original) return;
    Object.assign(controls, original);
    original = null;
  };
  const clearIntent = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    initial = null;
    mode = null;
    allowSingle = false;
  };
  const points = () => [...touches.values()].map((point) => ({ ...point }));
  const activePair = () =>
    touches.size === 2 &&
    mousePointers.size === 0 &&
    controls.enabled !== false;
  const applySpeeds = () => {
    if (!activePair()) {
      restore();
      return;
    }
    if (!original)
      original = {
        rotateSpeed: controls.rotateSpeed,
        zoomSpeed: controls.zoomSpeed,
        panSpeed: controls.panSpeed,
      };
    controls.rotateSpeed =
      mode === "parallel" && controls.touches.TWO === TOUCH.DOLLY_ROTATE
        ? original.rotateSpeed * multiplier
        : 0;
    controls.panSpeed =
      mode === "parallel" && controls.touches.TWO === TOUCH.DOLLY_PAN
        ? original.panSpeed
        : 0;
    controls.zoomSpeed = mode === "pinch" ? original.zoomSpeed : 0;
  };
  // A brief pinch with one stationary finger still completes without requiring
  // another pointermove after the intent window. Use only public camera APIs.
  const applyPendingPinch = () => {
    if (controls.enableZoom === false || !initial || !original) return;
    const startSpan = pairShape(initial).span;
    const endSpan = pairShape(points()).span;
    if (startSpan < MIN_SPAN || endSpan < MIN_SPAN) return;
    const scale = Math.pow(startSpan / endSpan, original.zoomSpeed);
    const camera = controls.object;
    if (camera.isPerspectiveCamera) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      if (!distance) return;
      const nextDistance = Math.max(
        controls.minDistance,
        Math.min(controls.maxDistance, distance * scale),
      );
      camera.position
        .copy(controls.target)
        .addScaledVector(offset, nextDistance / distance);
    } else if (camera.isOrthographicCamera) {
      camera.zoom = Math.max(
        controls.minZoom,
        Math.min(controls.maxZoom, camera.zoom / scale),
      );
      camera.updateProjectionMatrix();
    } else return;
    controls.update();
  };
  const resolveIntent = (catchUp = false) => {
    if (blocked || mode || !initial || !activePair()) return;
    mode = gestureIntent(initial, points(), allowSingle);
    if (!mode) return;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (catchUp && mode === "pinch") applyPendingPinch();
    applySpeeds();
    return mode;
  };
  const begin = () => {
    clearIntent();
    if (activePair() && !blocked) initial = points();
    applySpeeds();
  };
  const down = (event) => {
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size > 2) blocked = true;
    } else mousePointers.add(event.pointerId);
    begin();
  };
  const move = (event) => {
    if (event.pointerType !== "touch") {
      restore();
      return;
    }
    if (!touches.has(event.pointerId)) return;
    const previousSpan = touches.size === 2 ? pairShape(points()).span : 0;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!activePair()) {
      restore();
      return;
    }
    if (!initial && !blocked) initial = points();
    const resolved = resolveIntent(true);
    applySpeeds();
    if (
      mode === "pinch" &&
      (resolved ||
        previousSpan < MIN_SPAN ||
        pairShape(points()).span < MIN_SPAN)
    )
      controls.zoomSpeed = 0;
    if (!mode && !blocked && timer === null && !allowSingle)
      timer = setTimer(() => {
        timer = null;
        allowSingle = true;
        resolveIntent(true);
      }, INTENT_WAIT_MS);
  };
  const finish = (event) => {
    if (event.type === "pointerup" && activePair() && !mode && !blocked) {
      allowSingle = true;
      resolveIntent(true);
    }
    touches.delete(event.pointerId);
    mousePointers.delete(event.pointerId);
    clearIntent();
    if (touches.size < 2) blocked = false;
    applySpeeds();
  };
  const reset = () => {
    clearIntent();
    touches.clear();
    mousePointers.clear();
    blocked = false;
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
    element.addEventListener(name, listener, { capture: true });
  const window = element.ownerDocument?.defaultView;
  window?.addEventListener("blur", reset);
  controls.addEventListener("end", restore);
  const binding = {
    refresh() {
      if (disposed) return;
      restore();
      clearIntent();
      // Projection/picking changes start a fresh interaction, never revive a
      // stale rotation or zoom from the previous camera.
      blocked = touches.size > 1;
      applySpeeds();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      for (const [name, listener] of events)
        element.removeEventListener(name, listener, { capture: true });
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
