import { Plane, Raycaster, TOUCH, Vector2, Vector3 } from "three";

const touchBindings = new WeakMap();
const planModes = new WeakMap();
const UP = new Vector3(0, 1, 0);
const MIN_SPAN = 12;
const TILT_START_PIXELS = 12;
const PAIR_START_PIXELS = 8;
const PINCH_START = 0.06;
const TWIST_START = (6 * Math.PI) / 180;
const TILT_PER_PIXEL = Math.PI / 900;
const MIN_TOUCH_TILT = (5 * Math.PI) / 180;
const MAX_TOUCH_TILT = (70 * Math.PI) / 180;

export function configureMapTouchControls(controls, plan) {
  planModes.set(controls, Boolean(plan));
  controls.touches.ONE = TOUCH.PAN;
  // Neutral fallback only. The map's touch controller owns the complete touch
  // stream; OrbitControls continues to own mouse, wheel and keyboard input.
  controls.touches.TWO = TOUCH.DOLLY_PAN;
  touchBindings.get(controls)?.refresh();
}

function shape(points) {
  if (points.length === 1)
    return { x: points[0].x, y: points[0].y, span: 0, angle: 0 };
  const [a, b] = points;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    span: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finitePoint = (event) =>
  Number.isFinite(event.clientX) && Number.isFinite(event.clientY);

/** A single touch pans; a pair pinches and turns, or tilts 3D when both fingers
 * deliberately move vertically together. Stable pointer IDs and one
 * update per animation frame avoid the half-gesture caused by sequential
 * pointermove events. Camera math uses only public Three/OrbitControls APIs.
 */
export function bindMapTouchRotation(
  controls,
  {
    element = controls.domElement,
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) ||
      ((callback) => setTimeout(callback, 16)),
    cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ||
      clearTimeout,
  } = {},
) {
  if (!element?.addEventListener || !element?.removeEventListener)
    throw new TypeError("Map touch controls need an event target.");
  touchBindings.get(controls)?.dispose();
  const pointers = new Map();
  const mousePointers = new Set();
  const ignoredPointers = new Set();
  const raycaster = new Raycaster();
  const plane = new Plane(UP, 0);
  const ndc = new Vector2();
  let baseline = null;
  let frame = null;
  let active = false;
  let interactionStarted = false;
  let disposed = false;
  let singleDragStarted = false;
  let pairOrigin = null;
  let pairIntent = null;
  let pairPoints = null;
  let pinchStarted = false;
  let twistStarted = false;
  const pairUpdates = new Set();
  let waitedForPair = false;

  const points = () =>
    [...pointers.entries()].map(([id, point]) => ({ id, ...point }));
  const resetPairIntent = () => {
    pairOrigin = pointers.size === 2 ? shape(points()) : null;
    pairPoints = pointers.size === 2 ? points() : null;
    pairIntent = null;
    pinchStarted = twistStarted = waitedForPair = false;
    pairUpdates.clear();
  };
  const rectangle = () => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
      ? {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      : null;
  };
  const rebase = () => {
    baseline =
      pointers.size > 0 && pointers.size <= 2
        ? { points: points(), rect: rectangle(), camera: controls.object }
        : null;
    pairUpdates.clear();
    waitedForPair = false;
  };
  const consume = (event) => {
    event.preventDefault?.();
    // Do not stop other capture listeners on this surface: the tap guard must
    // see every pointer, including a gesture that started on an HTML label.
    event.stopPropagation?.();
  };
  const capture = (id) => {
    try {
      element.setPointerCapture?.(id);
    } catch {
      /* Detached/cancelled touch. */
    }
  };
  const release = (id) => {
    try {
      if (!element.hasPointerCapture || element.hasPointerCapture(id))
        element.releasePointerCapture?.(id);
    } catch {
      /* The browser may already have released a cancelled pointer. */
    }
  };
  const cancelPending = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };

  // enabled=false does not clear OrbitControls inertia. Drain its old deltas
  // once while preserving the exact current view instead of letting an old
  // mouse drag pull the map away from the user's fingers.
  const drainDamping = () => {
    const camera = controls.object;
    const position = camera.position.clone();
    const target = controls.target.clone();
    const up = camera.up.clone();
    const zoom = camera.zoom;
    const damping = controls.enableDamping;
    try {
      controls.enableDamping = false;
      controls.update();
      camera.position.copy(position);
      camera.up.copy(up);
      camera.zoom = zoom;
      controls.target.copy(target);
      camera.updateProjectionMatrix();
      controls.update();
    } finally {
      controls.enableDamping = damping;
    }
  };
  const groundPoint = (point, rect, camera, height) => {
    if (!rect) return null;
    ndc.set(
      ((point.x - rect.left) / rect.width) * 2 - 1,
      1 - ((point.y - rect.top) / rect.height) * 2,
    );
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    if (Math.abs(raycaster.ray.direction.y) < 0.001) return null;
    plane.constant = -height;
    const result = raycaster.ray.intersectPlane(plane, new Vector3());
    if (
      !result ||
      !result.toArray().every(Number.isFinite) ||
      result.distanceTo(camera.position) > 1_000_000
    )
      return null;
    return result;
  };
  const apply = ({ flush = false } = {}) => {
    cancelPending();
    const previous = baseline;
    const current = points();
    const rect = rectangle();
    const camera = controls.object;
    if (
      !active ||
      controls.enabled === false ||
      !previous ||
      !rect ||
      !previous.rect ||
      current.length < 1 ||
      current.length > 2 ||
      camera !== previous.camera ||
      current.length !== previous.points.length ||
      current.some((point, i) => point.id !== previous.points[i].id) ||
      ["left", "top", "width", "height"].some(
        (key) => rect[key] !== previous.rect[key],
      )
    ) {
      const samePair =
        controls.enabled !== false &&
        camera === previous?.camera &&
        current.length === 2 &&
        previous?.points.length === 2 &&
        current.every((point, i) => point.id === previous.points[i].id);
      const intent = pairIntent,
        zooming = pinchStarted,
        rotating = twistStarted;
      rebase();
      resetPairIntent();
      // Rotation of the screen rebases coordinates, not the user's intention.
      if (samePair) {
        pairIntent = intent;
        pinchStarted = zooming;
        twistStarted = rotating;
      }
      return;
    }
    // Touch events can straddle animation frames. Give the other finger one
    // frame to catch up before classifying a new pair. A genuinely stationary
    // finger still works, and pointerup flushes its final movement immediately.
    if (
      current.length === 2 &&
      !pairIntent &&
      pairUpdates.size === 1 &&
      !waitedForPair &&
      !flush
    ) {
      waitedForPair = true;
      schedule();
      return;
    }
    const before = shape(previous.points);
    const after = shape(current);
    // Match the tap guard's five-pixel tolerance: a slightly shaky label tap
    // must not nudge the camera before opening its card. Keep the original
    // baseline so slow intentional movement can still cross the threshold.
    if (current.length === 1 && !singleDragStarted) {
      if (Math.hypot(after.x - before.x, after.y - before.y) < 5) return;
      singleDragStarted = true;
    }
    const pair =
      current.length === 2 && before.span >= MIN_SPAN && after.span >= MIN_SPAN;
    if (pair && pairOrigin?.span >= MIN_SPAN) {
      const dx = after.x - pairOrigin.x;
      const dy = after.y - pairOrigin.y;
      const pinch = Math.abs(Math.log(after.span / pairOrigin.span));
      const twist = Math.abs(
        Math.atan2(
          Math.sin(after.angle - pairOrigin.angle),
          Math.cos(after.angle - pairOrigin.angle),
        ),
      );
      if (!pairIntent) {
        const motion = current.map((p, i) => ({
          x: p.x - pairPoints[i].x,
          y: p.y - pairPoints[i].y,
        }));
        const coherent =
          motion[0].y * motion[1].y > 0 &&
          motion.every(
            (p) =>
              Math.abs(p.y) >= PAIR_START_PIXELS &&
              Math.abs(p.y) > Math.abs(p.x) * 1.5,
          ) &&
          Math.abs(motion[0].y - motion[1].y) <=
            Math.max(8, Math.abs(dy) * 0.6);
        const sideBySide = Math.abs(Math.cos(pairOrigin.angle)) >= 0.64;
        if (pinch >= PINCH_START || twist >= TWIST_START)
          pairIntent = "transform";
        else if (
          !planModes.get(controls) &&
          controls.enableTouchRotate !== false &&
          sideBySide &&
          coherent &&
          Math.abs(dy) >= TILT_START_PIXELS
        )
          pairIntent = "tilt";
        else if (
          Math.abs(dx) >= PAIR_START_PIXELS ||
          ((planModes.get(controls) ||
            !sideBySide ||
            controls.enableTouchRotate === false) &&
            Math.abs(dy) >= PAIR_START_PIXELS)
        )
          pairIntent = "transform";
        // Do not apply a premature pan, zoom or bearing change while deciding.
        // Keep the baseline to recognize slow deliberate motion too.
        if (!pairIntent) {
          pairUpdates.clear();
          waitedForPair = false;
          return;
        }
      }
      if (pairIntent === "transform") {
        pinchStarted ||= pinch >= PINCH_START;
        twistStarted ||= twist >= TWIST_START;
      }
    } else if (current.length === 2) {
      // Coincident contacts are not a meaningful scale/angle reference.
      rebase();
      resetPairIntent();
      return;
    }
    const tilting =
      pair && pairIntent === "tilt" && controls.enableTouchRotate !== false;
    const position = camera.position.clone();
    const target = controls.target.clone();
    const up = camera.up.clone();
    const zoom = camera.zoom;
    const height = controls.target.y;
    const pivotBefore = tilting ? pairOrigin : before;
    const pivotAfter = tilting ? pairOrigin : after;
    const anchor =
      controls.enablePan !== false
        ? groundPoint(pivotBefore, rect, camera, height)
        : null;
    const canMove =
      (anchor &&
        (pivotBefore.x !== pivotAfter.x || pivotBefore.y !== pivotAfter.y)) ||
      (tilting && before.y !== after.y) ||
      (pair &&
        !tilting &&
        ((pinchStarted &&
          controls.enableZoom !== false &&
          controls.zoomSpeed !== 0 &&
          before.span !== after.span) ||
          (twistStarted &&
            controls.enableTouchRotate !== false &&
            before.angle !== after.angle)));
    if (!canMove) {
      rebase();
      return;
    }
    // A touch-down may only reveal the map buttons. Notify the application
    // after a supported movement is recognized, so a tap does not stop GPS
    // following or cancel an in-progress recenter animation.
    if (!interactionStarted) {
      interactionStarted = true;
      controls.dispatchEvent({ type: "start" });
    }
    if (tilting) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
      if (distance > 0) {
        const polar = Math.acos(clamp(offset.y / distance, -1, 1));
        const next = clamp(
          polar + (after.y - before.y) * TILT_PER_PIXEL,
          Math.max(MIN_TOUCH_TILT, controls.minPolarAngle ?? 0),
          Math.min(MAX_TOUCH_TILT, controls.maxPolarAngle ?? Math.PI),
        );
        offset.setFromSphericalCoords(
          distance,
          next,
          Math.atan2(offset.x, offset.z),
        );
        camera.position.copy(controls.target).add(offset);
      }
    }
    if (pair && pinchStarted && !tilting && controls.enableZoom !== false) {
      const speed = Number.isFinite(controls.zoomSpeed)
        ? controls.zoomSpeed
        : 1;
      const ratio = Math.pow(before.span / after.span, speed);
      if (Number.isFinite(ratio) && ratio > 0) {
        if (camera.isPerspectiveCamera) {
          const offset = camera.position.clone().sub(controls.target);
          const distance = offset.length();
          if (distance > 0) {
            const next = clamp(
              distance * ratio,
              controls.minDistance ?? 0,
              controls.maxDistance ?? Infinity,
            );
            camera.position
              .copy(controls.target)
              .addScaledVector(offset, next / distance);
          }
        } else if (camera.isOrthographicCamera) {
          camera.zoom = clamp(
            camera.zoom / ratio,
            controls.minZoom ?? 0,
            controls.maxZoom ?? Infinity,
          );
          camera.updateProjectionMatrix();
        }
      }
    }
    if (
      pair &&
      twistStarted &&
      !tilting &&
      controls.enableTouchRotate !== false
    ) {
      const angle = Math.atan2(
        Math.sin(after.angle - before.angle),
        Math.cos(after.angle - before.angle),
      );
      if (planModes.get(controls))
        camera.up.applyAxisAngle(UP, angle).normalize();
      else {
        const offset = camera.position
          .clone()
          .sub(controls.target)
          .applyAxisAngle(UP, angle);
        camera.position.copy(controls.target).add(offset);
      }
    }
    camera.lookAt(controls.target);
    // Apply public distance/polar/azimuth constraints before anchoring. There
    // are no pending touch deltas in OrbitControls because its bubble handlers
    // never receive these captured events.
    controls.update();
    if (anchor) {
      const under = groundPoint(pivotAfter, rect, camera, height);
      if (under) {
        const shift = anchor.sub(under);
        shift.y = 0;
        camera.position.add(shift);
        controls.target.add(shift);
      }
    }
    camera.updateMatrixWorld();
    const changed =
      camera.position.distanceToSquared(position) > 1e-18 ||
      controls.target.distanceToSquared(target) > 1e-18 ||
      camera.up.distanceToSquared(up) > 1e-18 ||
      camera.zoom !== zoom;
    const notified = controls.update();
    if (changed && !notified) controls.dispatchEvent({ type: "change" });
    rebase();
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      apply();
    });
  };
  const finishSession = () => {
    cancelPending();
    baseline = null;
    singleDragStarted = false;
    pairOrigin = pairIntent = null;
    pairPoints = null;
    pairUpdates.clear();
    if (!active) return;
    active = false;
    if (interactionStarted) {
      interactionStarted = false;
      controls.dispatchEvent({ type: "end" });
    }
  };
  const reset = () => {
    const ids = [...pointers.keys(), ...ignoredPointers];
    pointers.clear();
    ignoredPointers.clear();
    finishSession();
    for (const id of ids) release(id);
  };
  const down = (event) => {
    if (event.pointerType !== "touch") {
      if (pointers.size) {
        ignoredPointers.add(event.pointerId);
        consume(event);
        capture(event.pointerId);
        return;
      }
      mousePointers.add(event.pointerId);
      return;
    }
    if (mousePointers.size) {
      // The first input stream owns the gesture. Letting just a touch-down or
      // touch-up reach OrbitControls midway through a mouse drag changes its
      // internal pointer count and can switch the mouse into touch handling.
      ignoredPointers.add(event.pointerId);
      consume(event);
      capture(event.pointerId);
      return;
    }
    if (controls.enabled === false || !finitePoint(event)) return;
    consume(event);
    if (pointers.has(event.pointerId)) return;
    if (pointers.size) apply({ flush: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    singleDragStarted = false;
    resetPairIntent();
    capture(event.pointerId);
    if (!active) {
      active = true;
      drainDamping();
    }
    rebase();
  };
  const move = (event) => {
    if (ignoredPointers.has(event.pointerId)) {
      consume(event);
      return;
    }
    if (event.pointerType !== "touch" || !pointers.has(event.pointerId)) return;
    consume(event);
    if (!finitePoint(event)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pairUpdates.add(event.pointerId);
    schedule();
  };
  const finish = (event) => {
    if (ignoredPointers.has(event.pointerId)) {
      ignoredPointers.delete(event.pointerId);
      consume(event);
      release(event.pointerId);
      return;
    }
    if (event.pointerType !== "touch" && !pointers.has(event.pointerId)) {
      mousePointers.delete(event.pointerId);
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    consume(event);
    if (event.type === "pointerup") {
      if (finitePoint(event))
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      apply({ flush: true });
    } else cancelPending();
    pointers.delete(event.pointerId);
    singleDragStarted = false;
    resetPairIntent();
    release(event.pointerId);
    if (pointers.size) rebase();
    else finishSession();
  };
  const blur = () => {
    reset();
    mousePointers.clear();
  };
  const events = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", finish],
    ["pointercancel", finish],
    ["lostpointercapture", finish],
  ];
  for (const [name, listener] of events)
    element.addEventListener(name, listener, { capture: true, passive: false });
  const window = element.ownerDocument?.defaultView;
  window?.addEventListener("blur", blur);
  const binding = {
    refresh() {
      if (!disposed) reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      blur();
      for (const [name, listener] of events)
        element.removeEventListener(name, listener, { capture: true });
      window?.removeEventListener("blur", blur);
      touchBindings.delete(controls);
    },
  };
  touchBindings.set(controls, binding);
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
