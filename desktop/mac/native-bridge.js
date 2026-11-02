(() => {
  let sequence = 0;
  const pending = new Map();
  const watches = new Map();
  const post = (message) =>
    window.webkit.messageHandlers.mirea.postMessage(message);
  const call = (action, values) =>
    new Promise((resolve, reject) => {
      const id = `call-${++sequence}`;
      pending.set(id, { resolve, reject });
      post({ action, id, ...values });
    });
  Object.defineProperty(window, "__mireaDesktopReply", {
    value(id, payload) {
      const watch = watches.get(id);
      if (watch) {
        clearTimeout(watch.timer);
        if (payload.error) watch.error?.(payload.error);
        else watch.success(payload);
        return;
      }
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (payload.error) {
        const error = new Error(payload.error.message);
        error.name = payload.error.name || "Error";
        request.reject(error);
      } else request.resolve(payload.value);
    },
  });
  const geolocation = Object.freeze({
    watchPosition(success, error, options = {}) {
      const id = `geo-${++sequence}`;
      const timer = setTimeout(() => {
        watches.get(id)?.error?.({
          code: 3,
          message:
            "macOS не определила положение вовремя. Укажите точку вручную.",
        });
      }, options.timeout || 15000);
      watches.set(id, { success, error, timer });
      post({ action: "geo-watch", id });
      return id;
    },
    clearWatch(id) {
      clearTimeout(watches.get(id)?.timer);
      watches.delete(id);
      post({ action: "geo-clear", id });
    },
    getCurrentPosition(success, error, options = {}) {
      let timer;
      const id = this.watchPosition(
        (value) => {
          clearTimeout(timer);
          this.clearWatch(id);
          success(value);
        },
        (failure) => {
          clearTimeout(timer);
          this.clearWatch(id);
          error?.(failure);
        },
      );
      timer = setTimeout(() => {
        this.clearWatch(id);
        error?.({
          code: 3,
          message: "macOS не ответила вовремя. Укажите точку вручную.",
        });
      }, options.timeout || 15000);
    },
  });
  Object.defineProperty(navigator, "geolocation", { value: geolocation });
  Object.defineProperty(window, "mireaDesktop", {
    value: Object.freeze({
      platform: "macos",
      shareLink: (url) => call("share", { url }),
      exportGpsJson: (json) => call("export-gps", { json }),
    }),
  });
  const remember = () => post({ action: "remember", hash: location.hash });
  for (const name of ["replaceState", "pushState"]) {
    const original = history[name].bind(history);
    history[name] = (...args) => {
      original(...args);
      remember();
    };
  }
  addEventListener("hashchange", remember);
  addEventListener("pagehide", () => {
    for (const id of watches.keys()) geolocation.clearWatch(id);
    for (const { reject } of pending.values())
      reject(new DOMException("Окно закрыто", "AbortError"));
    pending.clear();
  });
})();
