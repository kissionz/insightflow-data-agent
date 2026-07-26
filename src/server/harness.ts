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
  OntologyObject,
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
4. 当问题包含可能是具体属性值的词语，且 OntologySearch 不能唯一确定字段时，必须调用 PropertyValueSearch 定位属性列；多个候选时必须让用户澄清。
5. 只能根据工具返回的语义生成查询，不得猜测表名、字段、属性值归属或关系。
6. 然后调用 SelectDBQuery 执行一条只读 SQL；只允许 SELECT 或 WITH ... SELECT。
7. 必须根据对象类型、行级粒度、数字聚合规则、关系基数和扇出风险选择查询方法。
8. 最终使用中文给出简洁、可验证的结论，只能引用工具返回的数据。
9. 信息不足时向用户说明需要补充的条件，不得编造默认业务结果。
10. 不得在最终答案中暴露数据源地址、用户名、密码或内部配置。
11. 不得调用未提供的工具，也不得省略查询执行直接编造结果。
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
      parameters?: unknown[],
      timeoutMs?: number,
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
    tools.register(this.propertyValueSearchTool());
    tools.register(
      this.selectDbQueryTool((analysis) => {
        captured = analysis;
      }),
    );

    const policy = defaultPolicy();
    policy.allowedTools.add("OntologySearch");
    policy.allowedTools.add("PropertyValueSearch");
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
          .filter((match) => match.kind === "object" || match.kind === "property")
          .map((match) => match.objectId ?? match.id);
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
            objectType: object.objectType,
            table: tables.find((table) => table.id === object.sourceTableId)?.name,
            grain: effectiveGrainLabels(object),
            properties: object.properties
              .filter((property) => property.visibility === "ANALYTICAL")
              .map((property) => ({
                label: property.label,
                column: property.sourceColumn,
                dataType: property.dataType,
                sensitive: property.sensitive,
                meaning: property.meaning,
                unique: property.unique,
                valueSearchable: property.valueSearchable,
                numericSpec: property.numericSpec,
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

  private propertyValueSearchTool(): Tool {
    return {
      name: "PropertyValueSearch",
      description:
        "在用户允许的非敏感属性中定位具体业务值属于哪个对象和字段。优先使用 OntologySearch 返回的 property_ids 或 object_ids 缩小范围。",
      effect: "readonly",
      timeoutMs: 35_000,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: {
            type: "string",
            description: "需要定位字段归属的原始业务值，例如华东、VIP、上海门店",
          },
          property_ids: {
            type: "array",
            items: { type: "string" },
            description: "OntologySearch 返回的候选属性 ID",
          },
          object_ids: {
            type: "array",
            items: { type: "string" },
            description: "OntologySearch 返回的候选对象 ID",
          },
          match_mode: {
            type: "string",
            enum: ["exact", "prefix"],
          },
        },
        required: ["value"],
      },
      execute: async (args): Promise<ToolOutcome> => {
        const value = String(args.value ?? "").trim();
        if (!value) {
          return { ok: false, content: "属性值不能为空" };
        }
        if (!this.repository.getDataSource().configured) {
          return {
            ok: false,
            content: "SelectDB 尚未配置，无法定位真实属性值。",
          };
        }
        const ontology = this.repository.getPublishedOntology();
        const propertyIds = new Set(
          Array.isArray(args.property_ids)
            ? args.property_ids.map(String)
            : [],
        );
        const objectIds = new Set(
          Array.isArray(args.object_ids) ? args.object_ids.map(String) : [],
        );
        const tables = new Map(
          this.repository.getTables().map((table) => [table.id, table]),
        );
        const candidates = ontology.objects
          .filter((object) => !objectIds.size || objectIds.has(object.id))
          .flatMap((object) =>
            object.properties
              .filter(
                (property) =>
                  property.visibility === "ANALYTICAL" &&
                  property.valueSearchable &&
                  !property.sensitive &&
                  (!propertyIds.size || propertyIds.has(property.id)),
              )
              .map((property) => ({
                object,
                property,
                table: tables.get(object.sourceTableId),
              })),
          )
          .filter(
            (
              candidate,
            ): candidate is typeof candidate & {
              table: NonNullable<typeof candidate.table>;
            } => Boolean(candidate.table),
          )
          .slice(0, 12);

        const normalizedValue = normalizePropertyValue(value);
        const cached = this.repository.findCachedPropertyValues(
          ontology.version,
          normalizedValue,
          candidates.map((candidate) => candidate.property.id),
        );
        if (cached.length) {
          const matches = cached.flatMap((entry) => {
            const candidate = candidates.find(
              (item) => item.property.id === entry.propertyId,
            );
            return candidate
              ? [{
                  objectId: candidate.object.id,
                  object: candidate.object.label,
                  propertyId: candidate.property.id,
                  property: candidate.property.label,
                  column: candidate.property.sourceColumn,
                  matchedValue: entry.displayValue,
                  source: "local-cache",
                }]
              : [];
          });
          return valueSearchOutcome(value, matches);
        }

        const matches: Array<{
          objectId: string;
          object: string;
          propertyId: string;
          property: string;
          column: string;
          matchedValue: string;
          source: "selectdb";
        }> = [];
        for (let offset = 0; offset < candidates.length; offset += 4) {
          const batch = candidates.slice(offset, offset + 4);
          const results = await Promise.allSettled(
            batch.map(async ({ object, property, table }) => {
              const column = quoteIdentifier(property.sourceColumn);
              const tableName = `${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`;
              const prefix = args.match_mode === "prefix";
              const sql = `SELECT CAST(${column} AS STRING) AS matched_value FROM ${tableName} WHERE CAST(${column} AS STRING) ${prefix ? "LIKE CONCAT(?, '%')" : "= ?"} LIMIT 3`;
              const result = await this.executeLiveQuery(
                sql,
                3,
                [value],
                8_000,
              );
              return result.rows.map((row) => ({
                objectId: object.id,
                object: object.label,
                propertyId: property.id,
                property: property.label,
                column: property.sourceColumn,
                matchedValue: String(row.matched_value ?? value),
                source: "selectdb" as const,
              }));
            }),
          );
          for (const result of results) {
            if (result.status === "fulfilled") matches.push(...result.value);
          }
          if (matches.length >= 8) break;
        }

        const deduplicated = [
          ...new Map(
            matches.map((match) => [
              `${match.propertyId}:${normalizePropertyValue(match.matchedValue)}`,
              match,
            ]),
          ).values(),
        ].slice(0, 8);
        const now = new Date().toISOString();
        for (const match of deduplicated) {
          this.repository.cachePropertyValue({
            ontologyVersion: ontology.version,
            objectId: match.objectId,
            propertyId: match.propertyId,
            normalizedValue: normalizePropertyValue(match.matchedValue),
            displayValue: match.matchedValue,
            updatedAt: now,
          });
        }
        return valueSearchOutcome(value, deduplicated);
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

function effectiveGrainLabels(object: OntologyObject): string[] {
  const idProperty = object.properties.find((property) => property.meaning === "ID");
  const grainIds = idProperty ? [idProperty.id] : object.grainPropertyIds;
  return grainIds
    .map((id) => object.properties.find((property) => property.id === id)?.label)
    .filter((label): label is string => Boolean(label));
}

function normalizePropertyValue(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function valueSearchOutcome(
  value: string,
  matches: Array<{
    objectId: string;
    object: string;
    propertyId: string;
    property: string;
    column: string;
    matchedValue: string;
    source: string;
  }>,
): ToolOutcome {
  const ambiguous = new Set(matches.map((match) => match.propertyId)).size > 1;
  const payload = {
    value,
    status:
      matches.length === 0
        ? "not_found"
        : !ambiguous
          ? "resolved"
          : "ambiguous",
    matches,
    instruction:
      ambiguous
        ? "多个属性包含该值，必须向用户澄清，不得自行选择。"
        : matches.length === 0
          ? "没有找到可靠属性绑定，请向用户补充字段或业务对象。"
          : "已定位属性，可使用返回的对象、列和属性值生成查询。",
  };
  return {
    ok: true,
    content: JSON.stringify(payload),
    data: payload,
  };
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
