// Loaded plans and manifest entries are immutable. Keep their merged identity
// stable so returning to a floor reuses derived contours instead of recomputing.
const views = new WeakMap();

export function mergedFloorView(source, metadata) {
  if (!source || typeof source !== "object") return source;
  const cached = views.get(source);
  if (cached && cached.metadata === metadata) return cached.view;
  const view = { ...source, ...metadata };
  views.set(source, { metadata, view });
  return view;
}
