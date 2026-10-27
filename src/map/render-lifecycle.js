/** Keep one frame loop alive only while both the page and native app are visible. */
export function createRenderLifecycle({
  render,
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

  function schedule() {
    if (!running || frame !== null) return;
    const scheduledGeneration = generation;
    frame = windowTarget.requestAnimationFrame((time) => {
      // A callback already queued when cancelled may arrive after a resume.
      // It must neither render nor clear the new loop's pending frame.
      if (!running || scheduledGeneration !== generation) return;
      frame = null;
      render(time);
      schedule();
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
