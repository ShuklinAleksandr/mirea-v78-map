export function mapQuality(
  setting,
  {
    pixelRatio = 1,
    touch = false,
    cores,
    memory,
    plan = false,
    adaptiveLevel = 0,
  } = {},
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
  const adaptive = setting === "auto" ? adaptiveLevel : 0;
  const shadowSize =
    plan || low || adaptive > 0 ? 0 : high ? 2048 : touch ? 0 : 1024;
  const density = high
    ? Math.min(2, Math.max(1.5, pixelRatio))
    : Math.min(pixelRatio, low ? 0.8 : touch || plan ? 1.25 : 1.5);
  return {
    pixelRatio: Math.min(
      density,
      adaptive >= 2 ? 0.75 : adaptive > 0 ? 1 : Infinity,
    ),
    shadows: shadowSize > 0,
    shadowSize,
    detail: !low && adaptive < 2,
    autoFrameRate: low || adaptive >= 2 ? 30 : 60,
  };
}
