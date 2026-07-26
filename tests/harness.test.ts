import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentMessage,
  AgentReporter,
  AgentResponse,
  ConfiguredModelRuntime,
  ModelClient,
  ToolCall,
  ToolOutcome,
  ToolStatus,
} from "montane-code";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation, Turn } from "../src/shared/types.js";
import { DataAgentHarness } from "../src/server/harness.js";
import { Repository } from "../src/server/repository.js";
import { testOntology } from "./fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DataAgentHarness", () => {
  it("answers a greeting through AgentLoop without fabricating an analysis", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(path.join(root, ".montane/data-agent/ontology.sqlite"));
    const conversation = createConversation();
    repository.saveConversation(conversation);
    const turn: Turn = {
      id: "turn_harness_test",
      conversationId: conversation.id,
      question: "你好",
      status: "planning",
      createdAt: new Date().toISOString(),
      ontologyVersion: repository.getOntology().version,
      trace: [],
    };
    const toolStatuses: Array<{ name: string; status: ToolStatus }> = [];
    const reporter: AgentReporter = {
      onTextDelta() {},
      onTextEnd() {},
      onToolStatus(call: ToolCall, status: ToolStatus, _result?: ToolOutcome) {
        toolStatuses.push({ name: call.name, status });
      },
    };
    const harness = new DataAgentHarness(root, repository, async () => {
      throw new Error("greeting must not access SelectDB");
    }, () => runtimeFor(new ScriptedMontaneModel()));

    const output = await harness.run(conversation, turn, reporter);
    await harness.close();

    expect(output.responseKind).toBe("conversation");
    expect(output.result).toBeUndefined();
    expect(output.answer).toContain("你好");
    expect(toolStatuses).toEqual([]);
    expect(repository.getConversation(conversation.id)?.harnessSessionId).toBe(
      output.sessionId,
    );

    const eventPath = path.join(
      root,
      ".montane",
      "sessions",
      output.sessionId,
      "events.jsonl",
    );
    const events = fs.readFileSync(eventPath, "utf8");
    expect(events).toContain('"type":"assistant_final"');
    repository.close();
  });

  it("uses Montane for the response while blocking SQL when SelectDB is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(path.join(root, ".montane/data-agent/ontology.sqlite"));
    const conversation = createConversation();
    repository.saveConversation(conversation);
    const turn: Turn = {
      id: "turn_unconfigured_test",
      conversationId: conversation.id,
      question: "分析本月订单增长",
      status: "planning",
      createdAt: new Date().toISOString(),
      ontologyVersion: 0,
      trace: [],
    };
    const harness = new DataAgentHarness(root, repository, async () => {
      throw new Error("unconfigured mode must not access SelectDB");
    }, () => runtimeFor(new ScriptedMontaneModel()));

    const output = await harness.run(conversation, turn, {
      onTextDelta() {},
      onTextEnd() {},
      onToolStatus() {},
    });
    await harness.close();

    expect(output.responseKind).toBe("configuration_required");
    expect(output.result).toBeUndefined();
    expect(output.answer).toContain("请先配置 SelectDB");
    repository.close();
  });

  it("locates a governed property value and reuses its local cache", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    repository.saveOntology(testOntology);
    repository.upsertScannedTables([
      {
        id: "t_customers",
        catalog: "internal",
        database: "retail",
        name: "dim_customers",
        type: "TABLE",
        status: "MODELED",
        columns: [
          {
            name: "customer_id",
            dataType: "BIGINT",
            nullable: false,
            sensitive: false,
          },
          {
            name: "member_level",
            dataType: "VARCHAR",
            nullable: false,
            sensitive: false,
          },
        ],
        fingerprint: "dim_customers:v2",
        scannedAt: "2026-07-26T00:00:00.000Z",
      },
    ]);
    repository.saveDataSource({
      configured: true,
      host: "selectdb.test",
      port: 9030,
      username: "reader",
      database: "retail",
      catalog: "internal",
      tls: false,
      passwordStored: true,
    });
    const calls: Array<{ sql: string; parameters?: unknown[] }> = [];
    const harness = new DataAgentHarness(
      root,
      repository,
      async (sql, _maxRows, parameters) => {
        calls.push({ sql, parameters });
        return {
          columns: ["matched_value"],
          rows: [{ matched_value: "VIP" }],
          durationMs: 3,
          truncated: false,
        };
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const tool = (
      harness as unknown as { propertyValueSearchTool(): Tool }
    ).propertyValueSearchTool();

    const first = await tool.execute({
      value: "VIP",
      property_ids: ["p_customer_level"],
    });
    const second = await tool.execute({
      value: "VIP",
      property_ids: ["p_customer_level"],
    });

    expect(first.ok).toBe(true);
    expect(first.content).toContain('"status":"resolved"');
    expect(first.content).toContain('"property":"会员等级"');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("`member_level`");
    expect(calls[0].parameters).toEqual(["VIP"]);
    expect(second.content).toContain('"source":"local-cache"');
    await harness.close();
    repository.close();
  });
});

class ScriptedMontaneModel implements ModelClient {
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_000,
    supportsStreaming: true,
    supportsToolUse: true,
    supportsImages: false,
  };

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    onTextDelta?: (delta: string) => void;
  }): Promise<AgentResponse> {
    const question =
      [...options.messages].reverse().find((message) => message.role === "user")
        ?.content ?? "";
    const finalText = question === "你好"
      ? "你好，我是由 Montane 执行的 InsightFlow Data Agent。"
      : "请先配置 SelectDB，再执行真实数据分析。";
    options.onTextDelta?.(finalText);
    return { finalText, stopReason: "end_turn" };
  }
}

async function runtimeFor(client: ModelClient): Promise<ConfiguredModelRuntime> {
  return {
    client,
    provider: "mock",
    model: "scripted-montane-test",
    configPath: "/test/config.json",
    envFilePath: "/test/.env",
  };
}

function createConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: "conv_test",
    title: "测试会话",
    createdAt: now,
    updatedAt: now,
    status: "active",
    turns: [],
  };
}
