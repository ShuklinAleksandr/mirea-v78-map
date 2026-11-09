export function getMainEntranceApproach(floor) {
  if (floor?.campusId !== "v-78" || floor.buildingLevels?.А !== 2) return null;
  return (
    floor.outdoorPolygons?.find((area) => area.id === "v-78-floor2-area-2") ||
    null
  );
}

export function mainEntranceFraming(floor) {
  if (floor?.campusId !== "v-78" || floor.buildingLevels?.А !== 2) return null;
  const entrance = floor.polygons?.find(
    (area) => area.id === "v-78--floor-2--9yb",
  );
  const hall = floor.polygons?.find((area) => area.id === "v-78-floor2-area-6");
  if (!entrance?.points?.length || !hall?.points?.length) return null;
  const approach = getMainEntranceApproach(floor);
  const points = [...hall.points, ...entrance.points];
  // Frame the whole hall and the near half of the outside approach.
  if (approach?.center) points.push(approach.center);
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  const bounds = [
    Math.min(...xs) - 4,
    Math.min(...zs) - 4,
    Math.max(...xs) + 4,
    Math.max(...zs) + 4,
  ];
  if (!bounds.every(Number.isFinite)) return null;
  return bounds;
}

/** Validate a shared view against available campus/floor metadata. */
export function resolveInitialView(
  parameters,
  manifest,
  { resumeMainEntrance = false } = {},
) {
  const params =
    parameters instanceof URLSearchParams
      ? parameters
      : new URLSearchParams(String(parameters || "").replace(/^#/, ""));
  const campuses = manifest.campuses || [];
  const campus =
    campuses.find((c) => c.id === params.get("campus")) ||
    campuses.find((c) => c.id === "v-78") ||
    campuses[0];
  if (!campus) return null;
  const hasTarget = ["room", "from", "to"].some((key) => params.has(key));
  const hasBuilding = (floor, building) =>
    !building ||
    floor.buildings?.includes(building) ||
    Object.hasOwn(floor.buildingLevels || {}, building);
  if (
    campus.id === "v-78" &&
    !params.has("view") &&
    !params.has("floor") &&
    !params.has("building")
  ) {
    const entranceFloor = campus.floors.find((f) => f.buildingLevels?.А === 2);
    if (entranceFloor)
      return {
        campusId: campus.id,
        building: "А",
        floorId: entranceFloor.id,
        mode: "floor",
        projection: params.get("projection") === "2d" ? "2d" : "3d",
        focusMainEntrance: !hasTarget,
      };
  }
  const requestedBuilding = params.get("building");
  const validBuilding =
    !requestedBuilding ||
    campus.floors.some((f) => hasBuilding(f, requestedBuilding));
  const building = validBuilding ? requestedBuilding || null : null;
  const requestedFloor = campus.floors.find(
    (f) => f.id === params.get("floor"),
  );
  const legacyStack = params.get("view") === "stack";
  const wantsFloor =
    legacyStack ||
    params.get("view") === "floor" ||
    (!params.get("view") && !!params.get("floor"));
  const compatibleFloors = campus.floors.filter((f) =>
    hasBuilding(f, building),
  );
  const floor =
    validBuilding &&
    wantsFloor &&
    requestedFloor &&
    hasBuilding(requestedFloor, building)
      ? requestedFloor
      : legacyStack
        ? compatibleFloors.find(
            (f) => (f.buildingLevels?.[building] ?? f.level) === 2,
          ) ||
          compatibleFloors.find((f) => f.level === 1) ||
          compatibleFloors[0]
        : null;
  return {
    campusId: campus.id,
    building,
    floorId: floor?.id || null,
    mode: floor ? "floor" : "overview",
    projection: params.get("projection") === "2d" ? "2d" : "3d",
    ...(resumeMainEntrance &&
    !hasTarget &&
    campus.id === "v-78" &&
    building === "А" &&
    floor?.buildingLevels?.А === 2
      ? { focusMainEntrance: true }
      : {}),
  };
}
