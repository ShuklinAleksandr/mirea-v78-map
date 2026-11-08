export function mapQuality(
  setting,
  { pixelRatio = 1, touch = false, cores, memory, plan = false } = {},
) {
  const weak =
    (Number.isFinite(memory) && memory <= 4) ||
    (Number.isFinite(cores) && cores <= 4);
  const preset = ["low", "balanced", "high"].includes(setting)
    ? setting
    : weak
      ? "low"
      : "balanced";
  const low = preset === "low";
  const high = preset === "high";
  const shadowSize = plan || low ? 0 : high ? 2048 : touch ? 0 : 1024;
  return {
    pixelRatio: high
      ? Math.min(2, Math.max(1.5, pixelRatio))
      : Math.min(pixelRatio, low ? 0.8 : touch || plan ? 1.25 : 1.5),
    shadows: shadowSize > 0,
    shadowSize,
    detail: !low,
    autoFrameRate: low ? 30 : 60,
  };
}
