import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_EXPORTS = [
  "AgentLoop",
  "ContextBuilder",
  "SessionManager",
  "SessionStore",
  "ToolRegistry",
  "PermissionGate",
  "defaultPolicy",
  "OpenAIModel",
];
const REMOTE_SPEC =
  "git+https://github.com/kissionz/data-engineer.git#a8672f8f78bcb0ab5351698659a5a8e706835867";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (await isUsableMontane("montane-code")) {
  process.stdout.write("montane-code 已发现，直接复用当前项目依赖。\n");
  process.exit(0);
}

const localSource = await discoverLocalSource();
const source = localSource ?? process.env.MONTANE_CODE_SOURCE ?? REMOTE_SPEC;
process.stdout.write(
  localSource
    ? `发现本机 montane-code：${localSource}\n`
    : "当前项目尚未安装 montane-code，正在从 GitHub 安装固定版本…\n",
);

const npmExecutable = process.env.npm_execpath;
const command = npmExecutable ? process.execPath : "npm";
const args = npmExecutable
  ? [npmExecutable, "install", "--no-save", "--no-package-lock", source]
  : ["install", "--no-save", "--no-package-lock", source];
const result = spawnSync(command, args, {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...process.env, INSIGHTFLOW_ENSURE_MONTANE: "1" },
});

if (result.status !== 0 || !(await isUsableMontane("montane-code"))) {
  process.stderr.write(
    [
      "montane-code 安装失败。",
      `可手动执行：npm install "${REMOTE_SPEC}"`,
      "如果已经克隆到本机，可设置 MONTANE_CODE_SOURCE=/absolute/path/to/data-engineer 后重试。",
      "",
    ].join("\n"),
  );
  process.exit(result.status || 1);
}

process.stdout.write("montane-code 安装完成，Harness SDK 已就绪。\n");

async function isUsableMontane(specifier) {
  try {
    const module = await import(specifier);
    return REQUIRED_EXPORTS.every((name) => typeof module[name] !== "undefined");
  } catch {
    return false;
  }
}

async function discoverLocalSource() {
  const candidates = [
    process.env.MONTANE_CODE_PATH,
    path.resolve(projectRoot, "../data-engineer"),
    path.resolve(projectRoot, "../data engineer"),
    await globalPackagePath(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const packagePath = path.join(candidate, "package.json");
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (packageJson.name !== "montane-code") continue;
      const entry = packageJson.exports?.["."]?.import ?? packageJson.main;
      if (!entry || !fs.existsSync(path.resolve(candidate, entry))) continue;
      if (await isUsableMontane(pathToFileURL(path.resolve(candidate, entry)).href)) {
        return candidate;
      }
    } catch {
      // Continue through known local candidates before falling back to GitHub.
    }
  }
  return null;
}

async function globalPackagePath() {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable ? process.execPath : "npm";
  const args = npmExecutable ? [npmExecutable, "root", "-g"] : ["root", "-g"];
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  return path.join(result.stdout.trim(), "montane-code");
}
