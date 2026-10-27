import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const launcher = new URL("../scripts/serve.mjs", import.meta.url).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  // Windows TEMP may contain an 8.3 alias. Vite resolves request paths to the
  // long name, so its filesystem allow list must receive that same real path.
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "mirea-launch-test-"),
  );
  await writeFile(path.join(root, "index.html"), "<h1>launcher fixture</h1>");
  await mkdir(path.join(root, "dist"));
  await writeFile(
    path.join(root, "dist/index.html"),
    "<h1>preview fixture</h1>",
  );
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => child.done));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    start(args) {
      const code = `import { run } from ${JSON.stringify(launcher)}; await run(${JSON.stringify({ root, args })});`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", code],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.output = "";
      child.stdout.on("data", (data) => {
        child.output += data;
      });
      child.stderr.on("data", (data) => {
        child.output += data;
      });
      child.done = once(child, "exit");
      children.push(child);
      return child;
    },
  };
}

async function ready(child) {
  for (let i = 0; i < 160; i++) {
    const match = child.output.match(/Карта запущена: (http:\/\/[^\s]+)/);
    if (match) return match[1];
    if (child.exitCode !== null) throw new Error(child.output);
    await pause(50);
  }
  throw new Error(`Server did not start: ${child.output}`);
}

async function exited(child) {
  let timer;
  try {
    return await Promise.race([
      child.done,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Server did not exit: ${child.output}`)),
          7000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function assertReleased(port) {
  const probe = net.createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((resolve) => probe.close(resolve));
}

test(
  "two simultaneous launches leave only one server for the project",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      port = await freePort();
    const first = f.start(["dev", "--port", String(port)]);
    const second = f.start(["dev", "--port", String(port)]);
    await Promise.race([exited(first), exited(second)]);
    const running = [first, second].filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    assert.equal(running.length, 1);
    const url = await ready(running[0]);
    assert.equal(Number(new URL(url).port), port);
    assert.match(await (await fetch(url)).text(), /launcher fixture/);
    await exited(f.start(["stop"]));
    await Promise.all([exited(first), exited(second)]);
    await assertReleased(port);
  },
);

test(
  "relaunch replaces this project's server on the same port; stop releases it",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      port = await freePort();
    const first = f.start(["dev", "--port", String(port)]);
    const url = await ready(first);
    assert.match(await (await fetch(url)).text(), /launcher fixture/);
    const second = f.start(["dev", "--port", String(port)]);
    assert.equal(await ready(second), url);
    assert.equal((await exited(first))[0], 0);
    assert.match(await (await fetch(url)).text(), /launcher fixture/);
    assert.equal((await exited(f.start(["stop"])))[0], 0);
    assert.equal((await exited(second))[0], 0);
    await assertReleased(port);
  },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(
    `${signal} termination releases Vite's listener`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        port = await freePort();
      const server = f.start(["dev", "--port", String(port)]);
      await ready(server);
      server.kill(signal);
      const [code, exitSignal] = await exited(server);
      if (process.platform === "win32") {
        // Node's kill() forcibly terminates Windows children; it does not
        // deliver POSIX signals to their JS handlers. IPC stop/relaunch tests
        // above and below independently verify graceful shutdown on Windows.
        assert.equal(code, null);
        assert.equal(exitSignal, signal === "SIGHUP" ? "SIGKILL" : signal);
      } else {
        // Vite also handles SIGTERM and may return its conventional 128 + 15.
        assert.ok(code === 0 || (signal === "SIGTERM" && code === 143));
        assert.equal(exitSignal, null);
      }
      await assertReleased(port);
    },
  );
}

test(
  "a foreign listener is preserved; fallback ports are also cleaned on relaunch",
  { timeout: 20000 },
  async (t) => {
    const foreign = http.createServer((_, response) =>
      response.end("foreign server"),
    );
    foreign.listen(0, "127.0.0.1");
    await once(foreign, "listening");
    t.after(() => new Promise((resolve) => foreign.close(resolve)));
    const port = foreign.address().port,
      f = await fixture(t);
    const first = f.start(["dev", "--port", String(port)]);
    const url = await ready(first);
    assert.notEqual(Number(new URL(url).port), port);
    const second = f.start(["dev", "--port", String(port)]);
    assert.equal(await ready(second), url);
    await exited(first);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      "foreign server",
    );
    await exited(f.start(["stop"]));
    await exited(second);
    await assertReleased(Number(new URL(url).port));
  },
);

test(
  "next launch recovers the IPC socket left by a killed server",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      port = await freePort();
    const first = f.start(["dev", "--port", String(port)]);
    const url = await ready(first);
    first.kill("SIGKILL");
    await exited(first);
    const second = f.start(["dev", "--port", String(port)]);
    assert.equal(await ready(second), url);
    await exited(f.start(["stop"]));
    await exited(second);
    await assertReleased(port);
  },
);

test(
  "stop closes both development and preview and is safe to repeat",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      devPort = await freePort(),
      previewPort = await freePort();
    const dev = f.start(["dev", "--port", String(devPort)]);
    await ready(dev);
    const preview = f.start(["preview", "--port", String(previewPort)]);
    assert.match(
      await (await fetch(await ready(preview))).text(),
      /preview fixture/,
    );
    assert.equal((await exited(f.start(["stop"])))[0], 0);
    await Promise.all([exited(dev), exited(preview)]);
    await assertReleased(devPort);
    await assertReleased(previewPort);
    assert.equal((await exited(f.start(["stop"])))[0], 0);
  },
);
