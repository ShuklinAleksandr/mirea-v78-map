import * as THREE from "three";
import { buildingAtPoint, convexHull } from "../data/spatial.js";
import { createExterior, createMapContext } from "./exterior.js";
import { createEntranceHall, createIndoorHallDetails } from "./hall.js";
import { presentPlaceIdentity } from "../data/place-location.js";
import { GPS_MAX_AGE_MS } from "../location.js";
import {
  pickLocationSurface,
  presentLocationOnMap,
  presentUserHeading,
  USER_HEADING_MAX_AGE_MS,
} from "./location-view.js";
import { getHallAdjacencyView } from "./hall-adjacency.js";
import { getStairPartitionView } from "./stair-partitions.js";
import hallAdjacency from "../data/hall-adjacency.json" with { type: "json" };
import { getIndoorDisplayGeometry } from "./indoor-overrides.js";
import {
  getBuildingFloorView,
  getBuildingScopePolygonIds,
} from "./building-view.js";
import {
  createStaircase,
  getMapStairMarkers,
  getStairDisplayCutouts,
  getStairRoutePaths,
  presentStairIdentity,
  stairLayoutFor,
  withStairDisplayCutouts,
} from "./stairs.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createRenderLifecycle } from "./render-lifecycle.js";
import {
  bindMapTouchRotation,
  configureMapTouchControls,
  createMapTapGuard,
} from "./gestures.js";
import {
  createRouteLayer,
  createSchematicConnection,
  disposeRouteLayer,
  routeBounds,
} from "./route.js";

