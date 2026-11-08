/** Schedule requested frames only while both the page and native app are visible. */
export function createRenderLifecycle({
  render,
  frameRate = 60,
  onPause = () => {},
  onResume = () => {},
  windowTarget = window,
  documentTarget = document,
}) {
  let nativeActive =
    documentTarget.documentElement?.dataset.appActive !== "false";
  let pageActive = true;
  let running = false;
  let disposed = false;
  let frame = null;
  let generation = 0;
  let interval = 1000 / frameRate;
  let nextFrameAt = -Infinity;
  let rendering = false;

  function schedule() {
    if (!running || frame !== null || rendering) return;
    const scheduledGeneration = generation;
    frame = windowTarget.requestAnimationFrame((time) => {
      // A callback already queued when cancelled may arrive after a resume.
      // It must neither render nor clear the new loop's pending frame.
      if (!running || scheduledGeneration !== generation) return;
      frame = null;
      // RAF timestamps can be slightly early on a nominal 60/120 Hz panel.
      // Keep the cadence's phase between frames instead of dropping a whole
      // refresh when timing fluctuates or accumulating a catch-up burst.
      if (time + 0.75 < nextFrameAt) {
        schedule();
        return;
      }
      nextFrameAt =
        time - nextFrameAt >= interval
          ? time + interval
          : nextFrameAt + interval;
      rendering = true;
      let more;
      try {
        more = render(time);
      } finally {
        rendering = false;
      }
      if (more || scheduledGeneration !== generation) schedule();
    });
  }

  function pause() {
    if (!running) return;
    running = false;
    generation++;
    if (frame !== null) windowTarget.cancelAnimationFrame(frame);
    frame = null;
    onPause();
  }

  function sync() {
    if (disposed) return;
    if (!nativeActive || !pageActive || documentTarget.hidden) {
      pause();
      return;
    }
    if (running) return;
    running = true;
    generation++;
    nextFrameAt = -Infinity;
    onResume();
    schedule();
  }

  const onAppState = (event) => {
    if (typeof event.detail?.isActive !== "boolean") return;
    nativeActive = event.detail.isActive;
    sync();
  };
  const onPageHide = () => {
    pageActive = false;
    sync();
  };
  const onPageShow = () => {
    pageActive = true;
    sync();
  };
  documentTarget.addEventListener("visibilitychange", sync);
  windowTarget.addEventListener("atlas:app-state", onAppState);
  windowTarget.addEventListener("pagehide", onPageHide);
  windowTarget.addEventListener("pageshow", onPageShow);
  sync();

  return {
    requestFrame: schedule,
    setFrameRate(value) {
      interval = 1000 / value;
      nextFrameAt = -Infinity;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pause();
      documentTarget.removeEventListener("visibilitychange", sync);
      windowTarget.removeEventListener("atlas:app-state", onAppState);
      windowTarget.removeEventListener("pagehide", onPageHide);
      windowTarget.removeEventListener("pageshow", onPageShow);
    },
  };
}
