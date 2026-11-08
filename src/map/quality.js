export function mapQuality(
  setting,
  { pixelRatio = 1, touch = false, cores, memory, plan = false } = {},
) {
  const high = setting === "high";
  const constrained =
    setting === "low" ||
    (!high &&
      ((Number.isFinite(memory) && memory <= 4) ||
        (Number.isFinite(cores) && cores <= 4)));
  const limit = constrained ? 1 : high ? 2 : touch || plan ? 1.25 : 1.5;
  return {
    pixelRatio: Math.min(pixelRatio, limit),
    shadows: !plan && !constrained && (!touch || high),
    detail: !constrained,
  };
}
