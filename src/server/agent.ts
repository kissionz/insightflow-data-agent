import type {
  AgentReporter,
  ToolCall,
  ToolOutcome,
  ToolStatus,
} from "montane-code";
import type { TraceStep, Turn } from "../shared/types.js";
import { EventHub } from "./events.js";
import { DataAgentHarness } from "./harness.js";
import { createId } from "./id.js";
import { Repository } from "./repository.js";

const TRACE_BLUEPRINT: Array<{
  kind: TraceStep["kind"];
  label: string;
}> = [
  { kind: "understanding", label: "问题理解" },
  { kind: "semantic_binding", label: "语义绑定" },
  { kind: "query_plan", label: "查询方案" },
  { kind: "sql", label: "编译 SQL" },
  { kind: "execution", label: "数据结果" },
];

export class DataAgent {
  private readonly running = new Set<string>();

  constructor(
    private readonly repository: Repository,
    private readonly events: EventHub,
    private readonly harness: DataAgentHarness,
  ) {}

  createTurn(conversationId: string, question: string): Turn {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("会话不存在");
    const ontology = this.repository.getOntology();
    const agentConfig = this.repository.getAgentConfig();
    const now = new Date().toISOString();
    const turnId = createId("turn");
    const turn: Turn = {
      id: turnId,
      conversationId,
      parentTurnId: conversation.turns.at(-1)?.id,
      question,
      status: "understanding",
      createdAt: now,
      ontologyVersion: ontology.version,
      promptVersion: agentConfig.version,
      trace: TRACE_BLUEPRINT.map((step) => ({
        id: createId("trace"),
        turnId,
        kind: step.kind,
        label: step.label,
        status: "pending",
        summary: "等待 Harness 前序事件",
        createdAt: now,
      })),
    };
    this.repository.saveTurn(turn);
    this.events.publish({
      conversationId,
      turnId,
      type: "turn_created",
      turn,
    });
    void this.run(turn);
    return turn;
  }

