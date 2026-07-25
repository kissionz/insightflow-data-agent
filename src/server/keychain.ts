import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "com.insightflow.data-agent.selectdb";

function accountFor(workspaceRoot: string): string {
  return Buffer.from(workspaceRoot).toString("base64url");
}

export class KeychainStore {
  private readonly windowsCredentialPath: string;
  private cachedPassword: string | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly executePowerShell: (
    script: string,
    input?: string,
  ) => Promise<string>;

  constructor(
    private readonly workspaceRoot: string,
    stateRoot: string,
    options: {
      platform?: NodeJS.Platform;
      executePowerShell?: (script: string, input?: string) => Promise<string>;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.executePowerShell = options.executePowerShell ?? runPowerShell;
    this.windowsCredentialPath = path.join(
      stateRoot,
      "data-agent",
      "selectdb-password.dpapi",
    );
  }

  async setPassword(password: string): Promise<void> {
    if (this.platform === "darwin") {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        accountFor(this.workspaceRoot),
        "-w",
        password,
      ]);
      this.cachedPassword = password;
      return;
    }

    if (this.platform === "win32") {
      fs.mkdirSync(path.dirname(this.windowsCredentialPath), { recursive: true });
      const encodedPassword = Buffer.from(password, "utf8").toString("base64");
      const encodedPath = Buffer.from(this.windowsCredentialPath, "utf8").toString(
        "base64",
      );
      await this.executePowerShell(
        `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
  $plain,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$temporaryPath = "$path.$PID.tmp"
[IO.File]::WriteAllBytes($temporaryPath, $encrypted)
if ([IO.File]::Exists($path)) {
  [IO.File]::Replace($temporaryPath, $path, $null)
} else {
  [IO.File]::Move($temporaryPath, $path)
}
`,
        encodedPassword,
      );
      const verified = await this.readWindowsPassword();
      if (verified !== password) {
        throw new Error("Windows DPAPI 凭据写入后回读校验失败");
      }
      this.cachedPassword = password;
      return;
    }

    throw new Error(
      "当前系统请通过 SELECTDB_PASSWORD 环境变量提供 SelectDB 密码",
    );
  }

  async getPassword(): Promise<string | null> {
    if (process.env.SELECTDB_PASSWORD) {
      return process.env.SELECTDB_PASSWORD;
    }
    if (this.cachedPassword) {
      return this.cachedPassword;
    }

    if (this.platform === "darwin") {
      try {
        const { stdout } = await execFileAsync("security", [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          accountFor(this.workspaceRoot),
          "-w",
        ]);
        return stdout.trim();
      } catch {
        return null;
      }
    }

    if (this.platform === "win32") {
      try {
        const password = await this.readWindowsPassword();
        this.cachedPassword = password;
        return password;
      } catch {
        return null;
      }
    }

    return null;
  }

  private async readWindowsPassword(): Promise<string> {
    const encodedPath = Buffer.from(this.windowsCredentialPath, "utf8").toString(
      "base64",
    );
    const encoded = await this.executePowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$encrypted = [IO.File]::ReadAllBytes($path)
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`);
    const payload = encoded.trim().split(/\r?\n/).at(-1) ?? "";
    return Buffer.from(payload, "base64").toString("utf8");
  }
}

export function credentialStoreKind():
  | "macos_keychain"
  | "windows_dpapi"
  | "environment" {
  if (process.platform === "darwin") return "macos_keychain";
  if (process.platform === "win32") return "windows_dpapi";
  return "environment";
}

function runPowerShell(script: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedCommand,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell 执行失败（${code}）`));
    });
    child.stdin.end(input);
  });
}
