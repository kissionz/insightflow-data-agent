import {
  AgentLoop,
  ContextBuilder,
  PermissionGate,
  SessionManager,
  SessionStore,
  ToolRegistry,
  defaultPolicy,
  resolveConfiguredModel,
  type ConfiguredModelRuntime,
  type AgentReporter,
  type Tool,
  type ToolOutcome,
} from "montane-code";
import type {
  Conversation,
  ResultArtifact,
  Turn,
} from "../shared/types.js";
import { Repository } from "./repository.js";
import { appendDetailOnlyProperties } from "./detail-projection.js";
import { SemanticIndex } from "./semantic-index.js";
import type { QueryResult } from "./selectdb.js";
import { guardReadOnlySql } from "./sql-guard.js";

const DATA_AGENT_SYSTEM_PROMPT = `
你是 InsightFlow Data Agent，运行在 Montane Harness 中。

必须遵循以下执行协议：
1. 先判断用户是在打招呼、询问能力，还是提出数据分析请求。
2. 打招呼或询问能力时直接简短回答，不调用数据工具，不生成图表或业务结论。
3. 数据分析请求必须先调用 OntologySearch，将问题绑定到已发布业务对象、属性、指标和关系。
4. 只能根据 OntologySearch 返回的语义生成查询，不得猜测表名、字段或关系。
5. 然后调用 SelectDBQuery 执行一条只读 SQL；只允许 SELECT 或 WITH ... SELECT。
6. 必须检查关系基数、扇出风险和分析粒度。
7. 最终使用中文给出简洁、可验证的结论，只能引用工具返回的数据。
8. 信息不足时向用户说明需要补充的条件，不得编造默认业务结果。
9. 不得在最终答案中暴露数据源地址、用户名、密码或内部配置。
10. 不得调用未提供的工具，也不得省略查询执行直接编造结果。
`.trim();

interface HarnessRunResult {
  answer: string;
  result?: ResultArtifact;
  responseKind:
    | "analysis"
    | "conversation"
    | "configuration_required"
    | "clarification";
  sessionId: string;
}

interface CapturedAnalysis {
  artifact: ResultArtifact;
  sql: string;
}

type ManagedSession = Awaited<ReturnType<SessionManager["create"]>>;

export class DataAgentHarness {
  private readonly sessionManager: SessionManager;
  private readonly sessions = new Map<string, ManagedSession>();
  private modelRuntimePromise?: Promise<ConfiguredModelRuntime>;

  constructor(
    private readonly workspaceRoot: string,
    private readonly repository: Repository,
    private readonly executeLiveQuery: (
      sql: string,
      maxRows: number,
    ) => Promise<QueryResult>,
    private readonly resolveModelRuntime: () => Promise<ConfiguredModelRuntime> =
      () => resolveConfiguredModel({ workspaceRoot }),
  ) {
    this.sessionManager = new SessionManager(workspaceRoot, {
      model: "montane-configured",
    });
  }

