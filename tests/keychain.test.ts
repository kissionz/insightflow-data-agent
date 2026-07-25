import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeychainStore } from "../src/server/keychain.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("KeychainStore on Windows", () => {
  it("writes and verifies a UTF-8 password with direct DPAPI scripts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-dpapi-"));
    roots.push(root);
    const scripts: string[] = [];
    const inputs: string[] = [];
    const password = "密钥-'quoted'-🔐";
    const executePowerShell = async (
      script: string,
      input = "",
    ): Promise<string> => {
      scripts.push(script);
      inputs.push(input);
      return scripts.length === 1
        ? ""
        : Buffer.from(password, "utf8").toString("base64");
    };
    const store = new KeychainStore(root, path.join(root, ".montane"), {
      platform: "win32",
      executePowerShell,
    });

    await store.setPassword(password);

    expect(await store.getPassword()).toBe(password);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("ProtectedData]::Protect");
    expect(scripts[0]).toContain("WriteAllBytes");
    expect(scripts[1]).toContain("ProtectedData]::Unprotect");
    expect(scripts.join("\n")).not.toContain(password);
    expect(inputs[0]).toBe(Buffer.from(password, "utf8").toString("base64"));
  });

  it("rejects a mismatched DPAPI round trip", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-dpapi-"));
    roots.push(root);
    const store = new KeychainStore(root, path.join(root, ".montane"), {
      platform: "win32",
      executePowerShell: async (script) =>
        script.includes("Unprotect")
          ? Buffer.from("wrong", "utf8").toString("base64")
          : "",
    });

    await expect(store.setPassword("expected")).rejects.toThrow(
      "Windows DPAPI 凭据写入后回读校验失败",
    );
  });

  it("migrates a legacy SecureString credential without asking again", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-dpapi-"));
    roots.push(root);
    const credentialPath = path.join(
      root,
      ".montane",
      "data-agent",
      "selectdb-password.dpapi",
    );
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, "01000000d08c9ddf0115d1118c7a00c04fc297eb");
    const password = "legacy-密钥";
    const scripts: string[] = [];
    const store = new KeychainStore(root, path.join(root, ".montane"), {
      platform: "win32",
      executePowerShell: async (script) => {
        scripts.push(script);
        if (script.includes("ConvertTo-SecureString")) {
          return Buffer.from(password, "utf8").toString("base64");
        }
        if (script.includes("Unprotect")) {
          return Buffer.from(password, "utf8").toString("base64");
        }
        return "";
      },
    });

    expect(await store.getPassword()).toBe(password);
    expect(scripts.some((script) => script.includes("ConvertTo-SecureString"))).toBe(
      true,
    );
    expect(scripts.some((script) => script.includes("ProtectedData]::Protect"))).toBe(
      true,
    );
  });
});
