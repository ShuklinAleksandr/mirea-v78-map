import { createHash } from "node:crypto";
import { mkdir, lstat, realpath, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, preview } from "vite";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function controlPath(root, mode) {
  const key = createHash("sha256")
    .update(await realpath(root))
    .digest("hex")
    .slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\mirea-${key}-${mode}`;
  const dir = path.join(os.tmpdir(), `mirea-${process.getuid()}-${key}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${mode}.sock`);
}

/** Only an instance owning this project's private IPC socket can be stopped. */
async function requestStop(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let reply = "";
    socket.setTimeout(5000, () =>
      socket.destroy(
        new Error("Старый сервер не отвечает. Попробуйте npm run stop."),
      ),
    );
    socket.on("connect", () => socket.write("stop\n"));
    socket.on("data", (chunk) => {
      reply += chunk;
    });
    socket.on("end", () => resolve(reply.includes("stopped")));
    socket.on("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
}

async function claimControl(control, endpoint) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          control.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          control.off("error", failed);
          resolve();
        };
        control.once("error", failed);
        control.once("listening", ready);
        control.listen(endpoint);
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      const before =
        process.platform === "win32"
          ? null
          : await lstat(endpoint).catch(() => null);
      if (await requestStop(endpoint)) {
        console.log("Предыдущий сервер проекта остановлен; порт освобождён.");
      } else if (before?.isSocket()) {
        // A killed process can leave a socket file. Never remove a replacement
        // created by another concurrent launch while we were checking it.
        const after = await lstat(endpoint).catch(() => null);
        if (after?.ino === before.ino) await unlink(endpoint).catch(() => {});
      }
      await delay(50);
    }
  }
  throw new Error(
    "Не удалось завершить одновременный запуск. Выполните npm run stop и повторите запуск.",
  );
}

function parseArgs(args) {
  const mode = args[0] || "dev";
  if (!["dev", "preview", "stop"].includes(mode))
    throw new Error(`Неизвестный режим: ${mode}`);
  let port = mode === "preview" ? 4173 : 5173;
  let force = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--force") force = true;
    else if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i].startsWith("--port=")) port = Number(args[i].slice(7));
    else
      throw new Error(
        `Неизвестный параметр: ${args[i]}. Доступны --port и --force.`,
      );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Порт должен быть числом от 1 до 65535.");
  return { mode, port, force };
}

export async function run({ root, args = process.argv.slice(2) }) {
  const { mode, port, force } = parseArgs(args);
  if (mode === "stop") {
    for (const kind of ["dev", "preview"]) {
      const stopped = await requestStop(await controlPath(root, kind));
      console.log(
        `${kind}: ${stopped ? "сервер остановлен, порт освобождён" : "сервер не запущен"}.`,
      );
    }
    return;
  }

  const endpoint = await controlPath(root, mode);
  const clients = new Set();
  let vite;
  let starting = Promise.resolve();
  let stopping;
  let parentTimer;
  const control = net.createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    let command = "";
    socket.on("data", (chunk) => {
      command += chunk;
      if (command === "stop\n") shutdown();
      else if (command.length > 32) socket.destroy();
    });
    socket.setTimeout(6000, () => socket.destroy());
  });

  function shutdown() {
    if (stopping) return stopping;
    stopping = (async () => {
      await starting.catch(() => {});
      clearInterval(parentTimer);
      vite?.httpServer?.closeAllConnections();
      await vite?.close();
      const closed = new Promise((resolve) => control.close(resolve));
      for (const socket of clients) socket.end("stopped\n");
      await closed;
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
        process.off(signal, shutdown);
    })();
    return stopping;
  }

  await claimControl(control, endpoint);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, shutdown);
  // npm can exit without forwarding a signal to its child. Do not leave a
  // server behind when its launching terminal/process has gone away.
  const parent = process.ppid;
  parentTimer = setInterval(() => {
    if (process.ppid !== parent) shutdown();
    else {
      try {
        process.kill(parent, 0);
      } catch (error) {
        if (error.code === "ESRCH") shutdown();
      }
    }
  }, 500);
  parentTimer.unref();

  starting = (async () => {
    const options = { host: "127.0.0.1", port, strictPort: false };
    if (mode === "dev") {
      vite = await createServer({
        root,
        server: options,
        optimizeDeps: { force },
      });
      await vite.listen();
    } else vite = await preview({ root, preview: options });
    console.log(`Карта запущена: ${vite.resolvedUrls.local[0]}`);
    console.log(
      "Остановка: Ctrl+C или npm run stop. Повторный запуск заменит этот сервер.",
    );
  })();
  try {
    await starting;
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  run({ root }).catch((error) => {
    console.error(`Не удалось запустить карту: ${error.message}`);
    process.exitCode = 1;
  });
}