  async run(
    conversation: Conversation,
    turn: Turn,
    reporter: AgentReporter,
  ): Promise<HarnessRunResult> {
    const managed = await this.getOrCreateSession(conversation);
    const source = this.repository.getDataSource();
    const runtime = await this.getModelRuntime();
    let captured: CapturedAnalysis | null = null;
    const tools = new ToolRegistry();
    tools.register(this.ontologySearchTool());
    tools.register(
      this.selectDbQueryTool((analysis) => {
        captured = analysis;
      }),
    );

    const policy = defaultPolicy();
    policy.allowedTools.add("OntologySearch");
    policy.allowedTools.add("SelectDBQuery");
    const permissions = new PermissionGate(policy, this.workspaceRoot);
    const session = new SessionStore(
      managed.sessionPath,
      managed.id,
      async (event) => {
        await managed.updateLastSequence(event.sequence);
      },
    );
    const context = new ContextBuilder(
      this.workspaceRoot,
      60,
      DATA_AGENT_SYSTEM_PROMPT,
    );
    const loop = new AgentLoop(
      runtime.client,
      tools,
      permissions,
      context,
      session,
      8,
      async () => "reject" as const,
      reporter,
      undefined,
      undefined,
      async (status) => {
        await managed.updateStatus(status);
      },
      {
        maxTurns: 8,
        maxWallTimeMs: 190_000,
        maxInputTokens: 120_000,
        maxOutputTokens: 12_000,
        maxToolCalls: 8,
        maxModelRetries: 2,
      },
    );

    const answer = await loop.run(turn.question);
    const completed = captured as CapturedAnalysis | null;
    const asksForData = isLikelyDataQuestion(turn.question);
    const responseKind: HarnessRunResult["responseKind"] = completed
      ? "analysis"
      : asksForData && !source.configured
        ? "configuration_required"
        : asksForData
          ? "clarification"
          : "conversation";

    return {
      answer,
      result: completed
        ? {
            ...completed.artifact,
            conclusion: answer,
          }
        : undefined,
      responseKind,
      sessionId: managed.id,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.release()));
    this.sessions.clear();
  }

  async runtimeStatus(): Promise<{
    configured: boolean;
    provider?: string;
    model?: string;
    error?: string;
  }> {
    try {
      const runtime = await this.getModelRuntime();
      return {
        configured: true,
        provider: runtime.provider,
        model: runtime.model,
      };
    } catch (error) {
      return {
        configured: false,
        error:
          error instanceof Error
            ? error.message
            : "Montane 模型运行时不可用",
      };
    }
  }

  private async getModelRuntime(): Promise<ConfiguredModelRuntime> {
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = this.resolveModelRuntime();
    }
    try {
      return await this.modelRuntimePromise;
    } catch (error) {
      this.modelRuntimePromise = undefined;
      throw error;
    }
  }

  private async getOrCreateSession(conversation: Conversation): Promise<ManagedSession> {
    const existing = this.sessions.get(conversation.id);
    if (existing) return existing;

    let managed: ManagedSession;
    if (conversation.harnessSessionId) {
      try {
        managed = await this.sessionManager.resume(conversation.harnessSessionId);
      } catch {
        managed = await this.sessionManager.create({ title: conversation.title });
      }
    } else {
      managed = await this.sessionManager.create({ title: conversation.title });
    }
    this.sessions.set(conversation.id, managed);

    if (conversation.harnessSessionId !== managed.id) {
      this.repository.saveConversation({
        ...conversation,
        harnessSessionId: managed.id,
      });
    }
    return managed;
  }

  private ontologySearchTool(): Tool {
    return {
      name: "OntologySearch",
      description:
        "检索已发布业务本体，返回与问题匹配的对象、指标、属性、关系路径与扇出风险。",
      effect: "readonly",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "需要绑定到业务语义的原始用户问题",
          },
        },
        required: ["query"],
      },
      execute: async (args): Promise<ToolOutcome> => {
        const query = String(args.query ?? "");
        const ontology = this.repository.getOntology();
        const index = new SemanticIndex(ontology);
        const matches = index.search(query, 10);
        const objectIds = matches
          .filter((match) => match.kind === "object")
          .map((match) => match.id);
        const metricObjectIds = matches
          .filter((match) => match.kind === "metric")
          .map(
            (match) =>
              ontology.metrics.find((metric) => metric.id === match.id)?.objectId,
          )
          .filter((id): id is string => Boolean(id));
        const relevantIds = new Set([...objectIds, ...metricObjectIds]);
        const objects = ontology.objects.filter((object) => relevantIds.has(object.id));
        const metrics = ontology.metrics.filter((metric) =>
          matches.some((match) => match.id === metric.id),
        );
        const relations = ontology.relations.filter(
          (relation) =>
            relation.enabled &&
            (relevantIds.has(relation.sourceObjectId) ||
              relevantIds.has(relation.targetObjectId)),
        );
        const tables = this.repository.getTables();
        const payload = {
          ontologyVersion: ontology.version,
          matches,
          objects: objects.map((object) => ({
            id: object.id,
            label: object.label,
            table: tables.find((table) => table.id === object.sourceTableId)?.name,
            properties: object.properties
              .filter((property) => property.visibility === "ANALYTICAL")
              .map((property) => ({
                label: property.label,
                column: property.sourceColumn,
                dataType: property.dataType,
                sensitive: property.sensitive,
                semanticType: property.semanticType,
                identityRole: property.identityRole,
              })),
          })),
          metrics: metrics.map((metric) => ({
            label: metric.label,
            expression: metric.expression,
            aggregation: metric.aggregation,
          })),
          relations: relations.map((relation) => ({
            name: relation.name,
            joinExpression: relation.joinExpression,
            cardinality: relation.cardinality,
            fanoutRisk: relation.fanoutRisk,
          })),
        };
        return {
          ok: true,
          content: JSON.stringify(payload),
          data: payload,
        };
      },
    };
  }

  private selectDbQueryTool(
    capture: (analysis: CapturedAnalysis) => void,
  ): Tool {
    return {
      name: "SelectDBQuery",
      description:
        "执行经过安全校验的 SelectDB/Doris 只读查询。聚合结果最多 200 行，明细最多 50 行。",
      effect: "readonly",
      timeoutMs: 180_000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sql: {
            type: "string",
            description: "一条 SELECT 或 WITH ... SELECT 查询",
          },
          result_kind: {
            type: "string",
            enum: ["aggregate", "detail"],
          },
          title: {
            type: "string",
            description: "结果图表的中文标题",
          },
        },
        required: ["sql", "result_kind", "title"],
      },
      execute: async (args): Promise<ToolOutcome> => {
        const requestedSql = String(args.sql ?? "");
        const resultKind = args.result_kind === "detail" ? "detail" : "aggregate";
        const title = String(args.title ?? "分析结果");
        const maxRows = resultKind === "detail" ? 50 : 200;
        const sql =
          resultKind === "detail"
            ? appendDetailOnlyProperties(
                requestedSql,
                this.repository.getPublishedOntology(),
                this.repository.getTables(),
              )
            : requestedSql;
        guardReadOnlySql(sql, maxRows);

        const artifact = createLiveResult(
          title,
          await this.executeLiveQuery(sql, maxRows),
        );
        capture({ artifact, sql });
        return {
          ok: true,
          content: JSON.stringify({
            mode: artifact.mode,
            title: artifact.chart.title,
            rowCount: artifact.rowCount,
            columns: artifact.columns,
            rows: artifact.rows.slice(0, 50),
            truncated: artifact.truncated,
          }),
          data: {
            mode: artifact.mode,
            rowCount: artifact.rowCount,
            columns: artifact.columns,
            rows: artifact.rows.slice(0, 50),
            truncated: artifact.truncated,
          },
        };
      },
    };
  }
}

