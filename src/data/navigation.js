/** Validate a shared view against available campus/floor metadata. */
export function resolveInitialView(parameters, manifest) {
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
  const wantsFloor =
    params.get("view") === "floor" ||
    (!params.get("view") && !!params.get("floor"));
  const floor =
    validBuilding &&
    wantsFloor &&
    requestedFloor &&
    hasBuilding(requestedFloor, building)
      ? requestedFloor
      : null;
  return {
    campusId: campus.id,
    building,
    floorId: floor?.id || null,
    mode: floor ? "floor" : "overview",
    projection: params.get("projection") === "2d" ? "2d" : "3d",
  };
}
