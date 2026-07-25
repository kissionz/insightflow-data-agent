import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "com.insightflow.data-agent.selectdb";

function accountFor(workspaceRoot: string): string {
  return Buffer.from(workspaceRoot).toString("base64url");
}

export class KeychainStore {
  constructor(private readonly workspaceRoot: string) {}

  async setPassword(password: string): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("当前 MVP 仅支持在 macOS 钥匙串中保存 SelectDB 密码");
    }

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
  }

  async getPassword(): Promise<string | null> {
    if (process.env.SELECTDB_PASSWORD) {
      return process.env.SELECTDB_PASSWORD;
    }

    if (process.platform !== "darwin") {
      return null;
    }

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
}
