import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "com.insightflow.data-agent.selectdb";
const POWERSHELL_ERROR_MARKER = "INSIGHTFLOW_ERROR_BASE64:";

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
[IO.File]::WriteAllBytes($path, $encrypted)
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
        const legacy = this.isLegacyWindowsCredential();
        const password = legacy
          ? await this.readLegacyWindowsPassword()
          : await this.readWindowsPassword();
        if (legacy) await this.setPassword(password);
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
Write-InsightFlowOutput ([Convert]::ToBase64String($plain))
`);
    const payload = encoded.trim().split(/\r?\n/).at(-1) ?? "";
    return Buffer.from(payload, "base64").toString("utf8");
  }

  private isLegacyWindowsCredential(): boolean {
    try {
      const value = fs.readFileSync(this.windowsCredentialPath, "utf8").trim();
      return value.length > 0 && /^[0-9a-f]+$/i.test(value);
    } catch {
      return false;
    }
  }

  private async readLegacyWindowsPassword(): Promise<string> {
    const encodedPath = Buffer.from(this.windowsCredentialPath, "utf8").toString(
      "base64",
    );
    const encoded = await this.executePowerShell(`
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
$encrypted = [IO.File]::ReadAllText($path)
$secure = ConvertTo-SecureString -String $encrypted
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  Write-InsightFlowOutput ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
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
    const encodedCommand = Buffer.from(
      wrapPowerShellScript(script),
      "utf16le",
    ).toString("base64");
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      reject(new Error(`无法启动 Windows PowerShell：${error.message}`));
    });
    child.once("close", (code) => {
      const output = decodePowerShellText(Buffer.concat(stdout));
      if (code === 0) {
        resolve(output);
        return;
      }
      const errorOutput = Buffer.concat(stderr);
      reject(
        new Error(
          `Windows DPAPI 执行失败：${
            decodePowerShellError(errorOutput) ||
            `PowerShell 退出码 ${code}`
          }`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

function wrapPowerShellScript(script: string): string {
  return `
$ErrorActionPreference = 'Stop'
function Write-InsightFlowBytes([IO.Stream]$Stream, [string]$Value) {
  $bytes = [Text.Encoding]::ASCII.GetBytes($Value)
  $Stream.Write($bytes, 0, $bytes.Length)
}
function Write-InsightFlowOutput([string]$Value) {
  Write-InsightFlowBytes ([Console]::OpenStandardOutput()) $Value
}
trap {
  $message = $_.Exception.ToString()
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
  Write-InsightFlowBytes ([Console]::OpenStandardError()) ('${POWERSHELL_ERROR_MARKER}' + $payload)
  exit 1
}
${script}
`;
}

function decodePowerShellError(value: Buffer): string {
  const ascii = value.toString("ascii");
  const markerIndex = ascii.lastIndexOf(POWERSHELL_ERROR_MARKER);
  if (markerIndex >= 0) {
    const payload = ascii
      .slice(markerIndex + POWERSHELL_ERROR_MARKER.length)
      .trim();
    try {
      return Buffer.from(payload, "base64").toString("utf8").trim();
    } catch {
      // Fall through to the best-effort platform decoder.
    }
  }
  return decodePowerShellText(value).trim();
}

function decodePowerShellText(value: Buffer): string {
  if (value.length === 0) return "";
  if (value[0] === 0xff && value[1] === 0xfe) {
    return value.subarray(2).toString("utf16le");
  }
  let zeroBytes = 0;
  for (const byte of value) {
    if (byte === 0) zeroBytes += 1;
  }
  return zeroBytes > value.length / 4
    ? value.toString("utf16le")
    : value.toString("utf8");
}
