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

  constructor(
    private readonly workspaceRoot: string,
    stateRoot: string,
  ) {
    this.windowsCredentialPath = path.join(
      stateRoot,
      "data-agent",
      "selectdb-password.dpapi",
    );
  }

  async setPassword(password: string): Promise<void> {
    if (process.platform === "darwin") {
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

    if (process.platform === "win32") {
      fs.mkdirSync(path.dirname(this.windowsCredentialPath), { recursive: true });
      const encodedPassword = Buffer.from(password, "utf8").toString("base64");
      await runPowerShell(`
$ErrorActionPreference = 'Stop'
$bytes = [Convert]::FromBase64String('${encodedPassword}')
$plain = [Text.Encoding]::UTF8.GetString($bytes)
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
$encrypted = ConvertFrom-SecureString -SecureString $secure
[IO.File]::WriteAllText(${powerShellLiteral(this.windowsCredentialPath)}, $encrypted)
`);
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

    if (process.platform === "darwin") {
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

    if (process.platform === "win32") {
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
    const encoded = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$encrypted = [IO.File]::ReadAllText(${powerShellLiteral(this.windowsCredentialPath)})
$secure = ConvertTo-SecureString -String $encrypted
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
`);
    return Buffer.from(encoded.trim(), "base64").toString("utf8");
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

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
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
    child.stdin.end(script);
  });
}
