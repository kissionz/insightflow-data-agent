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
  it("reports missing CLI configuration without asking InsightFlow for an API key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(path.join(root, ".montane/data-agent/ontology.sqlite"));
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("query must not run");
      },
      async () => {
        throw new Error(
          "Montane model configuration is incomplete: OPENAI_API_KEY is unavailable.",
        );
      },
    );

    const status = await harness.runtimeStatus();
    await harness.close();

    expect(status.configured).toBe(false);
    expect(status.error).toContain("Montane CLI");
    expect(status.error).toContain("无需另行配置模型密钥");
    expect(status.error).not.toContain("API_KEY");
    repository.close();
  });

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

  it("lets Montane submit semantic intent while the IR engine owns SQL", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(path.join(root, ".montane/data-agent/ontology.sqlite"));
    const ontology = structuredClone(testOntology);
    const order = ontology.objects[0];
    order.defaultTimePropertyId = "p_paid_at";
    order.properties.push(
      {
        id: "p_channel",
        name: "channel_code",
        label: "销售渠道",
        description: "订单来源渠道",
        dataType: "VARCHAR",
        sourceColumn: "channel_code",
        sensitive: false,
        meaning: "CATEGORY",
        unique: false,
        valueSearchable: true,
        visibility: "ANALYTICAL",
        synonyms: ["渠道"],
        defaultDisplay: true,
        exportable: true,
      },
      {
        id: "p_paid_at",
        name: "paid_at",
        label: "支付时间",
        description: "支付完成时间",
        dataType: "DATETIME",
        sourceColumn: "paid_at",
        sensitive: false,
        meaning: "TIME",
        unique: false,
        valueSearchable: false,
        visibility: "ANALYTICAL",
        synonyms: [],
        defaultDisplay: true,
        exportable: true,
      },
    );
    repository.saveOntology(ontology);
    repository.upsertScannedTables([
      {
        id: "t_orders",
        catalog: "internal",
        database: "retail",
        name: "fact_orders",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "fact_orders:v3",
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
    repository.replaceIndexedPropertyValues(
      ontology.version,
      order.id,
      "p_channel",
      [{ displayValue: "ONLINE", frequency: 80 }],
    );
    const conversation = createConversation();
    repository.saveConversation(conversation);
    const turn: Turn = {
      id: "turn_ir_harness",
      conversationId: conversation.id,
      question: "今年线上渠道销售额",
      status: "planning",
      createdAt: new Date().toISOString(),
      ontologyVersion: ontology.version,
      trace: [],
    };
    const model = new PlanningMontaneModel();
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const harness = new DataAgentHarness(
      root,
      repository,
      async (sql, _maxRows, parameters) => {
        queries.push({ sql, parameters });
        return {
          columns: ["成交金额"],
          rows: [{ 成交金额: 128000 }],
          durationMs: 12,
          truncated: false,
        };
      },
      () => runtimeFor(model),
    );

    const output = await harness.run(conversation, turn, {
      onTextDelta() {},
      onTextEnd() {},
      onToolStatus() {},
    });

    expect(model.seenTools).toContain("ExecuteAnalysisPlan");
    expect(model.seenTools).not.toContain("SelectDBQuery");
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("SUM(t0.`pay_amount`)");
    expect(queries[0].sql).toContain("t0.`channel_code` = ?");
    expect(queries[0].parameters?.[0]).toBe("ONLINE");
    expect(output.responseKind).toBe("analysis");
    expect(output.result?.rows).toEqual([{ 成交金额: 128000 }]);
    await harness.close();
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

  it("uses global exact value evidence even when lexical property hints are wrong", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = structuredClone(testOntology);
    ontology.version = 2;
    ontology.objects[0]!.properties.push({
      id: "p_channel_nature",
      name: "channel_nature",
      label: "渠道性质",
      description: "渠道分类性质",
      dataType: "VARCHAR",
      sourceColumn: "channel_nature",
      sensitive: false,
      meaning: "CATEGORY",
      unique: false,
      valueSearchable: true,
      visibility: "ANALYTICAL",
      synonyms: ["渠道"],
      defaultDisplay: true,
      exportable: true,
    });
    ontology.objects[2]!.properties.push({
      id: "p_org_unit",
      name: "org_unit",
      label: "组织单元",
      description: "销售归属组织单元",
      dataType: "VARCHAR",
      sourceColumn: "org_unit",
      sensitive: false,
      meaning: "CATEGORY",
      unique: false,
      valueSearchable: true,
      visibility: "ANALYTICAL",
      synonyms: ["组织"],
      defaultDisplay: true,
      exportable: true,
    });
    repository.saveOntology(ontology);
    repository.upsertScannedTables([
      {
        id: "t_orders",
        catalog: "internal",
        database: "retail",
        name: "fact_orders",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "fact_orders:v4",
        scannedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        id: "t_stores",
        catalog: "internal",
        database: "retail",
        name: "dim_stores",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "dim_stores:v2",
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
    repository.replaceIndexedPropertyValues(
      ontology.version,
      "o_store",
      "p_org_unit",
      [{ displayValue: "线上渠道", frequency: 128 }],
    );
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("published exact index should avoid a live query");
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const tool = (
      harness as unknown as { propertyValueSearchTool(): Tool }
    ).propertyValueSearchTool();

    const outcome = await tool.execute({
      value: "线上渠道",
      property_ids: ["p_channel_nature"],
      object_ids: ["o_order"],
      match_mode: "exact",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('"property":"组织单元"');
    expect(outcome.content).not.toContain('"property":"渠道性质"');
    expect(outcome.content).toContain("纠正了词形候选范围");
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

class PlanningMontaneModel implements ModelClient {
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_000,
    supportsStreaming: true,
    supportsToolUse: true,
    supportsImages: false,
  };
  private step = 0;
  seenTools: string[] = [];

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    onTextDelta?: (delta: string) => void;
  }): Promise<AgentResponse> {
    this.step += 1;
    this.seenTools = options.tools.map((tool) => String(tool.name));
    if (this.step === 1) {
      return {
        toolCalls: [{
          id: "call_ontology",
          name: "OntologySearch",
          args: { query: "今年线上渠道销售额" },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 2) {
      return {
        toolCalls: [{
          id: "call_value",
          name: "PropertyValueSearch",
          args: {
            value: "ONLINE",
            property_ids: ["p_channel"],
            object_ids: ["o_order"],
            match_mode: "exact",
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 3) {
      return {
        toolCalls: [{
          id: "call_plan",
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["m_gmv"],
            dimension_property_ids: [],
            filters: [{
              property_id: "p_channel",
              operator: "EQ",
              business_value: "线上",
              value: "ONLINE",
            }],
            time_range: {
              expression: "今年",
              property_id: "p_paid_at",
            },
            result_kind: "aggregate",
            title: "今年线上渠道销售额",
          },
        }],
        stopReason: "tool_use",
      };
    }
    const finalText = "今年线上渠道销售额为 128,000 元。";
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