const COLORS = {
  room: 0xe2e8ef,
  corridor: 0xf5f3ec,
  stairs: 0xcbd9ee,
  elevator: 0xcbd9ee,
  toilet: 0xd6e5ed,
  unknown: 0xe8e5df,
  unclassified: 0xe8e5df,
  circulation: 0xf5f3ec,
  hall: 0xf5f3ec,
  entrance: 0xcbdedb,
};
const vec = (p) => new THREE.Vector3(p[0], 0, p[1]);
const shapes = (polygon) => {
  if (!polygon.points || polygon.points.length < 3) return null;
  const s = new THREE.Shape(
    polygon.points.map((p) => new THREE.Vector2(p[0], -p[1])),
  );
  for (const h of polygon.holes || [])
    if (h.length > 2)
      s.holes.push(
        new THREE.Path(h.map((p) => new THREE.Vector2(p[0], -p[1]))),
      );
  return s;
};
function flatGeometry(p, y = 0.12) {
  const s = shapes(p);
  if (!s) return null;
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
function solidGeometry(p, depth, elevation = 0) {
  const s = shapes(p);
  if (!s) return null;
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: false,
    curveSegments: 2,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, elevation, 0);
  return g;
}
function cleanup(group) {
  const mats = new Set();
  group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) for (const m of [].concat(o.material)) mats.add(m);
  });
  for (const m of mats) {
    m.map?.dispose();
    m.dispose();
  }
  group.clear();
}
export class AtlasScene {
  constructor(host, callbacks = {}) {
    this.host = host;
    this.callbacks = callbacks;
    this.mode = "overview";
    this.plan = false;
    this.labelsOn = true;
    this.theme = "light";
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.materialColors = new WeakMap();
    this.pickables = [];
    this.roomLabels = [];
    this.floorHeight = 3.6;
    this.wallHeight = 2.7;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#eef1f5");
    this.perspectiveCamera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
    this.planCamera = new THREE.OrthographicCamera(
      -100,
      100,
      100,
      -100,
      0.5,
      5000,
    );
    this.planCamera.up.set(0, 0, -1);
    this.camera = this.perspectiveCamera;
    this.dirty = true;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.94;
    host.prepend(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Интерактивная 3D-карта кампуса",
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 2500;
    this.controls.screenSpacePanning = true;
    configureMapTouchControls(this.controls, this.plan);
    this.touchRotation = bindMapTouchRotation(this.controls);
    this.controls.addEventListener("start", () => {
      this.transition = null;
      this.callbacks.onMapInteraction?.();
    });
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      this.updateLocationPickPreview();
    });
    this.hemisphere = new THREE.HemisphereLight(0xf8fbff, 0xa7adb5, 1.9);
    this.scene.add(this.hemisphere);
    this.sun = new THREE.DirectionalLight(0xfff7ed, 2.2);
    this.sun.position.set(-150, 240, 130);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.12;
    this.scene.add(this.sun, this.sun.target);
    this.model = new THREE.Group();
    this.context = new THREE.Group();
    this.selection = new THREE.Group();
    this.hover = new THREE.Group();
    this.scene.add(this.model, this.context, this.selection, this.hover);
    const ground = (this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 1 }),
    ));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.28;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "map-labels";
    host.append(this.labelLayer);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    const tap = createMapTapGuard();
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      tap.down(e);
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (tap.up(e)) {
        if (this.locationPicking) {
          this.updateLocationPickPreview({ force: true });
          return;
        }
        const hit = this.hit(e);
        if (hit?.routeFloor) this.callbacks.onRouteFloor?.(hit.routeFloor);
        else if (hit?.room) this.callbacks.onRoom?.(hit.room);
        else if (hit?.building) this.callbacks.onBuilding?.(hit.building);
        else if (hit?.external) this.callbacks.onExternal?.(hit.external);
        else this.callbacks.onEmpty?.();
      }
    });
    this.renderer.domElement.addEventListener("pointercancel", (e) =>
      tap.cancel(e),
    );
    this.renderer.domElement.addEventListener("lostpointercapture", (e) =>
      tap.cancel(e),
    );
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      tap.move(e);
      if (e.buttons || e.pointerType === "touch") return;
      this.mouseEvent = e;
    });
    this.renderer.domElement.addEventListener("pointerleave", () => {
      this.mouseEvent = null;
      this.showHover(null);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.startRendering();
  }
  startRendering(options = {}) {
    this.renderLifecycle?.dispose();
    this.renderPausedAt ??= performance.now();
    this.renderLifecycle = createRenderLifecycle({
      ...options,
      render: () => this.animate(),
      onPause: () => {
        this.renderPausedAt = performance.now();
        this.mouseEvent = null;
      },
      onResume: () => {
        if (this.transition && this.renderPausedAt != null) {
          // Preserve the camera transition's progress across time in background.
          this.transition.start +=
            performance.now() -
            Math.max(this.transition.start, this.renderPausedAt);
        }
        this.renderPausedAt = null;
        this.resize();
        this.invalidate(true);
      },
    });
  }
  invalidate(shadows = false) {
    this.dirty = true;
    if (shadows) this.renderer.shadowMap.needsUpdate = true;
  }
  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    const previous = this.perspectiveCamera.aspect;
    const aspect = width / height;
    this.renderer.setSize(width, height);
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    const half = (this.planCamera.top - this.planCamera.bottom) / 2;
    this.planCamera.left = -half * aspect;
    this.planCamera.right = half * aspect;
    this.planCamera.updateProjectionMatrix();
    if (this.lastBounds && previous !== aspect) {
      this.fit(
        this.lastBounds,
        false,
        this.lastFitPadding,
        this.lastFitOptions,
      );
    }
    this.updateLocationPickPreview({ force: true });
    this.invalidate();
  }
  setProjection(plan, { fit = false } = {}) {
    if (plan && (this.routeOverview || this.buildingOverview))
      this.setRouteOverview(false);
    if (plan === this.plan) return;
    this.transition = null;
    const target = this.controls.target.clone(),
      distance = this.camera.position.distanceTo(target);
    if (plan) {
      this.lastPerspectiveOffset = this.camera.position.clone().sub(target);
      const half =
        distance *
        Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov / 2));
      this.planCamera.top = half;
      this.planCamera.bottom = -half;
      this.planCamera.left = -half * this.perspectiveCamera.aspect;
      this.planCamera.right = half * this.perspectiveCamera.aspect;
      this.planCamera.zoom = 1;
      this.planCamera.position.copy(target).add(new THREE.Vector3(0, 1500, 0));
      this.planCamera.lookAt(target);
      this.planCamera.updateProjectionMatrix();
      this.camera = this.planCamera;
    } else {
      const half =
          (this.planCamera.top - this.planCamera.bottom) /
          (2 * this.planCamera.zoom),
        dist =
          half /
          Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov / 2));
      const direction = (
        this.lastPerspectiveOffset || new THREE.Vector3(0.35, 0.9, 1)
      )
        .clone()
        .normalize();
      this.perspectiveCamera.position
        .copy(target)
        .addScaledVector(direction, dist);
      this.camera = this.perspectiveCamera;
    }
    this.plan = plan;
    this.controls.object = this.camera;
    this.controls.enableRotate = !plan;
    this.controls.mouseButtons.LEFT = plan
      ? THREE.MOUSE.PAN
      : THREE.MOUSE.ROTATE;
    configureMapTouchControls(this.controls, plan);
    if (this.locationPicking) this.configureLocationPickingControls();
    // Lock the plan even when switching during a damped drag. Disabling input
    // alone would leave OrbitControls' existing rotation momentum active.
    this.controls.minPolarAngle = plan ? 0.000001 : 0;
    this.controls.maxPolarAngle = plan ? 0.000001 : Math.PI / 2 - 0.04;
    this.controls.target.copy(target);
    this.controls.update();
    if (fit)
      this.fit(this.lastBounds, true, this.lastFitPadding, this.lastFitOptions);
    this.invalidate();
  }
  setAssumptions(a) {
    this.floorHeight = a.floorHeight;
    this.wallHeight = a.wallHeight;
    this.assumptions = a;
  }
  setExterior(data, context = null, style = {}, hall = null, special = null) {
    this.specialExterior = special;
    this.entranceHall = hall;
    this.exteriorStyle = style;
    this.exteriorData = data.campuses;
    this.exteriorContext = context;
  }
  streetView() {
    this.setProjection(false);
    if (this.mode !== "overview") this.setOverview();
    const entrance = this.floors
      .flatMap((f) => f.polygons)
      .find((p) => p.kind === "entrance" && p.label === "Главный вход");
    if (entrance?.center) {
      const [x, z] = entrance.center;
      this.moveCamera(
        new THREE.Vector3(x + 20, 10, z + 120),
        new THREE.Vector3(x, 8, z - 35),
      );
    } else {
      const b = this.allBounds(),
        x = (b[0] + b[2]) / 2,
        z = b[3];
      this.moveCamera(
        new THREE.Vector3(x, 12, z + 95),
        new THREE.Vector3(x, 8, z - 35),
      );
    }
  }
  setCampus(campus, floors) {
    this.clearRoute({ rebuild: false });
    this.campus = campus;
    this.floors = floors;
    this.buildingCenters = {};
    for (const f of floors)
      for (const p of f.polygons || []) {
        if (!p.building || !p.center) continue;
        (this.buildingCenters[p.building] ??= []).push(p.center);
      }
    for (const [b, ps] of Object.entries(this.buildingCenters)) {
      this.buildingCenters[b] = [
        ps.reduce((s, p) => s + p[0], 0) / ps.length,
        ps.reduce((s, p) => s + p[1], 0) / ps.length,
      ];
    }
    this.setOverview();
  }
  setUserLocation(location) {
    clearTimeout(this.userLocationExpiryTimer);
    this.userLocation = location || null;
    if (!location) {
      this.userLocationFollowAnchor = null;
      this.userLocationFollowContext = null;
    }
    if (location?.source === "gps") {
      const expiresAt = Math.min(
        location.expiresAt ?? location.timestamp + GPS_MAX_AGE_MS,
        location.correction?.expiresAt ?? Infinity,
      );
      const remaining = expiresAt - Date.now();
      if (remaining > 0)
        this.userLocationExpiryTimer = setTimeout(
          () => this.refreshUserLocation(),
          remaining + 10,
        );
    }
    this.refreshUserLocation();
  }
  setSurveyLocation(location) {
    this.surveyLocation = location || null;
    this.refreshSurveyLocation();
  }
  setUserHeading(heading) {
    clearTimeout(this.userHeadingExpiryTimer);
    this.userHeading = heading || null;
    const remaining = heading?.timestamp + USER_HEADING_MAX_AGE_MS - Date.now();
    if (remaining > 0)
      this.userHeadingExpiryTimer = setTimeout(() => {
        this.updateUserHeading();
        this.updateUserLocationOverlay();
        this.invalidate();
      }, remaining + 10);
    this.updateUserHeading();
    this.updateUserLocationOverlay();
    this.invalidate();
  }
  updateUserHeading() {
    const layer = this.userLocationLayer;
    if (!layer) return;
    const presentation =
      !layer.userData.presentation?.stale &&
      presentUserHeading(this.userHeading, this.userLocation);
    let arrow = layer.userData.heading;
    if (!presentation || !layer.visible) {
      if (arrow) arrow.visible = false;
      layer.userData.headingPresentation = null;
      return;
    }
    if (!arrow || arrow.parent !== layer) {
      arrow = new THREE.Group();
      arrow.name = "phone-facing-heading";
      const geometry = (points) => {
        const shape = new THREE.BufferGeometry();
        shape.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(points.flat(), 3),
        );
        return shape;
      };
      const cone = new THREE.Mesh(
        geometry([
          [0, 0.04, 0],
          [-2.6, 0.04, -6],
          [2.6, 0.04, -6],
        ]),
        new THREE.MeshBasicMaterial({
          color: 0x2585ff,
          transparent: true,
          opacity: 0.18,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      cone.renderOrder = 31;
      const pointer = new THREE.Mesh(
        geometry([
          [0, 0.06, -3.3],
          [-1.05, 0.06, -1.25],
          [0, 0.06, -1.85],
          [0, 0.06, -3.3],
          [0, 0.06, -1.85],
          [1.05, 0.06, -1.25],
        ]),
        new THREE.MeshBasicMaterial({
          color: 0x1769d2,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      pointer.renderOrder = 33;
      arrow.add(cone, pointer);
      arrow.userData.cone = cone;
      layer.add(arrow);
      layer.userData.heading = arrow;
    }
    arrow.visible = true;
    arrow.rotation.y = Math.atan2(
      -presentation.vector[0],
      -presentation.vector[1],
    );
    arrow.userData.cone.scale.x = THREE.MathUtils.clamp(
      (presentation.accuracyDegrees ?? 30) / 30,
      0.5,
      2.5,
    );
    layer.userData.headingPresentation = presentation;
    this.updateUserLocationScale();
  }
  refreshUserLocation() {
    // Stack builders inherit this scene. Their temporary floor rebuilds must
    // never own, hide or dispose either real location marker.
    if (this.stackDisplay) return;
    this.refreshLocationMarker(this.userLocation, false);
    this.refreshSurveyLocation();
  }
  refreshSurveyLocation() {
    if (this.stackDisplay) return;
    this.refreshLocationMarker(this.surveyLocation, true);
  }
  refreshLocationMarker(location, survey) {
    const prefix = survey ? "surveyLocation" : "userLocation";
    this.invalidate();
    const layer = this[`${prefix}Layer`];
    if (this[`${prefix}Overlay`]) this[`${prefix}Overlay`].hidden = true;
    if (layer) {
      cleanup(layer);
      layer.visible = false;
    }
    const presentation = presentLocationOnMap(location, {
      campusId: this.campus?.id,
      mode: this.mode,
      floor: this.floor,
      floors: this.floors,
      stages: this.routeStages,
      survey,
    });
    if (!this.scene || !presentation) return;
    const gps = location.source === "gps";
    const group = layer || new THREE.Group();
    if (!layer) {
      this[`${prefix}Layer`] = group;
      group.name = survey ? "wifi-survey-reference" : "current-user-location";
      this.scene.add(group);
    }
    group.userData.role = survey
      ? "wifi-survey-reference"
      : gps
        ? presentation.floorState === "unknown"
          ? "gps-location-floor-unknown"
          : "gps-user-location"
        : "manual-user-location";
    group.userData.location = location;
    group.userData.presentation = presentation;
    group.position.set(location.point[0], presentation.y, location.point[1]);
    const color = survey ? 0xa855f7 : presentation.stale ? 0x8997a7 : 0x2585ff;
    if (gps && Number.isFinite(location.accuracyRadiusMap)) {
      const circle = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(0.5, location.accuracyRadiusMap), 64),
        new THREE.MeshBasicMaterial({
          color,
          opacity: presentation.stale ? 0.08 : 0.16,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      circle.name = "gps-provider-accuracy";
      circle.rotation.x = -Math.PI / 2;
      circle.renderOrder = 30;
      group.add(circle);
    }
    const dot = new THREE.Group();
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        opacity: presentation.stale ? 0.6 : 1,
        transparent: presentation.stale,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const center = new THREE.Mesh(
      new THREE.CircleGeometry(0.68, 32),
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    halo.rotation.x = center.rotation.x = -Math.PI / 2;
    center.position.y = 0.02;
    halo.renderOrder = 31;
    center.renderOrder = 32;
    dot.add(halo, center);
    group.add(dot);
    group.userData.dot = dot;
    group.visible = true;
    if (!survey) this.updateUserHeading();
    this.updateUserLocationScale();
    this.updateLocationOverlay(survey);
    this.invalidate();
  }
  updateUserLocationOverlay() {
    return this.updateLocationOverlay(false);
  }
  updateSurveyLocationOverlay() {
    return this.updateLocationOverlay(true);
  }
  updateLocationOverlay(survey) {
    const prefix = survey ? "surveyLocation" : "userLocation";
    const layer = this[`${prefix}Layer`];
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (
      !layer?.visible ||
      this.stackDisplay ||
      !this.camera ||
      !width ||
      !height
    ) {
      if (this[`${prefix}Overlay`]) this[`${prefix}Overlay`].hidden = true;
      return null;
    }
    const projected = layer.position.clone().project(this.camera);
    const x = (projected.x * 0.5 + 0.5) * width,
      y = (-projected.y * 0.5 + 0.5) * height;
    const visible =
      projected.z > -1 &&
      projected.z < 1 &&
      x > 8 &&
      x < width - 8 &&
      y > 8 &&
      y < height - 8;
    const location = layer.userData.location;
    const presentation = layer.userData.presentation;
    const label = presentation.label;
    const hasHeading = Boolean(!survey && layer.userData.headingPresentation);
    let overlay = this[`${prefix}Overlay`];
    if (!overlay && globalThis.document?.createElement && this.host.append) {
      overlay = document.createElement("div");
      overlay.className = `user-location-marker${survey ? " survey-location-marker" : ""}`;
      overlay.setAttribute("role", "img");
      const dot = document.createElement("span");
      dot.className = "user-location-dot";
      const caption = document.createElement("span");
      caption.className = "user-location-label";
      overlay.append(dot, caption);
      this[`${prefix}Overlay`] = overlay;
      this[`${prefix}Caption`] = caption;
      this.host.append(overlay);
    }
    if (overlay) {
      overlay.hidden = !visible;
      overlay.dataset.source = survey ? "survey" : location.source;
      overlay.dataset.floorState = presentation.floorState;
      overlay.dataset.projection = String(presentation.projection);
      overlay.dataset.stale = String(presentation.stale);
      overlay.dataset.heading = String(hasHeading);
      overlay.style.opacity = presentation.stale ? "0.65" : "1";
      overlay.style.transform = `translate(${x}px,${y}px)`;
      overlay.setAttribute(
        "aria-label",
        [
          label,
          !survey ? layer.userData.headingPresentation?.label : null,
          presentation.floorState === "unknown"
            ? "этаж не определён автоматически"
            : null,
          presentation.projection ? "проекция на видимый уровень карты" : null,
          survey
            ? "неподвижная точка замера Wi-Fi"
            : location.source === "gps"
              ? "привязка карты приблизительная"
              : "точка указана вручную",
        ]
          .filter(Boolean)
          .join(", "),
      );
      this[`${prefix}Caption`].textContent = label;
      // Leave the phone-facing arrow visible when it points toward the label.
      this[`${prefix}Caption`].style.bottom = hasHeading ? "48px" : "14px";
    }
    if (!visible) return null;
    // Actual projected pixels reserve space ahead of room and route labels.
    return {
      x,
      y: y - (hasHeading ? 24 : 13),
      w: Math.max(hasHeading ? 84 : 64, label.length * 7 + 18),
      h: hasHeading ? 120 : 48,
    };
  }
  updateUserLocationScale() {
    for (const layer of [this.userLocationLayer, this.surveyLocationLayer]) {
      if (!layer?.visible || !layer.userData.dot || !this.camera) continue;
      const height = Math.max(1, this.host.clientHeight);
      const unitsPerPixel = this.camera.isOrthographicCamera
        ? (this.camera.top - this.camera.bottom) / this.camera.zoom / height
        : (2 *
            this.camera.position.distanceTo(layer.position) *
            Math.tan((this.camera.fov * Math.PI) / 360)) /
          height;
      layer.userData.dot.scale.setScalar(Math.max(0.04, unitsPerPixel * 7));
      if (layer.userData.heading)
        layer.userData.heading.scale.setScalar(
          Math.max(0.04, unitsPerPixel * 7),
        );
    }
  }
  focusUserLocation({ padding } = {}) {
    this.refreshUserLocation();
    if (!this.userLocationLayer?.visible) return false;
    const [x, z] = this.userLocation.point;
    const y = this.userLocationLayer.position.y;
    const radius = 12;
    this.fit(
      [x - radius, z - radius, x + radius, z + radius],
      true,
      padding || this.callbacks.getViewportPadding?.(),
      { targetY: y, verticalBounds: [y - 1, y + 2] },
    );
    this.userLocationFollowAnchor = new THREE.Vector3(x, y, z);
    this.userLocationFollowContext = this.locationFollowContextKey();
    return true;
  }
  locationFollowContextKey() {
    return [
      this.campus?.id,
      this.mode,
      this.floor?.id,
      this.building,
      this.plan ? "2d" : "3d",
    ].join(":");
  }
  followUserLocation() {
    if (
      !this.userLocationLayer?.visible ||
      this.userLocationLayer.userData.presentation?.stale ||
      this.locationPicking
    )
      return false;
    const anchor = this.userLocationLayer.position.clone();
    if (
      !this.userLocationFollowAnchor ||
      !this.controls?.target ||
      this.userLocationFollowContext !== this.locationFollowContextKey()
    )
      return this.focusUserLocation();
    const delta = anchor.clone().sub(this.userLocationFollowAnchor);
    if (delta.lengthSq() < 1e-12) return true;
    const position = (this.transition?.to || this.camera.position)
      .clone()
      .add(delta);
    const target = (this.transition?.toTarget || this.controls.target)
      .clone()
      .add(delta);
    this.moveCamera(position, target, true);
    if (this.lastBounds)
      this.lastBounds = this.lastBounds.map(
        (value, i) => value + (i % 2 ? delta.z : delta.x),
      );
    if (this.lastFitOptions && delta.y)
      this.lastFitOptions = {
        ...this.lastFitOptions,
        ...(Number.isFinite(this.lastFitOptions.targetY)
          ? { targetY: this.lastFitOptions.targetY + delta.y }
          : {}),
        ...(this.lastFitOptions.verticalBounds
          ? {
              verticalBounds: this.lastFitOptions.verticalBounds.map(
                (value) => value + delta.y,
              ),
            }
          : {}),
      };
    this.userLocationFollowAnchor = anchor;
    return true;
  }
  configureLocationPickingControls() {
    if (!this.controls) return;
    this.controls.enableRotate = !this.plan && !this.locationPicking;
    if (this.controls.mouseButtons)
      this.controls.mouseButtons.LEFT =
        this.plan || this.locationPicking
          ? THREE.MOUSE.PAN
          : THREE.MOUSE.ROTATE;
    if (this.controls.touches)
      configureMapTouchControls(
        this.controls,
        this.plan || this.locationPicking,
      );
  }
  setLocationPicking(value) {
    const enabled = Boolean(value && this.mode === "floor");
    this.locationPicking = enabled;
    this.configureLocationPickingControls();
    if (this.host.dataset) this.host.dataset.locationPicking = String(enabled);
    if (this.labelLayer) this.labelLayer.inert = enabled;
    if (enabled) this.showHover(null);
    this.host.style.cursor = "grab";
    this.lastLocationPickPreviewAt = null;
    if (enabled) this.updateLocationPickPreview({ force: true });
    else this.callbacks?.onPositionPickPreview?.(null);
    return enabled;
  }
  getCenterLocationPick({ padding } = {}) {
    if (!this.locationPicking || this.mode !== "floor") return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const inset = padding || this.callbacks?.getViewportPadding?.() || {};
    const x = THREE.MathUtils.clamp(
      ((inset.left || 0) + rect.width - (inset.right || 0)) / 2,
      8,
      rect.width - 8,
    );
    const y = THREE.MathUtils.clamp(
      ((inset.top || 0) + rect.height - (inset.bottom || 0)) / 2,
      8,
      rect.height - 8,
    );
    this.host?.style?.setProperty?.("--location-pick-x", `${x}px`);
    this.host?.style?.setProperty?.("--location-pick-y", `${y}px`);
    return this.pickUserLocation({
      clientX: rect.left + x,
      clientY: rect.top + y,
    });
  }
  updateLocationPickPreview({ force = false } = {}) {
    if (!this.locationPicking) return;
    const now = performance.now();
    if (
      !force &&
      this.lastLocationPickPreviewAt != null &&
      now - this.lastLocationPickPreviewAt < 100
    )
      return;
    this.lastLocationPickPreviewAt = now;
    this.callbacks?.onPositionPickPreview?.(this.getCenterLocationPick());
  }
  pickUserLocation(event) {
    if (this.mode !== "floor" || !this.floor || !this.locationPicking)
      return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.16),
      new THREE.Vector3(),
    );
    if (
      !hit ||
      this.clipPlanes?.some((plane) => plane.distanceToPoint(hit) < 0)
    )
      return null;
    const point = [hit.x, hit.z];
    const floor = this.locationFloor || this.floor;
    const surface = pickLocationSurface(floor, point, {
      building: this.building || null,
      cutouts: this.locationCutouts || getStairDisplayCutouts(floor),
      wallThickness: this.assumptions?.wallThickness || 0.2,
    });
    if (!surface) return null;
    return {
      point,
      floorId: this.floor.id,
      campusId: this.campus.id,
      ...surface,
    };
  }

  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
    if (this.reducedMotion && this.transition) {
      this.moveCamera(this.transition.to, this.transition.toTarget, false);
      this.transition = null;
    }
  }
  setQuality(quality = "auto") {
    const low = quality === "low";
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, low ? 1 : quality === "high" ? 2 : 1.5),
    );
    this.renderer.shadowMap.enabled = !low;
    this.resize();
    this.invalidate(true);
  }
  applyTheme() {
    if (!this.materialColors) this.materialColors = new WeakMap();
    const dark = this.theme === "dark";
    for (const group of [this.model, this.context]) {
      group?.traverse((object) => {
        for (const material of [].concat(object.material || [])) {
          if (!material.color) continue;
          if (!this.materialColors.has(material))
            this.materialColors.set(material, material.color.clone());
          material.color.copy(this.materialColors.get(material));
          if (dark) {
            const hsl = {};
            material.color.getHSL(hsl);
            material.color.setHSL(
              0.61,
              Math.min(0.28, hsl.s + 0.09),
              0.08 + hsl.l * 0.19,
            );
          }
        }
      });
    }
  }
  setTheme(theme = "light") {
    this.theme = theme === "dark" ? "dark" : "light";
    const dark = this.theme === "dark";
    this.scene.background.set(dark ? 0x111a28 : 0xeef1f5);
    this.ground.material.color.set(dark ? 0x111a28 : 0xeef1f5);
    this.hemisphere.intensity = dark ? 2.2 : 1.9;
    this.sun.intensity = dark ? 1.4 : 2.2;
    this.renderer.toneMappingExposure = dark ? 1.08 : 0.94;
    if (this.routeOverview || this.buildingOverview) {
      this.setRouteOverview(true, {
        focusFloorId: this.floor?.id,
        building: this.buildingOverview ? this.stackBuilding : null,
      });
      return;
    }
    this.applyTheme();
    this.refreshRoute();
    this.invalidate(true);
  }
  setRoute(route, { focus = true, padding, paddingBottom } = {}) {
    const hadRoute = Boolean(this.route);
    this.route = route?.ok === false ? null : route;
    // A route uses an unclipped floor cutaway so inter-wing corridors remain
    // visible. Floor choice itself stays with the application controller.
    if (this.floor && (!hadRoute || !this.route || this.clipPlanes))
      this.setFloor(this.floor, this.building, { fit: false });
    else this.refreshRoute();
    if (focus) this.focusRoute({ padding, paddingBottom });
  }
  clearRoute({ rebuild = true } = {}) {
    const hadRoute = Boolean(this.route);
    this.setRouteGuidance(null);
    this.route = null;
    this.refreshRoute();
    if (hadRoute && rebuild && this.floor)
      this.setFloor(this.floor, this.building, { fit: false });
    this.invalidate();
  }
  setRouteGuidance(sample, { padding, animate = false } = {}) {
    if (!sample) {
      if (this.guidanceLayer) {
        cleanup(this.guidanceLayer);
        this.guidanceLayer.removeFromParent();
      }
      this.guidanceLayer =
        this.guidanceAnchor =
        this.guidanceKey =
        this.guidanceViewport =
          null;
      this.invalidate();
      return true;
    }
    const validPoint = (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      point.slice(0, 2).every(Number.isFinite);
    if (
      this.mode !== "floor" ||
      this.floor?.id !== sample.floorId ||
      !validPoint(sample.position) ||
      !validPoint(sample.heading) ||
      !sample.cameraPoints?.length ||
      !sample.cameraPoints.every(validPoint)
    )
      return false;
    if (!this.guidanceLayer) {
      const group = (this.guidanceLayer = new THREE.Group());
      group.name = "route-preview-position";
      group.userData.role = "route-preview-not-geolocation";
      const material = new THREE.MeshBasicMaterial({
        color: 0xf28a27,
        depthTest: false,
        depthWrite: false,
      });
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.45, 0.63, 32),
        material,
      );
      ring.rotation.x = -Math.PI / 2;
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 0.85, 3),
        material,
      );
      arrow.rotation.x = Math.PI / 2;
      arrow.position.z = 0.45;
      group.add(ring, arrow);
      group.traverse((object) => (object.renderOrder = 25));
      this.scene.add(group);
    }
    this.guidanceLayer.position.set(
      sample.position[0],
      0.65,
      sample.position[1],
    );
    this.guidanceLayer.rotation.y = Math.atan2(
      sample.heading[0],
      sample.heading[1],
    );
    const xs = sample.cameraPoints.map((point) => point[0]);
    const zs = sample.cameraPoints.map((point) => point[1]);
    const bounds = [
      Math.min(...xs) - 2,
      Math.min(...zs) - 2,
      Math.max(...xs) + 2,
      Math.max(...zs) + 2,
    ];
    const anchor = new THREE.Vector3(
      (bounds[0] + bounds[2]) / 2,
      0,
      (bounds[1] + bounds[3]) / 2,
    );
    // The source window has at most 18 m ahead + 3 m behind. A fixed square
    // includes that window at every turn without changing zoom/azimuth as a
    // formerly horizontal leg becomes vertical in world coordinates.
    const halfSpan = Math.max(
      13,
      (bounds[2] - bounds[0]) / 2,
      (bounds[3] - bounds[1]) / 2,
    );
    const framingBounds = [
      anchor.x - halfSpan,
      anchor.z - halfSpan,
      anchor.x + halfSpan,
      anchor.z + halfSpan,
    ];
    const key = `${sample.floorId}:${sample.sectionIndex}`;
    const inset = padding || this.callbacks?.getViewportPadding?.() || {};
    const viewport = [
      this.host.clientWidth,
      this.host.clientHeight,
      ...["top", "bottom", "left", "right"].map((side) =>
        Math.round(inset[side] || 0),
      ),
    ].join(":");
    if (
      animate ||
      this.guidanceKey !== key ||
      !this.guidanceAnchor ||
      this.guidanceViewport !== viewport
    ) {
      this.fit(framingBounds, animate, padding);
    } else {
      // Keep the chosen zoom and angle during movement, including manual
      // panning. Re-fitting every animation frame would rotate and pump zoom.
      const delta = anchor.clone().sub(this.guidanceAnchor);
      if (this.transition) {
        this.transition.to.add(delta);
        this.transition.toTarget.add(delta);
      } else {
        this.camera.position.add(delta);
        this.controls.target.add(delta);
        this.controls.update();
      }
      if (this.lastBounds)
        this.lastBounds = this.lastBounds.map(
          (value, i) => value + (i % 2 ? delta.z : delta.x),
        );
    }
    this.guidanceKey = key;
    this.guidanceAnchor = anchor;
    this.guidanceViewport = viewport;
    this.invalidate();
    return true;
  }
  refreshRoute() {
    disposeRouteLayer(this.routeLayer);
    this.routeLayer = null;
    for (const label of this.roomLabels || [])
      if (label.kind === "route") label.el.remove?.();
    this.roomLabels = (this.roomLabels || []).filter(
      (label) => label.kind !== "route",
    );
    if (!this.route || !this.floor || !this.scene) return;
    const routeFloor = getHallAdjacencyView(this.floor);
    this.routeLayer = createRouteLayer(this.route, this.floor.id, {
      dark: this.theme === "dark",
      overlay: Boolean(this.stackDisplay),
      floor: routeFloor,
      protectedRegions: [
        ...getMapStairMarkers(this.floor).flatMap((marker) => {
          const layout = stairLayoutFor(marker, this.floor);
          return layout
            ? [
                layout.footprint.map(([u, v]) => [
                  layout.frame.origin[0] +
                    layout.frame.axisU[0] * u * layout.frame.size[0] +
                    layout.frame.axisV[0] * v * layout.frame.size[1],
                  layout.frame.origin[1] +
                    layout.frame.axisU[1] * u * layout.frame.size[0] +
                    layout.frame.axisV[1] * v * layout.frame.size[1],
                ]),
              ]
            : [];
        }),
        ...(routeFloor.userConfirmedDisplayAdjacency?.applied
          ? hallAdjacency.addedRoomRegions.map((region) => region.points)
          : []),
      ],
      stairPaths: getStairRoutePaths(this.route, this.floor, this.floorHeight, {
        stack: Boolean(this.stackDisplay),
      }).filter(
        (path) =>
          !this.stackDisplay || !path.points.some((point) => point[1] < 0),
      ),
    });
    this.scene.add(this.routeLayer.group);
    for (const [index, label] of this.routeLayer.labels.entries()) {
      const element = this.addLabel(
        label.text,
        label.point,
        0.55,
        "route",
        () => {},
        `route-${index}`,
      );
      element.style.pointerEvents = "none";
      element.setAttribute("aria-hidden", "true");
    }
    this.invalidate();
  }
  focusRoute({
    floorId = this.floor?.id,
    animate = true,
    padding,
    paddingBottom,
  } = {}) {
    if (this.routeOverview) {
      const bounds = this.routeOverviewBounds || this.allBounds();
      this.fit(
        bounds,
        animate,
        padding || {
          top: 90,
          bottom: paddingBottom ?? 100,
          left: 35,
          right: 70,
        },
      );
      return true;
    }
    const bounds = routeBounds(this.route, floorId);
    if (!bounds) return false;
    const viewportPadding = padding || {
      top: 105,
      left: 35,
      right: 70,
      bottom: paddingBottom ?? (this.host.clientWidth < 760 ? 280 : 100),
    };
    this.fit(bounds, animate, viewportPadding);
    return true;
  }
  updateRoute() {
    const layers = this.routeOverview
      ? this.routeLayers || []
      : [this.routeLayer].filter(Boolean);
    if (!layers.length) return;
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    for (const layer of layers) {
      for (const material of layer.materials)
        material.resolution.set(width, height);
      const forward = this.camera.getWorldDirection(new THREE.Vector3());
      const pixelScale = (position) =>
        this.plan
          ? (this.camera.top - this.camera.bottom) / (this.camera.zoom * height)
          : (2 *
              Math.max(
                0.1,
                position.clone().sub(this.camera.position).dot(forward),
              ) *
              Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) /
            height;
      for (const marker of layer.markers)
        marker.scale.setScalar(
          pixelScale(marker.getWorldPosition(new THREE.Vector3())) * 10,
        );
      const placed = [];
      for (const arrow of layer.arrows) {
        const worldPosition = arrow.getWorldPosition(new THREE.Vector3());
        const p = worldPosition.clone().project(this.camera);
        const screen = [(p.x * width) / 2, (p.y * height) / 2];
        arrow.visible =
          p.z > -1 &&
          p.z < 1 &&
          !placed.some(
            (q) => Math.hypot(screen[0] - q[0], screen[1] - q[1]) < 55,
          );
        if (arrow.visible) placed.push(screen);
        arrow.scale.setScalar(pixelScale(worldPosition) * 5);
      }
    }
  }
  setRouteOverview(
    enabled,
    {
      padding,
      paddingBottom,
      focusFloorId = this.floor?.id,
      building = null,
    } = {},
  ) {
    if (!enabled) {
      if (!this.routeOverview && !this.buildingOverview) return;
      const floor =
        this.floors.find((item) => item.id === focusFloorId) || this.floor;
      const wasBuilding = this.buildingOverview;
      this.setFloor(floor, this.building, { fit: false });
      if (wasBuilding)
        this.fit(this.boundsForBuilding(this.building, floor), true, padding);
      else this.focusRoute({ padding, paddingBottom });
      return;
    }
    if (!this.route?.segments?.length && !building) return;
    const route = building ? null : this.route;
    let activeFloor =
      this.floors.find((item) => item.id === focusFloorId) || this.floor;
    const visited = this.floors
      .filter((item) =>
        building
          ? item.polygons.some((polygon) => polygon.building === building)
          : route.segments.some((segment) => segment.floorId === item.id),
      )
      .sort((a, b) => a.level - b.level);
    if (!visited.length) return false;
    if (!visited.some((floor) => floor.id === activeFloor?.id))
      activeFloor = visited[0];
    this.setProjection(false);
    this.clear();
    disposeRouteLayer(this.routeLayer);
    this.routeLayer = null;
    const stages = [],
      labels = [],
      pickables = [],
      layers = [];
    const floorBounds = visited.map((floor) => {
      if (building) return this.boundsForBuilding(building, floor);
      const routeBox = routeBounds(route, floor.id, 10);
      const buildings = [
        ...new Set(
          route.segments
            .filter((segment) => segment.floorId === floor.id)
            .flatMap((segment) =>
              (segment.nodes || [])
                .map((node) => node.building)
                .filter(Boolean),
            ),
        ),
      ];
      const boxes = [
        routeBox,
        ...buildings
          .map((name) => this.boundsForBuilding(name, floor))
          .filter(Boolean),
      ];
      return [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ];
    });
    for (const [index, floor] of visited.entries()) {
      // Reuse the regular floor builder in an isolated view object. Each stage
      // owns its geometry once; no clone shares disposable GPU resources.
      const view = Object.create(this);
      const active = floor.id === activeFloor.id;
      Object.assign(view, {
        scene: new THREE.Scene(),
        model: new THREE.Group(),
        context: new THREE.Group(),
        selection: new THREE.Group(),
        hover: new THREE.Group(),
        labelLayer: document.createElement("div"),
        roomLabels: [],
        pickables: [],
        routeLayer: null,
        route,
        routeOverview: false,
        buildingOverview: false,
        routeLayers: [],
        ground: null,
        neighborsOn: true,
        stackDisplay: true,
        stackActive: active,
        invalidate() {},
      });
      view.setFloor(floor, building, { fit: false });
      const stage = new THREE.Group();
      stage.name = `Stacked level ${floor.id}`;
      stage.position.y = (floor.level - visited[0].level) * this.floorHeight;
      stage.userData.routeFloorId = floor.id;
      stage.add(view.model, view.context);
      const bounds = floorBounds[index];
      const clipPlanes = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -bounds[0]),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), bounds[2]),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -bounds[1]),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds[3]),
      ];
      view.model.traverse((object) => {
        object.userData.routeFloorId = floor.id;
        if (!active) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
        for (const material of [].concat(object.material || [])) {
          material.clippingPlanes = [
            ...(material.clippingPlanes || []),
            ...clipPlanes,
          ];
          material.clipShadows = true;
          material.transparent = true;
          material.opacity = active ? 0.94 : object.isLineSegments ? 0.3 : 0.14;
          material.depthWrite = false;
        }
      });
      if (view.routeLayer) {
        if (!active) {
          for (const material of view.routeLayer.materials) {
            material.transparent = true;
            // Keep the whole journey legible: focused architecture and the
            // slightly wider active stroke already establish the floor focus.
            material.opacity = 0.88;
            material.linewidth *= 0.9;
          }
        }
        stage.add(view.routeLayer.group);
        layers.push(view.routeLayer);
      }
      for (const label of view.roomLabels) {
        if (label.kind !== "route" && (!active || label.kind !== "stairs"))
          continue;
        if (
          label.position.x < bounds[0] ||
          label.position.x > bounds[2] ||
          label.position.z < bounds[1] ||
          label.position.z > bounds[3]
        )
          continue;
        label.position.y += stage.position.y;
        labels.push(label);
      }
      const segment = route?.segments.find((item) => item.floorId === floor.id);
      const physicalNodes = (segment?.nodes || []).filter(
        (node) => node.physicalLevel != null,
      );
      const physical = building
        ? [
            `${building} · ${floor.buildingLevels?.[building] ?? floor.level} этаж`,
          ]
        : [
            ...new Set(
              (physicalNodes.length ? physicalNodes : segment?.nodes || []).map(
                (node) =>
                  node.physicalLevel != null
                    ? `${node.building ? `${node.building} · ` : ""}${node.physicalLevel} этаж`
                    : floor.label,
              ),
            ),
          ];
      const text = `${active ? "В фокусе · " : ""}${physical.join(" / ") || floor.label}`;
      const button = document.createElement("button");
      button.className = "map-label route floor-level";
      button.textContent = text;
      button.title = "Открыть этот этаж";
      button.onclick = () => this.callbacks.onRouteFloor?.(floor.id);
      button.style.pointerEvents = "auto";
      labels.push({
        el: button,
        position: new THREE.Vector3(
          (bounds[0] + bounds[2]) / 2,
          stage.position.y + 1.4,
          bounds[3] - 1,
        ),
        kind: "route",
        id: `level-${floor.id}`,
        activeFloor: active,
      });
      pickables.push(...view.pickables);
      stages.push({
        group: stage,
        floorId: floor.id,
        bounds,
        y: stage.position.y,
        view,
      });
    }
    cleanup(this.model);
    for (const stage of stages) this.model.add(stage.group);
    this.roomLabels = labels;
    this.labelLayer.replaceChildren(...labels.map((label) => label.el));
    this.pickables = pickables;
    this.routeLayers = layers;
    this.routeStages = stages;
    this.routeOverview = !building;
    this.buildingOverview = Boolean(building);
    this.stackBuilding = building;
    this.mode = building ? "building-overview" : "route-overview";
    this.floor = activeFloor;
    this.building = building;
    this.ground.position.y = -this.floorHeight - 0.5;
    for (const transition of route?.transitions || []) {
      const from = stages.find(
        (stage) => stage.floorId === transition.fromFloorId,
      );
      const to = stages.find((stage) => stage.floorId === transition.toFloorId);
      if (!from || !to) continue;
      const fromPath = getStairRoutePaths(
        route,
        from.view.floor,
        this.floorHeight,
        { stack: true },
      ).find(
        (path) =>
          path.sourceEdgeId === transition.sourceEdgeId &&
          !path.points.some((point) => point[1] < 0),
      );
      const toPath = getStairRoutePaths(
        route,
        to.view.floor,
        this.floorHeight,
        { stack: true },
      ).find(
        (path) =>
          path.sourceEdgeId === transition.sourceEdgeId &&
          !path.points.some((point) => point[1] < 0),
      );
      const a = fromPath
        ? [...fromPath.points.at(-1)]
        : [transition.point[0], 0.31, transition.point[1]];
      const b = toPath
        ? [...toPath.points[0]]
        : [transition.targetPoint[0], 0.31, transition.targetPoint[1]];
      a[1] += from.y;
      b[1] += to.y;
      if (Math.hypot(...a.map((value, i) => value - b[i])) < 0.35) continue;
      const connector = createSchematicConnection(
        [a, b],
        this.theme === "dark",
      );
      this.model.add(connector.group);
      this.routeLayers.push(connector);
    }
    this.model.updateMatrixWorld(true);
    const bounds = [
      Math.min(...stages.map((stage) => stage.bounds[0])),
      Math.min(...stages.map((stage) => stage.bounds[1])),
      Math.max(...stages.map((stage) => stage.bounds[2])),
      Math.max(...stages.map((stage) => stage.bounds[3])),
    ];
    // Frame the journey, retaining the surrounding floor geometry for panning.
    // Fitting entire buildings makes short stair routes unreadably small on phones.
    let framingBounds = bounds;
    if (route) {
      const routeBox = new THREE.Box3();
      for (const layer of this.routeLayers)
        routeBox.expandByObject(layer.group);
      if (!routeBox.isEmpty())
        framingBounds = [
          routeBox.min.x - 8,
          routeBox.min.z - 8,
          routeBox.max.x + 8,
          routeBox.max.z + 8,
        ];
    }
    this.refreshUserLocation();
    this.routeOverviewBounds = framingBounds;
    this.fit(
      framingBounds,
      true,
      padding || {
        top: 90,
        bottom: paddingBottom ?? (this.host.clientWidth < 760 ? 280 : 100),
        left: 35,
        right: 70,
      },
    );
    this.invalidate(true);
    return true;
  }
  setBuildingOverview(building, options = {}) {
    if (!building) return false;
    return this.setRouteOverview(true, { ...options, building });
  }
  clear() {
    this.invalidate(true);
    if (!this.stackDisplay) {
      for (const prefix of ["userLocation", "surveyLocation"]) {
        if (this[`${prefix}Layer`]) this[`${prefix}Layer`].visible = false;
        if (this[`${prefix}Overlay`]) this[`${prefix}Overlay`].hidden = true;
      }
      if (this.locationPicking) this.setLocationPicking(false);
    }
    this.locationFloor = null;
    this.locationCutouts = null;
    this.setRouteGuidance(null);
    this.clipBounds = null;
    this.clipPlanes = null;
    this.loadRevision = (this.loadRevision || 0) + 1;
    this.selectedId = null;
    this.routeOverview = false;
    this.buildingOverview = false;
    this.routeLayers = [];
    this.routeStages = [];
    cleanup(this.model);
    cleanup(this.context);
    cleanup(this.selection);
    cleanup(this.hover);
    this.pickables = [];
    this.roomLabels = [];
    this.labelLayer.replaceChildren();
    this.hoverId = null;
    this.mouseEvent = null;
  }
  setOverview(building = null) {
    this.clear();
    this.mode = "overview";
    this.floor = null;
    if (this.ground) this.ground.position.y = -0.28;
    this.building = building;
    let exteriorReady = false;
    if (this.exteriorData?.[this.campus.id]) {
      const staging = new THREE.Group();
      try {
        const hall =
          this.campus.id === this.entranceHall?.campusId
            ? this.entranceHall
            : null;
        const exterior = createExterior(this.exteriorData[this.campus.id], {
          photoDetail: this.campus.id === "v-78" && this.facadesOn !== false,
          style: this.exteriorStyle,
          hall,
          special:
            this.campus.id === this.specialExterior?.campusId
              ? this.specialExterior
              : null,
        });
        staging.add(exterior.group);
        const pickables = [...exterior.pickables];
        if (hall) {
          const entrance = createEntranceHall(hall);
          staging.add(entrance.group);
          pickables.push(...entrance.pickables);
        }
        this.model.add(...staging.children);
        this.pickables.push(...pickables);
        exteriorReady = true;
      } catch {
        cleanup(staging);
        // A damaged optional facade/hall must not prevent the indoor map from
        // opening. Disable this package until setExterior supplies fresh data.
        this.exteriorData = { ...this.exteriorData, [this.campus.id]: null };
      }
    }
    if (!exteriorReady) {
      this.floors.forEach((f, i) => {
        const gs = (f.exteriorFootprints || f.footprints || [])
          .map((p) =>
            solidGeometry(p, this.floorHeight - 0.12, i * this.floorHeight),
          )
          .filter(Boolean);
        if (!gs.length) return;
        const g = mergeGeometries(gs);
        gs.forEach((g) => g.dispose());
        const material = new THREE.MeshStandardMaterial({
          color: i === this.floors.length - 1 ? 0xdce2d5 : 0xc7d1c6,
          roughness: 0.85,
        });
        const mesh = new THREE.Mesh(g, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.floor = f;
        this.model.add(mesh);
        this.pickables.push(mesh);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(g, 32),
          new THREE.LineBasicMaterial({
            color: 0x8b9993,
            transparent: true,
            opacity: 0.48,
          }),
        );
        this.model.add(edges);
      });
    }
    this.addOutdoor(this.floors.flatMap((f) => f.outdoorPolygons || []));
    if (
      this.campus.id === this.exteriorContext?.campusId &&
      this.contextOn !== false
    ) {
      try {
        const c = createMapContext(this.exteriorContext);
        this.context.add(c.group);
        this.pickables.push(...c.pickables);
        const streets = new Set();
        for (const road of this.exteriorContext.roads || []) {
          if (
            !road.name ||
            streets.has(road.name) ||
            ![
              "Коштоянца улица",
              "улица Коштоянца",
              "проспект Вернадского",
            ].includes(road.name)
          )
            continue;
          streets.add(road.name);
          const p = road.points?.[Math.floor(road.points.length / 2)];
          if (
            !Array.isArray(p) ||
            p.length < 2 ||
            !p.slice(0, 2).every(Number.isFinite)
          )
            continue;
          this.addLabel(road.name, p, 0.4, "street", () => {}, road.name);
        }
      } catch {
        cleanup(this.context);
        this.pickables = this.pickables.filter(
          (mesh) => !mesh.userData.external,
        );
        this.exteriorContext = null;
      }
    }
    this.addUncertainty(this.floors[0]?.uncertaintyRegions || []);
    for (const [b, p] of Object.entries(this.buildingCenters))
      this.addLabel(
        `Корпус ${b}`,
        p,
        this.floorHeight * this.floors.length + 1,
        "building",
        () => this.callbacks.onBuilding?.(b),
        b,
      );
    this.fit(building ? this.boundsForBuilding(building) : null, true);
    this.applyTheme();
    this.refreshRoute();
    this.refreshUserLocation();
  }
  setFloor(floor, building = null, { fit = true } = {}) {
    const keepPicking = Boolean(this.locationPicking);
    this.clear();
    this.mode = "floor";
    this.floor = floor;
    this.building = building;
    const hallFloor = getHallAdjacencyView(floor);
    const renderFloor =
      building && !this.neighborsOn && !this.route
        ? getBuildingFloorView(hallFloor, building)
        : hallFloor;
    this.locationFloor = renderFloor;
    const stairCutouts = getStairDisplayCutouts(renderFloor);
    this.locationCutouts = stairCutouts;
    if (this.ground)
      this.ground.position.y = stairCutouts.length
        ? -this.floorHeight - 0.5
        : -0.28;
    const slabs = [];
    for (const p of renderFloor.footprints || []) {
      const g = solidGeometry(
        withStairDisplayCutouts(p, stairCutouts),
        0.3,
        -0.3,
      );
      if (g) slabs.push(g);
    }
    if (slabs.length) {
      const g = mergeGeometries(slabs);
      slabs.forEach((x) => x.dispose());
      const mesh = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({
          color: this.stackDisplay && !this.stackActive ? 0xcbd7e6 : 0xf7f7f1,
          roughness: 1,
        }),
      );
      mesh.receiveShadow = true;
      this.model.add(mesh);
    }
    const fillGeoms = [],
      faceRooms = [];
    for (const p of renderFloor.polygons || []) {
      let g = flatGeometry(withStairDisplayCutouts(p, stairCutouts));
      if (!g) continue;
      g = g.toNonIndexed();
      const dim = building && p.building && p.building !== building;
      const color = new THREE.Color(
        dim ? 0xe9ece7 : COLORS[p.kind] || COLORS.room,
      );
      const colors = [];
      for (let i = 0; i < g.attributes.position.count; i++)
        colors.push(color.r, color.g, color.b);
      g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      for (let i = 0; i < g.attributes.position.count / 3; i++)
        faceRooms.push(p);
      fillGeoms.push(g);
      const displayPlace = presentPlaceIdentity(
        presentStairIdentity(p, floor),
        floor,
      );
      if (
        displayPlace.label &&
        p.center &&
        (!building ||
          p.building === building ||
          (!p.building && displayPlace.placeEvidence)) &&
        p.kind !== "corridor"
      )
        this.addLabel(
          displayPlace.label,
          p.center,
          0.5,
          displayPlace.kind === "stairs" ? "stairs" : "room",
          () => this.callbacks.onRoom?.(displayPlace),
          p.id,
        );
    }
    if (fillGeoms.length) {
      const g = mergeGeometries(fillGeoms);
      fillGeoms.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 1,
          side: THREE.DoubleSide,
        }),
      );
      mesh.userData.faceRooms = faceRooms;
      mesh.receiveShadow = true;
      this.model.add(mesh);
      this.pickables.push(mesh);
    }
    const display = getIndoorDisplayGeometry(renderFloor);
    this.openCorridorPartitions = display.appliedOverrides.length;
    const stairPartitions = getStairPartitionView({
      ...renderFloor,
      walls: display.walls,
    });
    this.locationFloor = { ...renderFloor, walls: stairPartitions.walls };
    this.stairPartitions = stairPartitions.partitions;
    this.addWalls(stairPartitions.walls);
    this.model.add(createIndoorHallDetails(renderFloor, display));
    // Source doors plus explicit user-confirmed open corridor corrections.
    const doorGeoms = [];
    for (const d of display.doors) {
      if (!d.a || !d.b) continue;
      const dx = d.b[0] - d.a[0],
        dz = d.b[1] - d.a[1],
        len = Math.hypot(dx, dz);
      if (len < 0.05 || len > 8) continue;
      const g = new THREE.BoxGeometry(len, 0.045, 0.25);
      g.rotateY(-Math.atan2(dz, dx));
      g.translate((d.a[0] + d.b[0]) / 2, 0.16, (d.a[1] + d.b[1]) / 2);
      doorGeoms.push(g);
    }
    if (doorGeoms.length) {
      const g = mergeGeometries(doorGeoms);
      doorGeoms.forEach((g) => g.dispose());
      this.model.add(
        new THREE.Mesh(
          g,
          new THREE.MeshStandardMaterial({ color: 0x5e9290, roughness: 1 }),
        ),
      );
    }
    this.addConnections(renderFloor);
    this.addUncertainty(renderFloor.uncertaintyRegions || []);
    if (building && !this.neighborsOn && !this.route) {
      const b = this.boundsForBuilding(building, floor);
      if (b) {
        const margin = 2.5;
        // A rotated building needs a rotated cutaway; an axis-aligned box leaves
        // fragments of adjacent wings in its corners.
        const hull = convexHull(this.pointsForBuilding(building, floor));
        const planes = hull.map((a, i) => {
          const next = hull[(i + 1) % hull.length];
          const normal = new THREE.Vector3(
            -(next[1] - a[1]),
            0,
            next[0] - a[0],
          ).normalize();
          return new THREE.Plane(
            normal,
            -normal.x * a[0] - normal.z * a[1] + margin,
          );
        });
        this.clipPlanes = planes;
        this.clipBounds = [
          b[0] - margin,
          b[1] - margin,
          b[2] + margin,
          b[3] + margin,
        ];
        this.model.traverse((o) => {
          if (o.material)
            for (const m of [].concat(o.material)) {
              m.clippingPlanes = planes;
              m.clipShadows = true;
            }
        });
      }
    }
    if (fit)
      this.fit(building ? this.boundsForBuilding(building, floor) : null, true);
    this.applyTheme();
    this.refreshRoute();
    this.refreshUserLocation();
    if (keepPicking && !this.stackDisplay) this.setLocationPicking(true);
  }
  addWalls(walls) {
    const wallHeight = this.route
      ? Math.min(0.9, this.wallHeight)
      : this.wallHeight;
    const valid = walls.filter(
      (w) => w.a && w.b && Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > 0.03,
    );
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: this.stackDisplay ? 0xb8c5d7 : 0xd6dcd0,
        roughness: 0.95,
      }),
      valid.length,
    );
    const dummy = new THREE.Object3D();
    for (let i = 0; i < valid.length; i++) {
      const w = valid[i],
        dx = w.b[0] - w.a[0],
        dz = w.b[1] - w.a[1];
      dummy.position.set(
        (w.a[0] + w.b[0]) / 2,
        wallHeight / 2 + 0.13,
        (w.a[1] + w.b[1]) / 2,
      );
      dummy.scale.set(
        Math.hypot(dx, dz),
        wallHeight,
        w.width || this.assumptions?.wallThickness || 0.2,
      );
      dummy.rotation.y = -Math.atan2(dz, dx);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.model.add(mesh);
    // Thin dark caps make the floor plan readable even at a distant zoom.
    const vertices = [];
    for (const w of valid)
      vertices.push(
        w.a[0],
        wallHeight + 0.15,
        w.a[1],
        w.b[0],
        wallHeight + 0.15,
        w.b[1],
      );
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    this.model.add(
      new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({
          color: 0x63776f,
          transparent: true,
          opacity: 0.75,
        }),
      ),
    );
  }
  addConnections(floor) {
    const batches = new Map(),
      placed = [];
    const bounds =
      this.building && !this.neighborsOn
        ? this.boundsForBuilding(this.building, floor)
        : null;
    for (const rawMarker of getMapStairMarkers(floor)) {
      const marker = presentPlaceIdentity(rawMarker, floor);
      const p = marker.center;
      const stairLayout = stairLayoutFor(marker, floor);
      // Registered upper arrivals repeat the physical module rendered below.
      // A display-only basement descent has no lower source module to repeat.
      if (
        this.stackDisplay &&
        marker.shapeReviewStatus !== "requires-correction" &&
        stairLayout?.levelRole === "upper-arrival" &&
        (stairLayout.pairedLayoutId ||
          (stairLayout.sourceMarkerIds?.length &&
            marker.shapeReviewStatus !== "user-confirmed-schematic"))
      )
        continue;
      if (
        bounds &&
        (p[0] < bounds[0] - 6 ||
          p[0] > bounds[2] + 6 ||
          p[1] < bounds[1] - 6 ||
          p[1] > bounds[3] + 6)
      )
        continue;
      const stair = createStaircase(marker, floor, this.assumptions, {
        stack: this.stackDisplay,
      });
      const center = stair.userData.geometryCenter || p;
      const layoutId = stairLayout?.id || null;
      // A photographed ascent and a basement descent can share an x/z anchor.
      // Their explicit layouts identify distinct physical modules. Only repeated
      // views of one layout (or unresolved nearby point symbols) are duplicates.
      if (
        placed.some((previous) =>
          layoutId && previous.layoutId
            ? layoutId === previous.layoutId
            : Math.hypot(
                previous.center[0] - center[0],
                previous.center[1] - center[1],
              ) < 1,
        )
      ) {
        cleanup(stair);
        continue;
      }
      placed.push({ center, layoutId });
      const stairLabel = this.addLabel(
        marker.shapeReviewStatus === "requires-correction"
          ? "Спуск · схема уточняется"
          : marker.layoutId
            ? stairLayout?.layoutMode === "opposed-branches"
              ? "Главная лестница"
              : stairLayout?.building
                ? marker.label.split(" · ")[0]
                : marker.label
            : marker.placeEvidence
              ? marker.label
              : "↕",
        p,
        marker.shapeReviewStatus === "requires-correction"
          ? 0.55
          : marker.shapeReviewStatus === "user-confirmed-schematic"
            ? 1.25
            : stairLayout?.incomingDisplay
              ? 1.25
              : marker.layoutId
                ? stairLayout?.levelRole === "upper-arrival"
                  ? 1.25
                  : 4.2
                : 0.55,
        "stairs",
        () => this.callbacks.onRoom?.(marker),
        marker.id,
      );
      stairLabel.title = marker.label;
      stair.updateMatrixWorld(true);
      stair.traverse((o) => {
        if (!o.isMesh) return;
        const key = o.material.color.getHex();
        if (!batches.has(key))
          batches.set(key, {
            geometries: [],
            rooms: [],
            material: o.material.clone(),
          });
        const batch = batches.get(key);
        let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        if (g.index) {
          const unindexed = g.toNonIndexed();
          g.dispose();
          g = unindexed;
        }
        batch.geometries.push(g);
        for (let i = 0; i < g.attributes.position.count / 3; i++)
          batch.rooms.push(marker);
      });
      cleanup(stair);
    }
    for (const { geometries, rooms, material } of batches.values()) {
      const geo = mergeGeometries(geometries);
      geometries.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = "Approximate stair flights";
      mesh.userData.faceRooms = rooms;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.model.add(mesh);
      this.pickables.push(mesh);
    }
  }
  addOutdoor(polygons) {
    const geoms = polygons.map((p) => flatGeometry(p, -0.12)).filter(Boolean);
    if (!geoms.length) return;
    const geo = mergeGeometries(geoms);
    geoms.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0xd0d8cc,
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    );
    mesh.receiveShadow = true;
    this.context.add(mesh);
  }
  addUncertainty(regions) {
    for (const p of regions) {
      const geo = flatGeometry(p, -0.08);
      if (geo)
        this.context.add(
          new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: 0xbda374,
              transparent: true,
              opacity: 0.1,
              side: THREE.DoubleSide,
              depthWrite: false,
            }),
          ),
        );
      const points = [...p.points, p.points[0]].map(
        (p) => new THREE.Vector3(p[0], 0.07, p[1]),
      );
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({
          color: 0xb59155,
          dashSize: 2,
          gapSize: 1,
          transparent: true,
          opacity: 0.8,
        }),
      );
      line.computeLineDistances();
      this.context.add(line);
      const c = [
        p.points.reduce((s, q) => s + q[0], 0) / p.points.length,
        p.points.reduce((s, q) => s + q[1], 0) / p.points.length,
      ];
      this.addLabel(
        "Положение не подтверждено",
        c,
        25,
        "uncertain",
        () => this.callbacks.onUncertainty?.(),
        p.kind,
      );
    }
  }
  pointsForBuilding(building, floor) {
    const scopeIds = getBuildingScopePolygonIds(floor, building);
    // Photographed stairs identify unlabelled hall regions belonging to a wing.
    // Include their source containers in the cutaway without rewriting source data.
    const sourceIds = new Set(
      getMapStairMarkers(floor)
        .filter((marker) => marker.building === building && marker.layoutId)
        .flatMap((marker) => {
          const layout = stairLayoutFor(marker, floor);
          return [...(layout?.sourcePolygonIds || []), layout?.containerAreaId];
        }),
    );
    return (floor.polygons || [])
      .filter((p) => scopeIds.has(p.id) || sourceIds.has(p.id))
      .flatMap((p) => p.points || []);
  }
  boundsForBuilding(building, floor = null) {
    const pts = (floor ? [floor] : this.floors).flatMap((f) =>
      this.pointsForBuilding(building, f),
    );
    if (!pts.length) return null;
    return [
      Math.min(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
    ];
  }
  allBounds() {
    const box = new THREE.Box3().setFromObject(this.model);
    return [box.min.x, box.min.z, box.max.x, box.max.z];
  }
  fit(bounds = null, animate = true, padding = null, options = null) {
    // Floor/building changes and «Показать целиком» need the same clear map
    // area as a room focus. Otherwise a long wing fits behind the sidebar.
    padding ??= this.callbacks?.getViewportPadding?.() || {};
    bounds ??= this.allBounds();
    if (!bounds.every(Number.isFinite)) return;
    const [x, z, X, Z] = bounds,
      width = Math.max(12, X - x),
      depth = Math.max(12, Z - z),
      modelBox = new THREE.Box3().setFromObject(this.model);
    const modelMin = Number.isFinite(options?.verticalBounds?.[0])
      ? options.verticalBounds[0]
      : Number.isFinite(modelBox.min.y)
        ? modelBox.min.y
        : 0;
    const modelMax = Number.isFinite(options?.verticalBounds?.[1])
      ? options.verticalBounds[1]
      : Number.isFinite(modelBox.max.y)
        ? modelBox.max.y
        : 3;
    const target = new THREE.Vector3(
      (x + X) / 2,
      Number.isFinite(options?.targetY)
        ? options.targetY
        : this.mode === "overview" || this.mode.endsWith("-overview")
          ? (modelMin + modelMax) / 2
          : 0,
      (z + Z) / 2,
    );
    const aspect = this.perspectiveCamera.aspect;
    const viewportWidth = this.host?.clientWidth || 1000;
    const viewportHeight = this.host?.clientHeight || 800;
    const pad = {
      left: Math.max(0, padding?.left || 0),
      right: Math.max(0, padding?.right || 0),
      top: Math.max(0, padding?.top || 0),
      bottom: Math.max(0, padding?.bottom || 0),
    };
    // Never reduce the useful viewport below a quarter, including when a
    // mobile keyboard temporarily takes most of the screen.
    const usableX = Math.max(0.25, 1 - (pad.left + pad.right) / viewportWidth);
    const usableY = Math.max(0.25, 1 - (pad.top + pad.bottom) / viewportHeight);
    const offsetX = (pad.left - pad.right) / viewportWidth;
    const offsetY = (pad.bottom - pad.top) / viewportHeight;
    const placeCamera = (position) => {
      const direction = position.clone().sub(target).normalize();
      const right = new THREE.Vector3()
        .crossVectors(this.camera.up, direction)
        .normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const halfY = this.plan
        ? (this.planCamera.top - this.planCamera.bottom) / 2
        : position.distanceTo(target) *
          Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const shift = right
        .multiplyScalar(-offsetX * halfY * aspect)
        .addScaledVector(up, -offsetY * halfY);
      this.moveCamera(position.add(shift), target.clone().add(shift), animate);
    };
    let dist;
    if (this.plan) {
      const height =
        Math.max(width / (aspect * usableX), depth / usableY) * 1.2;
      this.planCamera.top = height / 2;
      this.planCamera.bottom = -height / 2;
      this.planCamera.left = (-height * aspect) / 2;
      this.planCamera.right = (height * aspect) / 2;
      this.planCamera.zoom = 1;
      this.planCamera.updateProjectionMatrix();
      dist = 1500;
      placeCamera(target.clone().add(new THREE.Vector3(0, dist, 0)));
    } else {
      const tanY =
          (Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * usableY) /
          0.92,
        tanX = (tanY * aspect * usableX) / usableY;
      const corners = [];
      for (const cx of [x, X])
        for (const cy of [modelMin, modelMax])
          for (const cz of [z, Z])
            corners.push(new THREE.Vector3(cx, cy, cz).sub(target));
      const preferred =
        Array.isArray(options?.direction) &&
        options.direction.length === 3 &&
        options.direction.every(Number.isFinite) &&
        options.direction[1] > 0
          ? new THREE.Vector3(...options.direction)
          : null;
      const directions = preferred
        ? [preferred]
        : !this.mode.endsWith("-overview") && aspect < 1 && width > depth * 1.4
          ? [new THREE.Vector3(1, 0.95, 0.25), new THREE.Vector3(0.6, 1, 1)]
          : [new THREE.Vector3(0.35, 0.95, 1)];
      let best = null;
      for (const direction of directions) {
        direction.normalize();
        const right = new THREE.Vector3()
            .crossVectors(new THREE.Vector3(0, 1, 0), direction)
            .normalize(),
          up = new THREE.Vector3().crossVectors(direction, right);
        let d = 0;
        for (const c of corners)
          d = Math.max(
            d,
            Math.abs(c.dot(right)) / tanX + c.dot(direction),
            Math.abs(c.dot(up)) / tanY + c.dot(direction),
          );
        if (!best || d < best.distance) best = { direction, distance: d };
      }
      dist = best.distance * 1.18;
      this.camera.near = this.mode === "overview" ? 0.8 : 0.2;
      this.camera.far = Math.max(2500, dist * 5);
      this.camera.updateProjectionMatrix();
      placeCamera(target.clone().addScaledVector(best.direction, dist));
    }
    const span = Math.max(width, depth);
    this.sun.target.position.copy(target);
    this.sun.position
      .copy(target)
      .add(new THREE.Vector3(-span * 0.4, span * 0.9, span * 0.45));
    const size = span * 0.8;
    Object.assign(this.sun.shadow.camera, {
      left: -size,
      right: size,
      top: size,
      bottom: -size,
      near: 0.5,
      far: Math.max(500, span * 3),
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(dist * 4, 250);
    this.lastBounds = bounds;
    this.lastFitPadding = pad;
    this.lastFitOptions = options;
    this.invalidate(true);
  }
  moveCamera(position, target, animate = true) {
    this.invalidate();
    if (!animate || this.reducedMotion) {
      this.transition = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.transition = {
      start: performance.now(),
      from: this.camera.position.clone(),
      to: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
    };
  }
  zoom(factor) {
    if (this.plan) {
      this.camera.zoom = THREE.MathUtils.clamp(
        this.camera.zoom / factor,
        0.08,
        80,
      );
      this.camera.updateProjectionMatrix();
      this.invalidate();
      return;
    }
    const delta = this.camera.position
      .clone()
      .sub(this.controls.target)
      .multiplyScalar(factor);
    this.moveCamera(
      this.controls.target.clone().add(delta),
      this.controls.target.clone(),
    );
  }
  togglePlan() {
    this.setProjection(!this.plan, { fit: true });
    return this.plan;
  }
  selectRoom(room, { focus = true, padding } = {}) {
    this.invalidate();
    cleanup(this.selection);
    this.selectedId = room?.id;
    if (!room) return;
    const polygon =
      getHallAdjacencyView(this.floor)?.polygons?.find(
        (p) => p.id === room.id,
      ) || room;
    if (polygon.points) {
      const g = flatGeometry(
        this.floor
          ? withStairDisplayCutouts(polygon, getStairDisplayCutouts(this.floor))
          : polygon,
        0.19,
      );
      if (g)
        this.selection.add(
          new THREE.Mesh(
            g,
            new THREE.MeshStandardMaterial({
              color: 0x6a9aec,
              roughness: 1,
              transparent: true,
              opacity: 0.6,
              side: THREE.DoubleSide,
            }),
          ),
        );
      const points = [...polygon.points, polygon.points[0]].map(
        (p) => new THREE.Vector3(p[0], 0.23, p[1]),
      );
      this.selection.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: 0x246bfd }),
        ),
      );
    }
    if (room.center) {
      const selectedStairLayout =
        room.kind === "stairs" && this.floor
          ? stairLayoutFor(room, this.floor)
          : null;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.75, 1, 40),
        new THREE.MeshBasicMaterial({
          color: 0x246bfd,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(
        room.center[0],
        selectedStairLayout?.levelRole === "lower-departure"
          ? (this.floorHeight || 3.6) + 0.26
          : 0.26,
        room.center[1],
      );
      this.selection.add(ring);
      if (focus) {
        const layout = selectedStairLayout;
        const stairPoints = layout?.footprint.map(([u, v]) => [
          layout.frame.origin[0] +
            layout.frame.axisU[0] * u * layout.frame.size[0] +
            layout.frame.axisV[0] * v * layout.frame.size[1],
          layout.frame.origin[1] +
            layout.frame.axisU[1] * u * layout.frame.size[0] +
            layout.frame.axisV[1] * v * layout.frame.size[1],
        ]);
        const bounds = stairPoints?.length
          ? [
              Math.min(...stairPoints.map((p) => p[0])) - 2.5,
              Math.min(...stairPoints.map((p) => p[1])) - 2.5,
              Math.max(...stairPoints.map((p) => p[0])) + 2.5,
              Math.max(...stairPoints.map((p) => p[1])) + 2.5,
            ]
          : polygon.points
            ? [
                Math.min(...polygon.points.map((p) => p[0])) - 12,
                Math.min(...polygon.points.map((p) => p[1])) - 12,
                Math.max(...polygon.points.map((p) => p[0])) + 12,
                Math.max(...polygon.points.map((p) => p[1])) + 12,
              ]
            : [
                room.center[0] - 20,
                room.center[1] - 20,
                room.center[0] + 20,
                room.center[1] + 20,
              ];
        const localDirection = layout?.focusDirectionLocal;
        const direction = localDirection
          ? [
              layout.frame.axisU[0] * localDirection[0] +
                layout.frame.axisV[0] * localDirection[2],
              localDirection[1],
              layout.frame.axisU[1] * localDirection[0] +
                layout.frame.axisV[1] * localDirection[2],
            ]
          : null;
        this.fit(bounds, true, padding, direction ? { direction } : null);
      }
    }
  }
  showHover(room) {
    if (this.hoverId === room?.id) return;
    this.hoverId = room?.id;
    this.invalidate();
    cleanup(this.hover);
    if (room?.points) {
      const g = flatGeometry(
        this.floor
          ? withStairDisplayCutouts(room, getStairDisplayCutouts(this.floor))
          : room,
        0.17,
      );
      if (g)
        this.hover.add(
          new THREE.Mesh(
            g,
            new THREE.MeshBasicMaterial({
              color: 0x9bbfb2,
              transparent: true,
              opacity: 0.55,
              side: THREE.DoubleSide,
            }),
          ),
        );
    }
    this.host.style.cursor = room ? "pointer" : "grab";
    this.callbacks.onHover?.(room);
  }
  hit(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster
      .intersectObjects(this.pickables, false)
      .find(
        (candidate) =>
          !(
            this.clipPlanes ||
            [].concat(candidate.object.material || [])[0]?.clippingPlanes
          )?.some((plane) => plane.distanceToPoint(candidate.point) < 0),
      );
    if (!hit) return null;
    if (
      (this.routeOverview || this.buildingOverview) &&
      hit.object.userData.routeFloorId
    )
      return { routeFloor: hit.object.userData.routeFloorId };
    if (hit.object.userData.external)
      return { external: hit.object.userData.external };
    if (hit.object.userData.room) return { room: hit.object.userData.room };
    if (hit.object.userData.faceRooms)
      return { room: hit.object.userData.faceRooms[hit.faceIndex] };
    if (this.mode === "overview") {
      return {
        building: buildingAtPoint(this.floors, [hit.point.x, hit.point.z]),
      };
    }
    return null;
  }
  addLabel(text, p, y, kind, onclick, id) {
    const el = document.createElement("button");
    el.className = `map-label ${kind}`;
    el.textContent = text;
    el.tabIndex = -1;
    el.onclick = onclick;
    el.dataset.id = id;
    this.labelLayer.append(el);
    this.roomLabels.push({
      el,
      position: new THREE.Vector3(p[0], y, p[1]),
      kind,
      id,
    });
    return el;
  }
  updateLabels() {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    const currentPosition = this.updateUserLocationOverlay();
    const surveyPosition = this.updateSurveyLocationOverlay();
    const occupied = [currentPosition, surveyPosition].filter(Boolean);
    const hostRect = this.host.getBoundingClientRect();
    const obstacles = [
      ...document.querySelectorAll(
        ".room-card:not([hidden]),.map-top,.map-title,.map-tools,.route-panel:not([hidden]),.mobile-sheet:not([hidden])",
      ),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x - hostRect.x,
        y: r.y - hostRect.y,
        w: r.width,
        h: r.height,
      };
    });
    const ordered = [...this.roomLabels].sort(
      (a, b) =>
        Number(Boolean(b.activeFloor)) - Number(Boolean(a.activeFloor)) ||
        String(b.id).startsWith("level-") - String(a.id).startsWith("level-") ||
        (b.kind === "route") - (a.kind === "route") ||
        (b.id === this.selectedId) - (a.id === this.selectedId) ||
        (a.kind === "building" || a.kind === "stairs" ? 0 : 1) -
          (b.kind === "building" || b.kind === "stairs" ? 0 : 1),
    );
    let count = 0;
    for (const label of ordered) {
      const p = label.position.clone().project(this.camera);
      let x = (p.x * 0.5 + 0.5) * width,
        y = (-p.y * 0.5 + 0.5) * height;
      const w =
          label.kind === "building"
            ? 100
            : Math.max(
                45,
                label.el.textContent.length * 6.5 +
                  (label.kind === "route" ? 28 : 0),
              ),
        h = label.kind === "building" || label.kind === "route" ? 34 : 21;
      if (String(label.id).startsWith("level-") && p.z > -1 && p.z < 1) {
        const baseY = y;
        x = THREE.MathUtils.clamp(x, w / 2 + 10, width - w / 2 - 10);
        const candidate = [0, -40, 40, -80, 80, -120, 120]
          .map((offset) => baseY + offset)
          .find(
            (cy) =>
              cy > 30 &&
              cy < height - 100 &&
              !obstacles.some(
                (r) =>
                  x + w / 2 > r.x &&
                  x - w / 2 < r.x + r.w &&
                  cy + h / 2 > r.y &&
                  cy - h / 2 < r.y + r.h,
              ) &&
              !occupied.some(
                (r) =>
                  Math.abs(x - r.x) < (w + r.w) / 2 + 6 &&
                  Math.abs(cy - r.y) < (h + r.h) / 2 + 4,
              ),
          );
        if (candidate != null) y = candidate;
      }
      let visible =
        (this.labelsOn || label.kind === "route") &&
        p.z < 1 &&
        p.z > -1 &&
        x > w / 2 &&
        x < width - w / 2 &&
        y > 25 &&
        y < height - 100 &&
        count < (this.mode === "overview" ? 30 : 70);
      const distance = this.camera.position.distanceTo(label.position);
      if (
        label.kind !== "building" &&
        label.kind !== "route" &&
        distance > 200 &&
        !this.building
      )
        visible = false;
      if (
        this.clipPlanes?.some(
          (plane) => plane.distanceToPoint(label.position) < 0,
        )
      )
        visible = false;
      if (
        visible &&
        obstacles.some(
          (r) =>
            x + w / 2 > r.x &&
            x - w / 2 < r.x + r.w &&
            y + h / 2 > r.y &&
            y - h / 2 < r.y + r.h,
        )
      )
        visible = false;
      if (
        visible &&
        occupied.some(
          (r) =>
            Math.abs(x - r.x) < (w + r.w) / 2 + 6 &&
            Math.abs(y - r.y) < (h + r.h) / 2 + 4,
        )
      )
        visible = false;
      label.el.style.display = visible ? "block" : "none";
      if (visible) {
        occupied.push({ x, y, w, h });
        count++;
        label.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
        label.el.classList.toggle("selected", label.id === this.selectedId);
      }
    }
  }
  animate() {
    if (this.transition) {
      const t = Math.min(1, (performance.now() - this.transition.start) / 650),
        k = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(
        this.transition.from,
        this.transition.to,
        k,
      );
      this.controls.target.lerpVectors(
        this.transition.fromTarget,
        this.transition.toTarget,
        k,
      );
      this.dirty = true;
      if (t === 1) this.transition = null;
    }
    this.controls.update();
    if (
      !this.locationPicking &&
      this.mouseEvent &&
      performance.now() - (this.lastHover || 0) > 75
    ) {
      this.showHover(this.hit(this.mouseEvent)?.room);
      this.lastHover = performance.now();
      this.mouseEvent = null;
    }
    if (this.dirty) {
      this.updateRoute();
      this.updateLabels();
      this.updateUserLocationScale();
      this.renderer.render(this.scene, this.camera);
      this.renderedFrames = (this.renderedFrames || 0) + 1;
      this.callbacks.onFrame?.(
        this.renderer.info,
        this.camera,
        this.controls.target,
      );
      this.dirty = false;
    }
    if (this.lastPublishedFrame !== this.renderedFrames) {
      this.host.dataset.stats = JSON.stringify(this.stats());
      this.host.dataset.camera = JSON.stringify({
        projection: this.plan ? "orthographic" : "perspective",
        position: this.camera.position.toArray(),
        target: this.controls.target.toArray(),
        zoom: this.camera.zoom,
        bounds: this.lastBounds,
      });
      this.lastPublishedFrame = this.renderedFrames;
    }
  }
  stats() {
    return {
      mode: this.mode,
      campus: this.campus?.id,
      floor: this.floor?.id || null,
      projection: this.plan ? "2d" : "3d",
      renderedFrames: this.renderedFrames,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      labels: this.roomLabels.length,
      openCorridorPartitions:
        this.mode === "floor" ? this.openCorridorPartitions || 0 : 0,
      roundedRouteCorners: (this.stackDisplay
        ? this.routeLayers || []
        : [this.routeLayer]
      ).reduce(
        (total, layer) =>
          total + (layer?.group.userData.roundedRouteCorners || 0),
        0,
      ),
    };
  }
}
