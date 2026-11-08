/** Observe busy frames only. Idle gaps and a deliberate 30 fps cap are not lag. */
export function createAdaptiveQuality() {
  let level = 0,
    previous = null,
    windowStart = null,
    samples = [],
    changedAt = -Infinity,
    recoveryStart = null;
  const suspend = () => {
    previous = windowStart = recoveryStart = null;
    samples = [];
  };
  return {
    get level() {
      return level;
    },
    suspend,
    reset() {
      level = 0;
      changedAt = -Infinity;
      suspend();
    },
    observe({ time, cost, active, frameRate = 60 }) {
      if (!active || !Number.isFinite(time) || !Number.isFinite(cost)) {
        suspend();
        return null;
      }
      const interval = 1000 / Math.max(1, frameRate),
        elapsed = previous == null ? 0 : time - previous;
      previous = time;
      if (elapsed <= 0 || elapsed > Math.max(250, interval * 5)) {
        windowStart = recoveryStart = null;
        samples = [];
        return null;
      }
      windowStart ??= time;
      const slow = elapsed > interval * 1.4 || cost > interval * 0.85;
      samples.push(slow);
      // Recovery needs headroom for 60 fps even if adaptation chose 30 fps.
      const fast = elapsed <= interval * 1.2 && cost < 6;
      if (fast) recoveryStart ??= time;
      else recoveryStart = null;
      if (time - changedAt < 5000) return null;
      if (
        level < 2 &&
        samples.length >= 20 &&
        time - windowStart >= 1600 &&
        samples.filter(Boolean).length / samples.length >= 0.65
      ) {
        level++;
      } else if (
        level > 0 &&
        recoveryStart != null &&
        time - recoveryStart >= 8000
      ) {
        level--;
      } else {
        if (time - windowStart >= 2400) {
          samples = [];
          windowStart = time;
        }
        return null;
      }
      changedAt = time;
      suspend();
      return level;
    },
  };
}