  private async run(initialTurn: Turn): Promise<void> {
    if (this.running.has(initialTurn.id)) return;
    this.running.add(initialTurn.id);
    let turn = initialTurn;

    const persist = (type: "turn_updated" | "trace_step_started" | "trace_step_completed") => {
      turn = structuredClone(turn);
      this.repository.saveTurn(turn);
      this.events.publish({
        conversationId: turn.conversationId,
        turnId: turn.id,
        type,
        turn,
      });
    };
    const updateStep = (
      kind: TraceStep["kind"],
      status: TraceStep["status"],
      patch: Pick<TraceStep, "summary"> &
        Partial<Pick<TraceStep, "detail" | "facts" | "code">>,
    ) => {
      const index = turn.trace.findIndex((step) => step.kind === kind);
      if (index < 0) return;
      const current = turn.trace[index]!;
      const facts = patch.facts
        ? mergeTraceFacts(current.facts, patch.facts)
        : current.facts;
      turn.trace[index] = {
        ...current,
        status,
        ...patch,
        facts,
        completedAt:
          status === "completed" || status === "skipped" || status === "failed"
            ? new Date().toISOString()
            : undefined,
      };
      persist(status === "running" ? "trace_step_started" : "trace_step_completed");
    };

    try {
      updateStep(
        "understanding",
        "running",
        {
          summary: turn.parentTurnId
            ? "Montane 正在结合本轮问题和会话上下文提取分析意图"
            : "Montane 正在从问题中提取指标、维度、筛选和时间范围",
        },
      );
      turn.status = "planning";

      const conversation = this.repository.getConversation(turn.conversationId);
      if (!conversation) throw new Error("会话不存在");
      const reporter = new HarnessTurnReporter(
        (kind, status, patch) => {
          if (kind === "execution" && status === "running") turn.status = "querying";
          updateStep(kind, status, patch);
        },
      );
      const output = await this.harness.run(conversation, turn, reporter);
      completeUnusedTrace(turn, output.responseKind);
      turn.status =
        output.responseKind === "configuration_required" ||
        output.responseKind === "clarification"
          ? "needs_clarification"
          : "completed";
      turn.answer = output.answer;
      turn.responseKind = output.responseKind;
      turn.result = output.result;
      turn.completedAt = new Date().toISOString();
      turn = structuredClone(turn);
      this.repository.saveTurn(turn);
      this.events.publish({
        conversationId: turn.conversationId,
        turnId: turn.id,
        type: "turn_completed",
        turn,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Harness 分析失败";
      const running = turn.trace.find((step) => step.status === "running");
      if (running) updateStep(running.kind, "failed", { summary: message });
      turn.status = "failed";
      turn.answer = message;
      turn.completedAt = new Date().toISOString();
      this.repository.saveTurn(turn);
      this.events.publish({
        conversationId: turn.conversationId,
        turnId: turn.id,
        type: "turn_failed",
        turn,
      });
    } finally {
      this.running.delete(initialTurn.id);
    }
  }
}

export function mergeTraceFacts(
  current: TraceStep["facts"] = [],
  incoming: TraceStep["facts"] = [],
): NonNullable<TraceStep["facts"]> {
  const merged = new Map<string, NonNullable<TraceStep["facts"]>[number]>();
  for (const fact of [...current, ...incoming]) {
    const key = JSON.stringify([
      fact.label,
      fact.value,
      fact.source,
      fact.entityId,
    ]);
    merged.set(key, fact);
  }
  return [...merged.values()].slice(0, 40);
}

class HarnessTurnReporter implements AgentReporter {
  constructor(
    private readonly update: (
      kind: TraceStep["kind"],
      status: TraceStep["status"],
      patch: Pick<TraceStep, "summary"> &
        Partial<Pick<TraceStep, "detail" | "facts" | "code">>,
    ) => void,
  ) {}

  onTextDelta(_delta: string): void {}

  onTextEnd(): void {}

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (call.name === "OntologySearch") {
      this.handleOntologyStatus(status, result);
      return;
    }
    if (call.name === "PropertyValueSearch") {
      this.handlePropertyValueStatus(status, result);
      return;
    }
    if (call.name === "ExecuteAnalysisPlan") {
      this.handlePlanStatus(call, status, result);
    }
  }

  private handleOntologyStatus(status: ToolStatus, result?: ToolOutcome): void {
    if (status === "running") {
      this.update(
        "understanding",
        "running",
        { summary: "Montane 已识别为数据问题，正在检索已发布本体" },
      );
      this.update("semantic_binding", "running", {
        summary: "正在匹配对象、指标、属性和同义词",
      });
      return;
    }
    if (status === "succeeded") {
      const data = result?.data as
        | {
          matches?: Array<{ label?: string }>;
            relations?: Array<{
              name?: string;
              cardinality?: string;
              fanoutRisk?: string;
            }>;
          }
        | undefined;
      const matches = (data?.matches ?? []) as Array<{
        kind?: string;
        id?: string;
        label?: string;
        score?: number;
        matchedBy?: string;
      }>;
      const labels =
        matches
          .map((match) => match.label)
          .filter((label): label is string => Boolean(label))
          .slice(0, 5) ?? [];
      const relations = data?.relations ?? [];
      this.update(
        "semantic_binding",
        "completed",
        {
          summary: labels.length
            ? `候选语义：${labels.join("、")}`
            : "未命中可用本体语义",
          facts: matches.slice(0, 8).map((match) => ({
            label:
              match.kind === "metric"
                ? "候选指标"
                : match.kind === "property"
                  ? "候选属性"
                  : "候选对象",
            value: match.label || "—",
            source: `词形“${match.matchedBy || "—"}” · 匹配分 ${Math.round((match.score ?? 0) * 100)}%`,
            entityId: match.id,
          })),
          detail: relations.length
            ? `发现 ${relations.length} 条候选对象关系。词形候选不代表属性值归属，具体值仍由全局值索引验证。`
            : "词形候选不代表属性值归属，具体值仍由全局值索引验证。",
        },
      );
      return;
    }
    if (isFailure(status)) {
      this.update(
        "semantic_binding",
        "failed",
        { summary: result?.content || "OntologySearch 执行失败" },
      );
    }
  }

  private handlePropertyValueStatus(
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (status === "running") {
      this.update("semantic_binding", "running", {
        summary: "正在通过已发布属性值索引定位业务值",
      });
      return;
    }
    if (status === "succeeded") {
      const data = result?.data as
        | {
            status?: string;
            matches?: Array<{
              object?: string;
              propertyId?: string;
              property?: string;
              matchedValue?: string;
              source?: string;
              frequency?: number;
              matchType?: string;
              hinted?: boolean;
              rankingReason?: string;
            }>;
          }
        | undefined;
      const matches = data?.matches ?? [];
      this.update("semantic_binding", "completed", {
        summary: matches.length
          ? `属性值已定位：${matches
              .slice(0, 3)
              .map((match) => `${match.property} = ${match.matchedValue}`)
              .join("、")}`
          : "属性值索引未找到可靠绑定",
        facts: matches.map((match) => ({
          label: [match.object, match.property].filter(Boolean).join(" · ") || "属性值",
          value: match.matchedValue || "—",
          source: [
            match.source === "published-index"
              ? `全局发布值索引${match.matchType === "prefix" ? "前缀" : "精确"}命中`
              : match.source === "local-cache"
                ? "查询缓存命中"
                : "SelectDB 定向验证",
            match.frequency ? `频次 ${match.frequency}` : "",
            match.rankingReason || "",
          ].filter(Boolean).join(" · "),
          entityId: match.propertyId,
        })),
      });
      return;
    }
    if (isFailure(status)) {
      this.update("semantic_binding", "failed", {
        summary: result?.content || "属性值定位失败",
      });
    }
  }

  private handlePlanStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (status === "running") {
      const measureCount = Array.isArray(call.args.measure_ids)
        ? call.args.measure_ids.length
        : 0;
      const dimensionCount = Array.isArray(call.args.dimension_property_ids)
        ? call.args.dimension_property_ids.length
        : 0;
      const filterCount = Array.isArray(call.args.filters)
        ? call.args.filters.length
        : 0;
      this.update(
        "understanding",
        "completed",
        {
          summary: `${measureCount} 个指标、${dimensionCount} 个维度、${filterCount} 个筛选条件`,
          facts: [
            { label: "指标", value: String(measureCount), source: "Montane 结构化意图" },
            { label: "维度", value: String(dimensionCount), source: "Montane 结构化意图" },
            { label: "筛选", value: String(filterCount), source: "Montane 结构化意图" },
            {
              label: "时间",
              value: String(
                (call.args.time_range as Record<string, unknown> | undefined)
                  ?.expression ?? "未指定",
              ),
              source: "用户原始表达",
            },
          ],
        },
      );
      this.update("query_plan", "running", {
        summary: "IR规则引擎正在校验本体ID、关系路径、粒度和筛选操作符",
      });
      return;
    }
    if (status === "succeeded") {
      const data = result?.data as
        | {
            ir?: {
              rootObjectId?: string;
              grain?: string;
              relationIds?: string[];
              limit?: number;
            };
            bindings?: Array<{
              label?: string;
              value?: string;
              source?: string;
              entityId?: string;
            }>;
            planSummary?: string;
            sql?: string;
            parameters?: unknown[];
            rowCount?: number;
            columns?: string[];
            truncated?: boolean;
          }
        | undefined;
      const bindings = data?.bindings ?? [];
      this.update("semantic_binding", "completed", {
        summary: bindings.length
          ? `已确定 ${bindings.length} 项本体绑定`
          : "本体绑定已通过规则校验",
        facts: bindings.map((binding) => ({
          label: binding.label || "绑定",
          value: binding.value || "—",
          source: binding.source,
          entityId: binding.entityId,
        })),
      });
      this.update("query_plan", "completed", {
        summary: data?.planSummary || "强类型 IR 已通过规则校验",
        facts: [
          {
            label: "分析粒度",
            value: data?.ir?.grain || "—",
            source: "IR规则引擎",
          },
          {
            label: "关系路径",
            value: data?.ir?.relationIds?.length
              ? `${data.ir.relationIds.length} 条关系`
              : "单一对象",
            source: "本体关系图",
          },
          {
            label: "结果上限",
            value: `${data?.ir?.limit ?? "—"} 行`,
            source: "查询策略",
          },
        ],
        code: data?.ir
          ? { language: "json", content: JSON.stringify(data.ir, null, 2) }
          : undefined,
      });
      this.update("sql", "completed", {
        summary: "Doris SQL 已由IR编译器生成并通过只读校验",
        facts: [{
          label: "参数",
          value: `${data?.parameters?.length ?? 0} 个`,
          source: "参数化查询",
        }],
        code: data?.sql
          ? {
              language: "sql",
              content: `${data.sql}\n\n-- 参数：${JSON.stringify(data.parameters ?? [])}`,
            }
          : undefined,
      });
      this.update("execution", "completed", {
        summary: `SelectDB 返回 ${Number(data?.rowCount ?? 0)} 行`,
        facts: [
          {
            label: "返回行数",
            value: String(data?.rowCount ?? 0),
            source: "SelectDB",
          },
          {
            label: "字段",
            value: data?.columns?.join("、") || "—",
            source: "真实结果集",
          },
          {
            label: "截断",
            value: data?.truncated ? "是" : "否",
            source: "结果限制",
          },
        ],
      });
      return;
    }
    if (isFailure(status)) {
      const data = result?.data as
        | {
            stage?: string;
            ir?: {
              grain?: string;
              relationIds?: string[];
              limit?: number;
            };
            bindings?: Array<{
              label?: string;
              value?: string;
              source?: string;
              entityId?: string;
            }>;
            planSummary?: string;
            sql?: string;
            parameters?: unknown[];
            intent?: Record<string, unknown>;
            retryInstruction?: string;
            availableMetrics?: Array<{
              id?: string;
              label?: string;
              sourcePropertyId?: string;
            }>;
          }
        | undefined;
      if (data?.stage === "execution" && data.sql) {
        this.update("semantic_binding", "completed", {
          summary: `已确定 ${data.bindings?.length ?? 0} 项本体绑定`,
          facts: (data.bindings ?? []).map((binding) => ({
            label: binding.label || "绑定",
            value: binding.value || "—",
            source: binding.source,
            entityId: binding.entityId,
          })),
        });
        this.update("query_plan", "completed", {
          summary: data.planSummary || "强类型 IR 已通过规则校验",
          facts: [{
            label: "分析粒度",
            value: data.ir?.grain || "—",
            source: "IR规则引擎",
          }],
          code: data.ir
            ? { language: "json", content: JSON.stringify(data.ir, null, 2) }
            : undefined,
        });
        this.update("sql", "completed", {
          summary: "Doris SQL 已编译，SelectDB执行阶段发生错误",
          code: {
            language: "sql",
            content: `${data.sql}\n\n-- 参数：${JSON.stringify(data.parameters ?? [])}`,
          },
        });
        this.update("execution", "failed", {
          summary: result?.content || "SelectDB执行失败",
        });
        return;
      }
      this.update(
        "query_plan",
        "failed",
        {
          summary: result?.content?.split("\n")[0] || "分析计划执行失败",
          detail: data?.retryInstruction,
          facts: [
            ...(data?.availableMetrics ?? []).slice(0, 8).map((metric) => ({
              label: "可用指标",
              value: metric.label || "—",
              source: metric.id,
              entityId: metric.id,
            })),
          ],
          code: data?.intent
            ? {
                language: "json",
                content: JSON.stringify(data.intent, null, 2),
              }
            : undefined,
        },
      );
    }
  }
}

function isFailure(status: ToolStatus): boolean {
  return ["failed", "rejected", "denied"].includes(status);
}

function completeUnusedTrace(
  turn: Turn,
  responseKind: NonNullable<Turn["responseKind"]>,
): void {
  const now = new Date().toISOString();
  const skippedSummary =
    responseKind === "conversation"
      ? "本轮为一般对话，无需执行数据分析步骤"
      : responseKind === "configuration_required"
        ? "真实分析运行条件未就绪，本步骤未执行"
        : "需要补充分析条件，本步骤未执行";

  turn.trace = turn.trace.map((step) => {
    if (step.status === "completed" || step.status === "failed") return step;
    return {
      ...step,
      status: "skipped",
      summary: skippedSummary,
      completedAt: now,
    };
  });
}
