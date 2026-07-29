import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentMessage,
  AgentReporter,
  AgentResponse,
  ConfiguredModelRuntime,
  ModelClient,
  Tool,
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
    ontology.metrics = [];
    const order = ontology.objects[0];
    order.properties
      .find((property) => property.id === "p_order_amount")!
      .synonyms.push("销售额", "销售金额");
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
      [{ displayValue: "线上渠道", frequency: 80 }],
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
    expect(model.seenTools).toContain("SubmitQuestionFrame");
    expect(model.seenTools).not.toContain("SelectDBQuery");
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("SUM(t0.`pay_amount`)");
    expect(queries[0].sql).toContain("t0.`channel_code` = ?");
    expect(queries[0].parameters?.[0]).toBe("线上渠道");
    expect(output.responseKind).toBe("analysis");
    expect(output.result?.rows).toEqual([{ 成交金额: 128000 }]);
    await harness.close();
    repository.close();
  });

  it("rejects row-filter downgrades and executes metric thresholds after aggregation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = ontologyWithGrossMargin();
    const salesMetric = ontology.metrics.find((metric) => metric.id === "m_gmv")!;
    salesMetric.label = "销售额";
    salesMetric.synonyms = [];
    const salesProperty = ontology.objects[0]!.properties.find(
      (property) => property.id === "p_order_amount",
    )!;
    salesProperty.label = "销售金额";
    salesProperty.synonyms = [];
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
        fingerprint: "fact_orders:aggregate-filter",
        scannedAt: "2026-07-28T00:00:00.000Z",
      },
      {
        id: "t_customers",
        catalog: "internal",
        database: "retail",
        name: "dim_customers",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "dim_customers:aggregate-filter",
        scannedAt: "2026-07-28T00:00:00.000Z",
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
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const captures: unknown[] = [];
    const harness = new DataAgentHarness(
      root,
      repository,
      async (sql, _maxRows, parameters) => {
        queries.push({ sql, parameters });
        return {
          columns: ["会员等级", "销售额", "毛利率"],
          rows: [{ 会员等级: "VIP", 销售额: 42_000_000, 毛利率: 0.8 }],
          durationMs: 12,
          truncated: false,
        };
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const frame = {
      originalQuestion: "今年各会员等级销售金额大于3000万，且毛利率大于75%的有哪些",
      intentKind: "DIRECT_QUERY" as const,
      metricTerms: ["销售金额", "毛利率"],
      timeTerms: ["今年"],
      objectTerms: [],
      businessValueTerms: [],
      groupingTerms: ["会员等级"],
      calculationTerms: ["大于3000万", "大于75%"],
      presentation: { kind: "TABLE" as const, sortDirection: "DESC" as const },
    };
    const tool = (
      harness as unknown as {
        executeAnalysisPlanTool(
          capture: (analysis: unknown) => void,
          timezone: string,
          valueBindings: Map<string, never>,
          getFrame: () => typeof frame,
        ): Tool;
      }
    ).executeAnalysisPlanTool(
      (analysis) => captures.push(analysis),
      "Asia/Shanghai",
      new Map(),
      () => frame,
    );

    const downgraded = await tool.execute({
      root_object_id: "o_order",
      measure_ids: ["m_gmv", "m_margin"],
      dimension_property_ids: ["p_customer_level"],
      filters: [
        {
          property_id: "p_order_amount",
          operator: "GT",
          value: "30000000",
        },
      ],
      result_kind: "aggregate",
      title: "错误降级计划",
    });

    expect(downgraded.ok).toBe(false);
    expect(downgraded.content).toContain("aggregate_filters");
    expect(downgraded.content).toContain("HAVING");
    expect(downgraded.data).toMatchObject({
      code: "AGGREGATE_THRESHOLD_COVERAGE_REQUIRED",
    });
    expect(queries).toHaveLength(0);
    expect(captures).toHaveLength(0);

    const corrected = await tool.execute({
      root_object_id: "o_order",
      measure_ids: ["m_gmv", "m_margin"],
      dimension_property_ids: ["p_customer_level"],
      filters: [],
      aggregate_filters: [
        { entity_id: "m_gmv", operator: "GT", value: 30_000_000 },
        { entity_id: "m_margin", operator: "GT", value: 0.75 },
      ],
      time_range: {
        expression: "今年",
        property_id: "p_paid_at",
      },
      sort: [{ entity_id: "m_gmv", direction: "DESC" }],
      result_kind: "aggregate",
      title: "今年高销售额高毛利率会员等级",
    });

    expect(corrected.ok).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("FROM `analyzed` AS a");
    expect(queries[0]!.sql).toContain("a.`销售额` > ?");
    expect(queries[0]!.sql).toContain("a.`毛利率` > ?");
    expect(queries[0]!.sql).not.toContain("t0.`pay_amount` > ?");
    expect(queries[0]!.parameters?.slice(-2)).toEqual([30_000_000, 0.75]);
    expect(captures).toHaveLength(1);

    const periodFrame = {
      originalQuestion: "近三年哪些会员等级每年毛利率都高于75%",
      intentKind: "DIRECT_QUERY" as const,
      metricTerms: ["毛利率"],
      timeTerms: ["近三年"],
      objectTerms: [],
      businessValueTerms: [],
      groupingTerms: ["会员等级", "年"],
      calculationTerms: ["每年都高于75%"],
      presentation: { kind: "TABLE" as const },
    };
    const periodTool = (
      harness as unknown as {
        executeAnalysisPlanTool(
          capture: (analysis: unknown) => void,
          timezone: string,
          valueBindings: Map<string, never>,
          getFrame: () => typeof periodFrame,
        ): Tool;
      }
    ).executeAnalysisPlanTool(
      (analysis) => captures.push(analysis),
      "Asia/Shanghai",
      new Map(),
      () => periodFrame,
    );
    const downgradedPeriod = await periodTool.execute({
      root_object_id: "o_order",
      measure_ids: ["m_margin"],
      dimension_property_ids: ["p_customer_level"],
      filters: [],
      aggregate_filters: [
        { entity_id: "m_margin", operator: "GT", value: 0.75 },
      ],
      time_range: { expression: "近三年", property_id: "p_paid_at" },
      time_grain: { unit: "YEAR", property_id: "p_paid_at" },
      result_kind: "aggregate",
      title: "错误跨期间计划",
    });
    expect(downgradedPeriod.ok).toBe(false);
    expect(downgradedPeriod.data).toMatchObject({
      code: "STAGED_ANALYSIS_COVERAGE_REQUIRED",
    });

    const correctedPeriod = await periodTool.execute({
      root_object_id: "o_order",
      measure_ids: ["m_margin"],
      dimension_property_ids: ["p_customer_level"],
      filters: [],
      time_range: { expression: "近三年", property_id: "p_paid_at" },
      time_grain: { unit: "YEAR", property_id: "p_paid_at" },
      period_conditions: [
        {
          id: "period_margin",
          label: "每年毛利率达标",
          measure_id: "m_margin",
          operator: "GT",
          value: 0.75,
          quantifier: "EVERY",
          group_by_property_ids: ["p_customer_level"],
          missing_period_policy: "FAIL",
        },
      ],
      sort: [{ entity_id: "p_customer_level", direction: "ASC" }],
      result_kind: "aggregate",
      title: "近三年每年毛利率达标会员等级",
    });
    expect(correctedPeriod.ok).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.sql).toContain("`period_regrouped` AS (");
    expect(queries[1]!.sql).toContain("`覆盖期间数` = 3");
    expect(queries[1]!.sql).toContain("`每年毛利率达标满足期间数` = 3");
    await harness.close();
    repository.close();
  });

  it("deterministically restores monthly grain when Montane omits time_grain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = structuredClone(testOntology);
    ontology.objects[0]!.defaultTimePropertyId = "p_paid_at";
    ontology.objects[0]!.properties.push({
      id: "p_paid_at",
      name: "paid_at",
      label: "支付日期",
      description: "支付日期",
      dataType: "DATETIME",
      sourceColumn: "paid_at",
      sensitive: false,
      meaning: "TIME",
      unique: false,
      valueSearchable: false,
      visibility: "ANALYTICAL",
      synonyms: ["日期"],
      defaultDisplay: true,
      exportable: true,
      bindingPriority: 50,
    });
    ontology.metrics[0]!.timePropertyId = "p_paid_at";
    repository.saveOntology(ontology);
    repository.upsertScannedTables([{
      id: "t_orders",
      catalog: "internal",
      database: "retail",
      name: "fact_orders",
      type: "TABLE",
      status: "MODELED",
      columns: [],
      fingerprint: "fact_orders:monthly",
      scannedAt: "2026-07-27T00:00:00.000Z",
    }]);
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
    const conversation = createConversation();
    repository.saveConversation(conversation);
    const queries: string[] = [];
    const harness = new DataAgentHarness(
      root,
      repository,
      async (sql) => {
        queries.push(sql);
        return {
          columns: ["月份", "成交金额"],
          rows: [{ 月份: "2026-01-01", 成交金额: 100 }],
          durationMs: 8,
          truncated: false,
        };
      },
      () => runtimeFor(new MonthlyPlanningMontaneModel()),
    );

    const output = await harness.run(
      conversation,
      {
        id: "turn_monthly_grain",
        conversationId: conversation.id,
        question: "今年销售额按月看",
        status: "planning",
        createdAt: new Date().toISOString(),
        ontologyVersion: ontology.version,
        trace: [],
      },
      {
        onTextDelta() {},
        onTextEnd() {},
        onToolStatus() {},
      },
    );

    expect(output.responseKind).toBe("analysis");
    expect(queries[0]).toContain("DATE_TRUNC(t0.`paid_at`, 'month')");
    expect(queries[0]).not.toContain("GROUP BY t0.`paid_at`");
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

  it("returns an aggregatable numeric property as a measure candidate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = structuredClone(testOntology);
    ontology.metrics = [];
    repository.saveOntology(ontology);
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("ontology search must not query SelectDB");
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const cache = new Map<string, ToolOutcome>();
    const tool = (
      harness as unknown as {
        ontologySearchTool(
          getFrame: () => unknown,
          cache: Map<string, ToolOutcome>,
        ): Tool;
      }
    ).ontologySearchTool(
      () => ({
        originalQuestion: "今年销售金额",
        intentKind: "DIRECT_QUERY",
        metricTerms: ["实付金额"],
        timeTerms: ["今年"],
        objectTerms: [],
        businessValueTerms: [],
        groupingTerms: [],
        calculationTerms: [],
        presentation: { kind: "SINGLE_VALUE" },
      }),
      cache,
    );

    const first = await tool.execute({ query: "今年销售金额" });
    const repeated = await tool.execute({ query: "今年销售金额" });

    expect(first.ok).toBe(true);
    expect(first.content).toContain('"id":"p_order_amount"');
    expect(first.content).toContain('"measureKind":"PROPERTY"');
    expect(first.content).toContain('"aggregation":"SUM"');
    expect(repeated.data).toMatchObject({ duplicateSuppressed: true });
    expect(repeated.content).toContain('"duplicateSuppressed":true');
    expect(repeated.content).toContain("禁止继续调用 OntologySearch");
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
    ontology.objects[0]!.bindingPriority = 20;
    ontology.objects[2]!.bindingPriority = 90;
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
      bindingPriority: 100,
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
      bindingPriority: 80,
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
    repository.replaceIndexedPropertyValues(
      ontology.version,
      "o_order",
      "p_channel_nature",
      [{ displayValue: "线上渠道", frequency: 999 }],
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
    expect(outcome.content).toContain('"property":"渠道性质"');
    expect(outcome.content).toContain('"selectionStatus":"selected"');
    expect(outcome.content).toContain('"selectionStatus":"rejected"');
    expect(outcome.content).toContain('"valueBindingId":"value_binding_');
    expect(outcome.content).toContain("纠正了词形候选范围");
    await harness.close();
    repository.close();
  });

  it("keeps concrete business values out of object terms", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("question framing must not query SelectDB");
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    let captured:
      | {
          intentKind: string;
          objectTerms: string[];
          businessValueTerms: string[];
        }
      | undefined;
    const tool = (
      harness as unknown as {
        questionFrameTool(
          question: string,
          capture: (frame: {
            intentKind: string;
            objectTerms: string[];
            businessValueTerms: string[];
          }) => unknown,
        ): Tool;
      }
    ).questionFrameTool(
      "舒敏保湿特护霜今年销售表现",
      (frame) => {
        captured = frame;
        return frame;
      },
    );

    const outcome = await tool.execute({
      original_question: "舒敏保湿特护霜今年销售表现",
      intent_kind: "EXPLORATORY_ANALYSIS",
      metric_terms: [],
      time_terms: ["今年"],
      object_terms: ["商品", "舒敏保湿特护霜"],
      business_value_terms: ["舒敏保湿特护霜"],
      grouping_terms: [],
      calculation_terms: [],
      presentation: { kind: "AUTO" },
    });

    expect(outcome.ok).toBe(true);
    expect(captured).toMatchObject({
      intentKind: "EXPLORATORY_ANALYSIS",
      objectTerms: ["商品"],
      businessValueTerms: ["舒敏保湿特护霜"],
    });
    await harness.close();
    repository.close();
  });

  it("rejects value-index searches that were not declared as business values", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("undeclared value lookup must be rejected before SelectDB");
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const tool = (
      harness as unknown as {
        propertyValueSearchTool(
          bindings: Map<string, unknown>,
          getFrame: () => {
            businessValueTerms: string[];
          },
        ): Tool;
      }
    ).propertyValueSearchTool(
      new Map(),
      () => ({ businessValueTerms: ["舒敏保湿特护霜"] }),
    );

    const outcome = await tool.execute({
      value: "毛利率",
      match_mode: "exact",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain("只能检索问题框架");
    expect(outcome.data).toMatchObject({
      allowedBusinessValues: ["舒敏保湿特护霜"],
    });
    await harness.close();
    repository.close();
  });

  it("keeps exploratory analysis rooted on a measurable fact object", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = structuredClone(testOntology);
    const customer = ontology.objects.find((object) => object.id === "o_customer")!;
    const amountProperty = ontology.objects
      .find((object) => object.id === "o_order")!
      .properties.find((property) => property.id === "p_order_amount")!;
    customer.bindingPriority = 100;
    customer.properties.push({
      ...structuredClone(amountProperty),
      id: "p_customer_value",
      name: "customer_value",
      label: "客户价值",
      sourceColumn: "customer_value",
    });
    repository.saveOntology(ontology);
    const harness = new DataAgentHarness(
      root,
      repository,
      async () => {
        throw new Error("analysis-space discovery must not query SelectDB");
      },
      () => runtimeFor(new ScriptedMontaneModel()),
    );
    const tool = (
      harness as unknown as {
        discoverAnalysisSpaceTool(
          getFrame: () => unknown,
          cache: Map<string, ToolOutcome>,
        ): Tool;
      }
    ).discoverAnalysisSpaceTool(
      () => ({
        originalQuestion: "客户销售表现怎么样",
        intentKind: "EXPLORATORY_ANALYSIS",
        metricTerms: [],
        timeTerms: [],
        objectTerms: ["客户"],
        businessValueTerms: [],
        groupingTerms: [],
        calculationTerms: [],
        presentation: { kind: "AUTO" },
      }),
      new Map(),
    );

    const outcome = await tool.execute({
      objective: "客户销售表现怎么样",
      object_ids: ["o_customer", "o_order"],
    });
    const data = outcome.data as {
      spaces: Array<{ object: { id: string } }>;
    };

    expect(outcome.ok).toBe(true);
    expect(data.spaces).toHaveLength(1);
    expect(data.spaces[0].object.id).toBe("o_order");
    await harness.close();
    repository.close();
  });

  it("lets Montane explore one published fact object through multiple governed IR queries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(
      path.join(root, ".montane/data-agent/ontology.sqlite"),
    );
    const ontology = structuredClone(testOntology);
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
        fingerprint: "fact_orders:exploration",
        scannedAt: "2026-07-27T00:00:00.000Z",
      },
      {
        id: "t_customers",
        catalog: "internal",
        database: "retail",
        name: "dim_customers",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "dim_customers:exploration",
        scannedAt: "2026-07-27T00:00:00.000Z",
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
    const conversation = createConversation();
    repository.saveConversation(conversation);
    const model = new ExploratoryMontaneModel();
    const queries: string[] = [];
    const rejectedPlanCodes: string[] = [];
    const harness = new DataAgentHarness(
      root,
      repository,
      async (sql) => {
        queries.push(sql);
        return queries.length === 1
          ? {
              columns: ["成交金额"],
              rows: [{ 成交金额: 128000 }],
              durationMs: 8,
              truncated: false,
            }
          : {
              columns: ["会员等级", "成交金额"],
              rows: [
                { 会员等级: "VIP", 成交金额: 88000 },
                { 会员等级: "普通", 成交金额: 40000 },
              ],
              durationMs: 11,
              truncated: false,
            };
      },
      () => runtimeFor(model),
    );

    const output = await harness.run(
      conversation,
      {
        id: "turn_exploration",
        conversationId: conversation.id,
        question: "订单销售表现怎么样",
        status: "planning",
        createdAt: new Date().toISOString(),
        ontologyVersion: ontology.version,
        trace: [],
      },
      {
        onTextDelta() {},
        onTextEnd() {},
        onToolStatus(call, status, result) {
          if (
            call.id.startsWith("call_explore_duplicate") &&
            status === "failed"
          ) {
            rejectedPlanCodes.push(
              String(
                (result?.data as { code?: string } | undefined)?.code ?? "",
              ),
            );
          }
        },
      },
    );

    expect(model.seenTools).toContain("DiscoverAnalysisSpace");
    expect(rejectedPlanCodes).toEqual([
      "DUPLICATE_ANALYSIS_PLAN",
      "DUPLICATE_ANALYSIS_PLAN",
      "DUPLICATE_ANALYSIS_PLAN",
    ]);
    expect(model.turnCount).toBe(9);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("member_level");
    expect(output.responseKind).toBe("analysis");
    expect(output.result?.rows).toEqual([{ 成交金额: 128000 }]);
    expect(output.answer).toContain("VIP");
    const events = fs.readFileSync(
      path.join(root, ".montane", "sessions", output.sessionId, "events.jsonl"),
      "utf8",
    );
    expect(events).not.toContain('"type":"summary"');
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
          id: "call_frame",
          name: "SubmitQuestionFrame",
          args: {
            original_question: "今年线上渠道销售额",
            intent_kind: "DIRECT_QUERY",
            metric_terms: ["销售额"],
            time_terms: ["今年"],
            object_terms: [],
            business_value_terms: ["线上渠道"],
            grouping_terms: [],
            calculation_terms: ["求和"],
            presentation: { kind: "SINGLE_VALUE" },
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 2) {
      return {
        toolCalls: [{
          id: "call_ontology",
          name: "OntologySearch",
          args: { query: "今年线上渠道销售额" },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 3) {
      return {
        toolCalls: [{
          id: "call_value",
          name: "PropertyValueSearch",
          args: {
            value: "线上渠道",
            property_ids: ["p_channel"],
            object_ids: ["o_order"],
            match_mode: "exact",
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 4) {
      const serialized = JSON.stringify(options.messages);
      const bindingId = serialized.match(
        /"valueBindingId"\s*:\s*"([^"]+)"/,
      )?.[1];
      if (!bindingId) throw new Error("PropertyValueSearch 未返回绑定句柄");
      return {
        toolCalls: [{
          id: "call_plan",
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["p_order_amount"],
            dimension_property_ids: [],
            filters: [{
              value_binding_id: bindingId,
              operator: "EQ",
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

class MonthlyPlanningMontaneModel implements ModelClient {
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_000,
    supportsStreaming: true,
    supportsToolUse: true,
    supportsImages: false,
  };
  private step = 0;

  async complete(options: {
    messages: AgentMessage[];
    tools: Array<Record<string, unknown>>;
    onTextDelta?: (delta: string) => void;
  }): Promise<AgentResponse> {
    this.step += 1;
    if (this.step === 1) {
      return {
        toolCalls: [{
          id: "call_month_frame",
          name: "SubmitQuestionFrame",
          args: {
            original_question: "今年销售额按月看",
            intent_kind: "DIRECT_QUERY",
            metric_terms: ["销售额"],
            time_terms: ["今年"],
            object_terms: [],
            business_value_terms: [],
            grouping_terms: ["按月"],
            calculation_terms: ["求和"],
            presentation: { kind: "TREND" },
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 2) {
      return {
        toolCalls: [{
          id: "call_month_ontology",
          name: "OntologySearch",
          args: { query: "今年销售额按月看" },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 3) {
      return {
        toolCalls: [{
          id: "call_month_plan",
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["m_gmv"],
            dimension_property_ids: ["p_paid_at"],
            filters: [],
            time_range: {
              expression: "今年",
              property_id: "p_paid_at",
            },
            result_kind: "aggregate",
            title: "今年月度销售额",
          },
        }],
        stopReason: "tool_use",
      };
    }
    const finalText = "已按月返回今年销售额。";
    options.onTextDelta?.(finalText);
    return { finalText, stopReason: "end_turn" };
  }
}

class ExploratoryMontaneModel implements ModelClient {
  readonly capabilities = {
    contextWindow: 64_000,
    maxOutputTokens: 4_000,
    supportsStreaming: true,
    supportsToolUse: true,
    supportsImages: false,
  };
  private step = 0;
  seenTools: string[] = [];

  get turnCount(): number {
    return this.step;
  }

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
          id: "call_explore_frame",
          name: "SubmitQuestionFrame",
          args: {
            original_question: "订单销售表现怎么样",
            intent_kind: "EXPLORATORY_ANALYSIS",
            metric_terms: [],
            time_terms: [],
            object_terms: ["订单"],
            business_value_terms: [],
            grouping_terms: [],
            calculation_terms: [],
            presentation: { kind: "AUTO" },
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 2) {
      return {
        toolCalls: [{
          id: "call_explore_ontology",
          name: "OntologySearch",
          args: { query: "订单销售表现怎么样" },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 3) {
      return {
        toolCalls: [{
          id: "call_explore_space",
          name: "DiscoverAnalysisSpace",
          args: {
            objective: "订单销售表现怎么样",
            object_ids: ["o_order"],
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 4) {
      return {
        toolCalls: [{
          id: "call_explore_overview",
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["m_gmv"],
            dimension_property_ids: [],
            filters: [],
            result_kind: "aggregate",
            title: "订单销售总览",
            analysis_step: {
              id: "step_overview",
              objective: "确认整体成交金额",
              rationale: "先取得核心销售指标，判断是否需要继续拆解",
              role: "OVERVIEW",
            },
          },
        }],
        stopReason: "tool_use",
      };
    }
    if (this.step === 5) {
      return {
        toolCalls: [{
          id: "call_explore_diagnostic",
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["m_gmv"],
            dimension_property_ids: ["p_customer_level"],
            filters: [],
            sort: [{ entity_id: "m_gmv", direction: "DESC" }],
            limit: 10,
            result_kind: "aggregate",
            title: "会员等级贡献",
            analysis_step: {
              id: "step_customer_level",
              objective: "定位不同会员等级的成交贡献",
              rationale: "总览确认有真实成交额，继续验证客户结构贡献",
              role: "DIAGNOSTIC",
            },
          },
        }],
        stopReason: "tool_use",
      };
    }
    if ([6, 7, 8].includes(this.step)) {
      return {
        toolCalls: [{
          id: `call_explore_duplicate_${this.step}`,
          name: "ExecuteAnalysisPlan",
          args: {
            root_object_id: "o_order",
            measure_ids: ["m_gmv"],
            dimension_property_ids: ["p_customer_level"],
            filters: [],
            sort: [{ entity_id: "m_gmv", direction: "DESC" }],
            limit: 10,
            result_kind: "aggregate",
            title: "会员等级贡献",
            analysis_step: {
              id: `step_duplicate_${this.step}`,
              objective: "重复确认会员等级贡献",
              rationale: "验证重复计划保护",
              role: "DIAGNOSTIC",
            },
          },
        }],
        stopReason: "tool_use",
      };
    }
    const finalText = "成交金额为 128,000 元，其中 VIP 客户贡献 88,000 元。";
    options.onTextDelta?.(finalText);
    return { finalText, stopReason: "end_turn" };
  }
}

function ontologyWithGrossMargin() {
  const ontology = structuredClone(testOntology);
  const order = ontology.objects.find((object) => object.id === "o_order")!;
  order.defaultTimePropertyId = "p_paid_at";
  order.properties.push(
    {
      id: "p_paid_at",
      name: "paid_at",
      label: "支付日期",
      description: "支付完成日期",
      dataType: "DATETIME",
      sourceColumn: "paid_at",
      sensitive: false,
      meaning: "TIME",
      unique: false,
      valueSearchable: false,
      visibility: "ANALYTICAL",
      synonyms: ["日期"],
      defaultDisplay: true,
      exportable: true,
      bindingPriority: 50,
    },
    {
      id: "p_cost_amount",
      name: "cost_amount",
      label: "成本金额",
      description: "订单成本",
      dataType: "DECIMAL",
      sourceColumn: "cost_amount",
      sensitive: false,
      meaning: "NUMBER",
      unique: false,
      valueSearchable: false,
      numericSpec: {
        kind: "CURRENCY",
        currency: "CNY",
        defaultAggregation: "SUM",
        aggregationBehavior: "ADDITIVE",
      },
      visibility: "ANALYTICAL",
      synonyms: [],
      defaultDisplay: true,
      exportable: true,
      bindingPriority: 50,
    },
  );
  ontology.metrics[0]!.timePropertyId = "p_paid_at";
  ontology.metrics.push(
    {
      id: "m_cost",
      metricType: "BASE",
      name: "cost",
      label: "成本额",
      description: "成本金额合计",
      objectId: "o_order",
      expression: "SUM(fact_orders.cost_amount)",
      definitionMode: "VISUAL",
      sourcePropertyId: "p_cost_amount",
      timePropertyId: "p_paid_at",
      aggregation: "SUM",
      format: "currency",
      synonyms: [],
      status: "PUBLISHED",
    },
    {
      id: "m_profit",
      metricType: "DERIVED",
      name: "profit",
      label: "毛利额",
      description: "成交金额减成本额",
      objectId: "o_order",
      expression: "",
      definitionMode: "VISUAL",
      leftMetricId: "m_gmv",
      rightMetricId: "m_cost",
      calculationOperator: "SUBTRACT",
      aggregation: "CUSTOM",
      format: "currency",
      synonyms: [],
      status: "PUBLISHED",
    },
    {
      id: "m_margin",
      metricType: "DERIVED",
      name: "margin",
      label: "毛利率",
      description: "毛利额除以成交金额",
      objectId: "o_order",
      expression: "",
      definitionMode: "VISUAL",
      leftMetricId: "m_profit",
      rightMetricId: "m_gmv",
      calculationOperator: "RATIO",
      scale: 1,
      aggregation: "CUSTOM",
      format: "percent",
      synonyms: [],
      status: "PUBLISHED",
    },
  );
  return ontology;
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
