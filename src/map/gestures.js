import { Plane, Raycaster, TOUCH, Vector2, Vector3 } from "three";

const touchBindings = new WeakMap();
const planModes = new WeakMap();
const UP = new Vector3(0, 1, 0);
const MIN_SPAN = 12;

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

/** A single touch pans the map; two touches simultaneously pan, pinch and turn
 * its bearing. Touches never change camera pitch. Stable pointer IDs and one
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
  let disposed = false;
  let singleDragStarted = false;

  const points = () =>
    [...pointers.entries()].map(([id, point]) => ({ id, ...point }));
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
  const apply = () => {
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
      rebase();
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
    const position = camera.position.clone();
    const target = controls.target.clone();
    const up = camera.up.clone();
    const zoom = camera.zoom;
    const height = controls.target.y;
    const anchor =
      controls.enablePan !== false
        ? groundPoint(before, rect, camera, height)
        : null;
    const pair =
      current.length === 2 && before.span >= MIN_SPAN && after.span >= MIN_SPAN;
    if (pair && controls.enableZoom !== false) {
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
    if (pair && controls.enableTouchRotate !== false) {
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
      const under = groundPoint(after, rect, camera, height);
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
    if (!active) return;
    active = false;
    controls.dispatchEvent({ type: "end" });
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
    if (pointers.size) apply();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    singleDragStarted = false;
    capture(event.pointerId);
    if (!active) {
      active = true;
      controls.dispatchEvent({ type: "start" });
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
      apply();
    } else cancelPending();
    pointers.delete(event.pointerId);
    singleDragStarted = false;
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
