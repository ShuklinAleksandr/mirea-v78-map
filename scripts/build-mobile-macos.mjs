import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  androidJavaCommand,
  androidSdkCandidates,
  inspectAndroidSdk,
  isSupportedJava,
  readAndroidRequirements,
  selectAndroidSdk,
} from "./mobile-doctor.mjs";

export function mobileMacBuildPlan(node = process.execPath) {
  return [
    {
      id: "tests",
      label: "Автоматические проверки",
      command: "npm",
      args: ["test"],
    },
    {
      id: "sync",
      label: "Общий комплект и синхронизация",
      command: "npm",
      args: ["run", "mobile:sync"],
    },
    {
      id: "integrity",
      label: "Контроль обоих нативных комплектов",
      command: "npm",
      args: ["run", "mobile:check"],
    },
    {
      id: "android",
      label: "Android Debug APK",
      command: node,
      args: ["scripts/build-android.mjs"],
    },
    {
      id: "ios",
      label: "iOS Simulator Debug",
      command: "xcodebuild",
      args: [
        "-project",
        "ios/App/App.xcodeproj",
        "-scheme",
        "App",
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        ".native-build/ios",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
    },
  ];
}

export function macBuildPreflight({
  project,
  platform = process.platform,
  nodeVersion = process.versions.node,
  env = process.env,
  probe = spawnSync,
  inspectSdk = inspectAndroidSdk,
  executable = (file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  const checks = [];
  const add = (id, ok, detail, required = true) =>
    checks.push({ id, ok, detail, required });
  if (platform !== "darwin") {
    add(
      "macos",
      false,
      "Эта команда собирает обе платформы на Mac. Запустите её в macOS с установленным Xcode.",
    );
    return { ok: false, checks, env };
  }
  const [major, minor] = nodeVersion.split(".").map(Number);
  add(
    "node",
    major > 22 || (major === 22 && minor >= 12),
    `Node ${nodeVersion}; требуется 22.12+.`,
  );
  function tool(id, command, args, supported, help, required = true) {
    const result = probe(command, args, {
      encoding: "utf8",
      timeout: 20000,
      env,
    });
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const ok =
      result.status === 0 && !result.error && supported(output, result);
    add(
      id,
      ok,
      ok
        ? id === "simulator-runtime"
          ? "Доступен iOS Simulator runtime для запуска приложения."
          : output
        : `${help}\n${result.error?.message || output || "Команда недоступна"}`,
      required,
    );
    return result;
  }
  tool(
    "npm",
    "npm",
    ["--version"],
    (output) => /^\d+\./.test(output),
    "Установите Node.js вместе с npm.",
  );
  tool(
    "xcode",
    "xcodebuild",
    ["-version"],
    (output) => Number(output.match(/\bXcode (\d+)/)?.[1]) >= 26,
    "Нужен полный Xcode 26+. Откройте Xcode, примите лицензию и установите компоненты. Выберите его Command Line Tools в Xcode Settings → Locations.",
  );
  tool(
    "simulator-sdk",
    "xcrun",
    ["--sdk", "iphonesimulator", "--show-sdk-path"],
    (output) => output.startsWith("/"),
    "В выбранном Xcode отсутствует iOS Simulator SDK. Проверьте Xcode Settings → Components.",
  );
  tool(
    "simulator-runtime",
    "xcrun",
    ["simctl", "list", "runtimes", "--json"],
    (output) => {
      try {
        return JSON.parse(output).runtimes.some(
          (runtime) =>
            runtime.isAvailable === true &&
            runtime.identifier.startsWith(
              "com.apple.CoreSimulator.SimRuntime.iOS-",
            ),
        );
      } catch {
        return false;
      }
    },
    "Для запуска в Simulator установите iOS runtime в Xcode Settings → Components. Компиляция с generic destination может выполняться без runtime.",
    false,
  );
  tool(
    "java",
    androidJavaCommand(env, "darwin"),
    ["-version"],
    (_, result) => isSupportedJava(result),
    "Нужен JDK 21+. Задайте JAVA_HOME на JDK 21 или новее; можно использовать совместимый JDK из Android Studio.",
  );
  add(
    "gradlew",
    executable(path.join(project, "android/gradlew")),
    "Для android/gradlew нужны права запуска. После переноса архива выполните chmod +x android/gradlew.",
  );
  let selected;
  try {
    const requirements = readAndroidRequirements(project);
    selected = selectAndroidSdk(
      androidSdkCandidates(project, { env, platform: "darwin" }),
      (sdk) =>
        inspectSdk(sdk, requirements, {
          platform: "darwin",
          runCommand: probe,
        }),
    );
    const failure = selected.rejected
      .map(
        (candidate) =>
          `${candidate.source}: ${candidate.sdk}\n${candidate.checks
            .filter((check) => !check.ok)
            .map((check) => `  ${check.label}: ${check.detail}`)
            .join("\n")}`,
      )
      .join("\n");
    add(
      "android-sdk",
      selected.ok,
      selected.ok
        ? `SDK: ${selected.sdk}; API ${requirements.compileSdk}, Build Tools ${requirements.buildTools}.`
        : `Установите SDK текущего Mac через Android Studio: API ${requirements.compileSdk}, Build Tools ${requirements.buildTools}, platform-tools; примите лицензии. Явный путь задаётся ANDROID_HOME.\n${failure}`,
    );
  } catch (error) {
    add("android-sdk", false, error.message);
  }
  return {
    ok: checks.every((check) => !check.required || check.ok),
    checks,
    env: selected?.ok
      ? { ...env, ANDROID_HOME: selected.sdk, ANDROID_SDK_ROOT: selected.sdk }
      : env,
  };
}

export async function verifyMacBuildArtifacts(project) {
  const apk = path.join(
    project,
    "android/app/build/outputs/apk/debug/app-debug.apk",
  );
  const app = path.join(
    project,
    ".native-build/ios/Build/Products/Debug-iphonesimulator/App.app",
  );
  for (const file of [
    apk,
    path.join(app, "Info.plist"),
    path.join(app, "App"),
  ]) {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0)
      throw new Error(`Не получен ожидаемый результат сборки: ${file}`);
  }
  return [
    {
      platform: "android",
      kind: "debug-apk",
      path: apk,
      bytes: (await stat(apk)).size,
    },
    { platform: "ios", kind: "simulator-app", path: app },
  ];
}

export async function runMacBuildPlan(
  steps,
  { execute, verifyArtifacts, onStatus = async () => {} },
) {
  const state = {
    status: "running",
    steps: steps.map((step) => ({ ...step, status: "pending" })),
    artifacts: [],
  };
  await onStatus(state);
  for (const step of state.steps) {
    step.status = "running";
    await onStatus(state);
    try {
      const result = await execute(step);
      if (result.code !== 0 || result.signal)
        throw new Error(
          `${step.label}: код ${result.code ?? "—"}${result.signal ? `, сигнал ${result.signal}` : ""}.`,
        );
      step.status = "passed";
    } catch (error) {
      step.status = "failed";
      step.error = error.message;
      state.status = "failed";
      for (const pending of state.steps.filter(
        (item) => item.status === "pending",
      ))
        pending.status = "not-run";
      await onStatus(state);
      return state;
    }
    await onStatus(state);
  }
  try {
    state.artifacts = await verifyArtifacts();
    if (state.artifacts.length !== 2)
      throw new Error("Не подтверждены оба результата сборки.");
    state.status = "passed";
  } catch (error) {
    state.status = "failed";
    state.error = error.message;
  }
  await onStatus(state);
  return state;
}

async function executeLogged(step, { project, env, logFile }) {
  const chunks = [];
  const result = await new Promise((resolve) => {
    console.log(`\n→ ${step.label}`);
    const child = spawn(step.command, step.args, {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      chunks.push(chunk);
    });
    let error;
    child.once("error", (failure) => {
      error = failure;
      chunks.push(Buffer.from(failure.message));
    });
    child.once("close", (code, signal) => resolve({ code, signal, error }));
  });
  await writeFile(logFile, Buffer.concat(chunks));
  if (result.error) throw result.error;
  return result;
}

async function main() {
  const project = path.resolve(import.meta.dirname, "..");
  const preflight = macBuildPreflight({ project });
  for (const check of preflight.checks)
    console.log(`${check.ok ? "✓" : "!"} ${check.id}: ${check.detail}`);
  if (!preflight.ok) {
    process.exitCode = 1;
    return;
  }
  if (
    !existsSync(path.join(project, "node_modules/@capacitor/cli/package.json"))
  ) {
    console.error("Сначала выполните npm ci в корне проекта на этом Mac.");
    process.exitCode = 1;
    return;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(project, ".native-build/macos", runId);
  await mkdir(directory, { recursive: true });
  const statusFile = path.join(directory, "status.json");
  const state = await runMacBuildPlan(mobileMacBuildPlan(), {
    execute: (step) =>
      executeLogged(step, {
        project,
        env: preflight.env,
        logFile: path.join(directory, `${step.id}.log`),
      }),
    verifyArtifacts: () => verifyMacBuildArtifacts(project),
    onStatus: (status) =>
      writeFile(
        statusFile,
        `${JSON.stringify({ runId, preflight: preflight.checks, ...status }, null, 2)}\n`,
        "utf8",
      ),
  });
  console.log(`\nОтчёт и журналы: ${directory}`);
  if (state.status !== "passed") {
    console.error(
      "Сборка не завершена. Смотрите ошибку и статус каждого этапа в отчёте.",
    );
    process.exitCode = 1;
    return;
  }
  for (const artifact of state.artifacts)
    console.log(`✓ ${artifact.kind}: ${artifact.path}`);
  console.log(
    "Android APK — отладочный; iOS App — только для Simulator. Для iPhone/TestFlight нужна отдельная подписанная сборка владельца.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