function isLikelyDataQuestion(question: string): boolean {
  return /分析|数据|指标|销售|订单|成交|收入|营收|金额|客户|会员|商品|品类|门店|区域|趋势|增长|下降|环比|同比|对比|排名|占比|多少|几|哪些|最高|最低|平均|总计|汇总|明细|GMV|AOV|TOP\s*\d*/i.test(
    question,
  );
}

function createLiveResult(title: string, query: QueryResult): ResultArtifact {
  const columns = query.columns;
  const rows = query.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "number" ? value : value == null ? "—" : String(value),
      ]),
    ),
  ) as ResultArtifact["rows"];
  const categoryColumn = columns.find((column) =>
    rows.some((row) => typeof row[column] === "string"),
  );
  const numberColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "number"),
  );
  const categories = rows
    .slice(0, 12)
    .map((row, index) => String(row[categoryColumn ?? columns[0]] ?? index + 1));
  const series = numberColumns.slice(0, 3).map((column) => ({
    name: column,
    data: rows.slice(0, 12).map((row) => Number(row[column] ?? 0)),
  }));

  return {
    kind: "analysis",
    mode: "live",
    conclusion: "",
    kpis: [
      { label: "结果行数", value: String(query.rows.length) },
      { label: "数值字段", value: String(numberColumns.length) },
      { label: "查询耗时", value: `${query.durationMs}ms` },
    ],
    chart: {
      title,
      type: "bar",
      categories,
      series: series.length ? series : [{ name: "记录数", data: categories.map(() => 1) }],
    },
    columns,
    rows,
    rowCount: query.rows.length,
    truncated: query.truncated,
  };
}
