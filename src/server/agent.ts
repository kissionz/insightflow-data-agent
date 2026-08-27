import type {
  AgentReporter,
  ToolCall,
  ToolOutcome,
  ToolStatus,
} from "montane-code";
import type {
  AnalysisAcceptanceContract,
  DiagnosticCandidate,
  DiagnosticEvaluation,
  AnalysisRun,
  AnalysisRunStep,
  TraceStep,
  Turn,
} from "../shared/types.js";
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
        (analysisRun) => {
          turn.analysisRun = structuredClone(analysisRun);
          persist("turn_updated");
        },
      );
      const output = await this.harness.run(conversation, turn, reporter);
      if (turn.analysisRun) {
        if (output.acceptanceContract) {
          turn.analysisRun.acceptance = output.acceptanceContract;
        }
        turn.analysisRun.status =
          output.responseKind === "analysis"
            ? "completed"
            : output.acceptanceContract?.status === "PARTIAL_BUDGET"
              ? "partial_budget"
              : output.responseKind === "partial_analysis"
                ? "partial_no_progress"
                : "failed";
      }
      completeUnusedTrace(turn, output.responseKind);
      turn.status =
        output.responseKind === "configuration_required" ||
        output.responseKind === "clarification"
          ? "needs_clarification"
          : output.responseKind === "partial_analysis"
            ? "partial"
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
      if (turn.analysisRun) turn.analysisRun.status = "failed";
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
  private ontologyDiagnostics: unknown;
  private hasResolvedValueBinding = false;
  private analysisRun?: AnalysisRun;
  private readonly analysisSpaces = new Map<
    string,
    {
      label: string;
      metrics: AnalysisRun["availableMetrics"];
      dimensions: AnalysisRun["availableDimensions"];
    }
  >();

  constructor(
    private readonly update: (
      kind: TraceStep["kind"],
      status: TraceStep["status"],
      patch: Pick<TraceStep, "summary"> &
        Partial<Pick<TraceStep, "detail" | "facts" | "code">>,
    ) => void,
    private readonly publishAnalysisRun: (run: AnalysisRun) => void = () => {},
  ) {}

  onTextDelta(_delta: string): void {}

  onTextEnd(): void {}

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (call.name === "SubmitQuestionFrame") {
      this.handleQuestionFrameStatus(status, result);
      return;
    }
    if (call.name === "OntologySearch") {
      this.handleOntologyStatus(status, result);
      return;
    }
    if (call.name === "DiscoverAnalysisSpace") {
      this.handleAnalysisSpaceStatus(status, result);
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

  private handleQuestionFrameStatus(
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (status === "running") {
      this.update("understanding", "running", {
        summary: "正在把原问题切分为可校验的业务语言角色",
      });
      return;
    }
    if (status === "succeeded") {
      const data = result?.data as
        | {
            frame?: {
              originalQuestion?: string;
              intentKind?: string;
              metricTerms?: string[];
              timeTerms?: string[];
              timeRange?: { kind?: string; originalText?: string };
              timeGrain?: string;
              objectTerms?: string[];
              businessValueTerms?: string[];
              groupingTerms?: string[];
              calculationTerms?: string[];
              presentation?: { kind?: string };
            };
            acceptanceContract?: AnalysisAcceptanceContract;
          }
        | undefined;
      const frame = data?.frame;
      const facts = [
        [
          "分析类型",
          frame?.intentKind
            ? [analysisIntentKindLabel(frame.intentKind)]
            : [],
        ],
        ["指标", frame?.metricTerms],
        ["时间原文", frame?.timeTerms],
        [
          "时间范围",
          frame?.timeRange?.kind
            ? [`${frame.timeRange.kind}${frame.timeRange.originalText ? `（${frame.timeRange.originalText}）` : ""}`]
            : [],
        ],
        ["时间粒度", frame?.timeGrain ? [frame.timeGrain] : []],
        ["对象词（待绑定）", frame?.objectTerms],
        ["业务值", frame?.businessValueTerms],
        ["分组", frame?.groupingTerms],
        ["计算方式", frame?.calculationTerms],
        ["展现形式", frame?.presentation?.kind ? [frame.presentation.kind] : []],
        [
          "验收标准",
          data?.acceptanceContract?.criteria
            .filter((criterion) => criterion.required)
            .map((criterion) => criterion.label),
        ],
      ] as const;
      this.update("understanding", "completed", {
        summary: "问题语言框架已确认，开始进行本体和值证据绑定",
        facts: facts
          .filter(([, values]) => values?.length)
          .map(([label, values]) => ({
            label,
            value: values!.join("、"),
            source: "Montane 结构化理解",
          })),
      });
      if (frame?.intentKind && data?.acceptanceContract) {
        this.analysisRun = {
          mode: frame.intentKind as AnalysisRun["mode"],
          objective: frame.originalQuestion ?? "数据分析",
          status: "planning",
          maxSteps: data.acceptanceContract.maxSuccessfulQueries,
          acceptance: data.acceptanceContract,
          availableMetrics: [],
          availableDimensions: [],
          steps: [],
        };
        this.publishAnalysisRun(this.analysisRun);
      }
      return;
    }
    if (isFailure(status)) {
      this.update("understanding", "failed", {
        summary: result?.content || "问题语言框架提交失败",
      });
    }
  }

  private handleAnalysisSpaceStatus(
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (status === "running") {
      this.update("query_plan", "running", {
        summary: "正在读取候选事实对象的指标、时间字段和诊断维度",
      });
      return;
    }
    if (status === "succeeded") {
      const data = result?.data as
        | {
            spaces?: Array<{
              object?: { id?: string; label?: string };
              metrics?: Array<{ id?: string; label?: string }>;
              dimensions?: Array<{
                id?: string;
                label?: string;
                objectLabel?: string;
              }>;
            }>;
            limits?: { maxSuccessfulQueries?: number };
            acceptanceContract?: AnalysisAcceptanceContract;
            diagnosticCandidates?: DiagnosticCandidate[];
          }
        | undefined;
      const space = data?.spaces?.[0];
      this.analysisSpaces.clear();
      for (const candidate of data?.spaces ?? []) {
        if (!candidate.object?.id || !candidate.object.label) continue;
        this.analysisSpaces.set(candidate.object.id, {
          label: candidate.object.label,
          metrics: (candidate.metrics ?? []).flatMap((metric) =>
            metric.id && metric.label
              ? [{ id: metric.id, label: metric.label }]
              : [],
          ),
          dimensions: (candidate.dimensions ?? []).flatMap((dimension) =>
            dimension.id && dimension.label
              ? [{
                  id: dimension.id,
                  label: dimension.label,
                  objectLabel: dimension.objectLabel ?? "当前对象",
                }]
              : [],
          ),
        });
      }
      if (this.analysisRun) {
        const selectedSpace = space?.object?.id
          ? this.analysisSpaces.get(space.object.id)
          : undefined;
        this.analysisRun = {
          ...this.analysisRun,
          status: "running",
          maxSteps:
            data?.limits?.maxSuccessfulQueries ?? this.analysisRun.maxSteps,
          acceptance:
            data?.acceptanceContract ?? this.analysisRun.acceptance,
          rootObjectId: space?.object?.id,
          rootObjectLabel: space?.object?.label,
          availableMetrics: selectedSpace?.metrics ?? [],
          availableDimensions: selectedSpace?.dimensions ?? [],
          diagnosticCandidates:
            data?.diagnosticCandidates ?? this.analysisRun.diagnosticCandidates,
        };
        this.publishAnalysisRun(this.analysisRun);
      }
      this.update("query_plan", "completed", {
        summary: space?.object?.label
          ? `已选择 ${space.object.label} 作为单一事实对象，Montane 将根据真实结果动态推进`
          : "未找到可用于开放分析的事实对象",
        facts: [
          {
            label: "事实对象",
            value: space?.object?.label ?? "未确定",
            source: "已发布本体",
            entityId: space?.object?.id,
          },
          {
            label: "可用指标",
            value: String(space?.metrics?.length ?? 0),
            source: "分析空间",
          },
          {
            label: "诊断维度",
            value: String(space?.dimensions?.length ?? 0),
            source: "分析空间",
          },
          {
            label: "验收进度",
            value: `${data?.acceptanceContract?.criteria.filter((criterion) =>
              ["SATISFIED", "NOT_APPLICABLE"].includes(criterion.status)
            ).length ?? 0}/${data?.acceptanceContract?.criteria.length ?? 0}`,
            source: "验收契约",
          },
        ],
      });
      return;
    }
    if (isFailure(status)) {
      this.update("query_plan", "failed", {
        summary: result?.content || "分析空间发现失败",
      });
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
            unpublishedMetricLabels?: string[];
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
      const unpublishedMetricLabels = data?.unpublishedMetricLabels ?? [];
      this.ontologyDiagnostics = {
        candidates: matches,
        relations,
        unpublishedMetricLabels,
      };
      this.update(
        "semantic_binding",
        "completed",
        {
          summary: unpublishedMetricLabels.length
            ? `指标 ${unpublishedMetricLabels.join("、")} 尚未发布，本轮只能使用当前发布版本`
            : labels.length
              ? `候选语义：${labels.join("、")}`
              : "未命中可用本体语义",
          detail: [
            relations.length
              ? `发现 ${relations.length} 条候选对象关系。`
              : "",
            "词形候选不代表属性值归属，具体值仍由全局值索引验证。",
            unpublishedMetricLabels.length
              ? "请先校验并发布本体草稿，再重新问数；系统不会读取未发布指标。"
              : "",
          ].filter(Boolean).join(""),
          code: {
            language: "json",
            content: JSON.stringify(
              {
                kind: "candidate_diagnostics",
                ontology: this.ontologyDiagnostics,
              },
              null,
              2,
            ),
          },
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
              selectionStatus?: string;
              valueBindingId?: string;
              rejectionReason?: string;
            }>;
          }
        | undefined;
      const matches = data?.matches ?? [];
      if (matches.some((match) => match.selectionStatus === "selected")) {
        this.hasResolvedValueBinding = true;
      }
      this.update("semantic_binding", "completed", {
        summary: matches.length
          ? `属性值已定位：${matches
              .slice(0, 3)
              .map((match) => `${match.property} = ${match.matchedValue}`)
              .join("、")}`
          : "属性值索引未找到可靠绑定",
        facts: matches
          .filter((match) => match.selectionStatus === "selected")
          .map((match) => ({
            label:
              [match.object, match.property].filter(Boolean).join(" · ") ||
              "属性值",
            value: match.matchedValue || "—",
            source: [
              match.source === "published-index"
                ? `全局发布值索引${match.matchType === "prefix" ? "前缀" : "精确"}命中`
                : match.source === "local-cache"
                  ? "查询缓存命中"
                  : "SelectDB 定向验证",
              match.frequency ? `频次 ${match.frequency}` : "",
              match.rankingReason || "",
            ]
              .filter(Boolean)
              .join(" · "),
            entityId: match.propertyId,
          })),
        code: {
          language: "json",
          content: JSON.stringify(
            {
              kind: "candidate_diagnostics",
              ontology: this.ontologyDiagnostics,
              valueCandidates: matches,
            },
            null,
            2,
          ),
        },
      });
      return;
    }
    if (isFailure(status)) {
      if (this.hasResolvedValueBinding) {
        this.update("semantic_binding", "completed", {
          summary: "属性值已成功定位；后续重复调用未改变既有绑定",
          detail:
            result?.content || "后续属性值检索调用失败，保留此前已确认的值绑定。",
        });
        return;
      }
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
      this.startAnalysisStep(call);
      const measureCount = Array.isArray(call.args.measure_ids)
        ? call.args.measure_ids.length
        : Array.isArray(call.args.measure_refs)
          ? call.args.measure_refs.length
          : 0;
      const dimensionCount = Array.isArray(call.args.dimension_property_ids)
        ? call.args.dimension_property_ids.length
        : Array.isArray(call.args.dimension_refs)
          ? call.args.dimension_refs.length
          : 0;
      const filterCount = Array.isArray(call.args.filters)
        ? call.args.filters.length
        : 0;
      const calculationCount = [
        call.args.derived_calculations,
        call.args.time_comparisons,
        call.args.window_calculations,
      ].filter(Array.isArray).flat().length;
      this.update(
        "understanding",
        "completed",
        {
          summary: `${measureCount} 个指标、${dimensionCount} 个维度、${filterCount} 个筛选条件、${calculationCount} 个计算`,
          facts: [
            { label: "指标", value: String(measureCount), source: "Montane 结构化意图" },
            { label: "维度", value: String(dimensionCount), source: "Montane 结构化意图" },
            { label: "筛选", value: String(filterCount), source: "Montane 结构化意图" },
            {
              label: "计算",
              value: String(calculationCount),
              source: "Montane 强类型计算",
            },
            {
              label: "时间",
              value: String(
                (call.args.time_range as Record<string, unknown> | undefined)
                  ?.expression ?? "未指定",
              ),
              source: "用户原始表达",
            },
            {
              label: "时间粒度",
              value: String(
                (call.args.time_grain as Record<string, unknown> | undefined)
                  ?.unit ?? "未指定",
              ),
              source: "Montane 结构化意图",
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
              derivedMeasures?: unknown[];
              timeComparisons?: unknown[];
              windowCalculations?: unknown[];
              groupSelections?: unknown[];
              periodConditions?: unknown[];
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
            verification?: {
              exhaustive?: boolean;
              calculationSource?: string;
            };
            rows?: Array<Record<string, string | number>>;
            analysisStep?: {
              id?: string;
              objective?: string;
              rationale?: string;
              role?: AnalysisRunStep["role"];
            };
            observation?: Record<string, unknown>;
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
          {
            label: "受控计算",
            value: String(
              (data?.ir?.derivedMeasures?.length ?? 0) +
                (data?.ir?.timeComparisons?.length ?? 0) +
                (data?.ir?.windowCalculations?.length ?? 0) +
                (data?.ir?.groupSelections?.length ?? 0) +
                (data?.ir?.periodConditions?.length ?? 0),
            ),
            source: "IR v3",
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
          {
            label: "结果完整性",
            value: data?.verification?.exhaustive
              ? "完整集合"
              : data?.truncated
                ? "结果可能不完整"
                : "当前查询结果完整",
            source: "IR v3 结果契约",
          },
          {
            label: "计算来源",
            value: data?.verification?.calculationSource ?? "DORIS_SQL",
            source: "证据链",
          },
        ],
      });
      this.finishAnalysisStep(call, "completed", result);
      return;
    }
    if (isFailure(status)) {
      this.finishAnalysisStep(call, "failed", result);
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

  private startAnalysisStep(call: ToolCall): void {
    if (!this.analysisRun) return;
    const raw = call.args.analysis_step as Record<string, unknown> | undefined;
    const step: AnalysisRunStep = {
      id: String(raw?.id ?? call.id),
      callId: call.id,
      sequence: this.analysisRun.steps.length + 1,
      title: String(call.args.title ?? `分析步骤 ${this.analysisRun.steps.length + 1}`),
      objective: String(raw?.objective ?? call.args.title ?? "执行受控查询"),
      rationale: raw?.rationale ? String(raw.rationale) : undefined,
      role: ["DIAGNOSTIC", "SUPPORTING"].includes(String(raw?.role))
        ? String(raw?.role) as AnalysisRunStep["role"]
        : "OVERVIEW",
      acceptanceCriterionIds: Array.isArray(raw?.acceptance_criterion_ids)
        ? raw.acceptance_criterion_ids.map(String)
        : undefined,
      status: "running",
      summary: "IR 正在校验并执行",
      startedAt: new Date().toISOString(),
    };
    this.analysisRun = {
      ...this.analysisRun,
      status: "running",
      steps: [...this.analysisRun.steps, step],
    };
    this.publishAnalysisRun(this.analysisRun);
  }

  private finishAnalysisStep(
    call: ToolCall,
    status: "completed" | "failed",
    result?: ToolOutcome,
  ): void {
    if (!this.analysisRun) return;
    const data = (result?.data ?? {}) as {
      ir?: AnalysisRunStep["ir"] & { rootObjectId?: string };
      sql?: string;
      parameters?: unknown[];
      columns?: string[];
      rows?: Array<Record<string, string | number>>;
      rowCount?: number;
      truncated?: boolean;
      observation?: Record<string, unknown>;
      analysisStep?: {
        id?: string;
        objective?: string;
        rationale?: string;
        role?: AnalysisRunStep["role"];
        acceptanceCriterionIds?: string[];
      };
      diagnosticEvaluation?: DiagnosticEvaluation;
      diagnosticCandidates?: DiagnosticCandidate[];
      acceptanceContract?: AnalysisAcceptanceContract;
    };
    const executedSpace = data.ir?.rootObjectId
      ? this.analysisSpaces.get(data.ir.rootObjectId)
      : undefined;
    this.analysisRun = {
      ...this.analysisRun,
      rootObjectId: data.ir?.rootObjectId ?? this.analysisRun.rootObjectId,
      rootObjectLabel:
        executedSpace?.label ?? this.analysisRun.rootObjectLabel,
      availableMetrics:
        executedSpace?.metrics ?? this.analysisRun.availableMetrics,
      availableDimensions:
        executedSpace?.dimensions ?? this.analysisRun.availableDimensions,
      acceptance:
        data.acceptanceContract ?? this.analysisRun.acceptance,
      diagnosticCandidates:
        data.diagnosticCandidates ?? this.analysisRun.diagnosticCandidates,
      steps: this.analysisRun.steps.map((step) =>
        step.callId === call.id
          ? {
              ...step,
              status,
              summary:
                status === "completed"
                  ? `返回 ${data.rowCount ?? 0} 行，Montane 正在判断是否需要继续分析`
                  : result?.content?.split("\n")[0] || "本步查询失败",
              ir: data.ir,
              id: data.analysisStep?.id ?? step.id,
              title: data.analysisStep?.objective ?? step.title,
              objective: data.analysisStep?.objective ?? step.objective,
              rationale: data.analysisStep?.rationale ?? step.rationale,
              role: data.analysisStep?.role ?? step.role,
              sql: data.sql,
              parameters: data.parameters,
              columns: data.columns,
              rows: data.rows,
              rowCount: data.rowCount,
              truncated: data.truncated,
              diagnosticEvaluation: data.diagnosticEvaluation,
              acceptanceCriterionIds:
                data.analysisStep?.acceptanceCriterionIds ??
                step.acceptanceCriterionIds,
              error: status === "failed" ? result?.content : undefined,
              completedAt: new Date().toISOString(),
            }
          : step,
      ),
    };
    this.publishAnalysisRun(this.analysisRun);
  }
}

function analysisIntentKindLabel(kind: string): string {
  if (kind === "EXPLORATORY_ANALYSIS") return "开放式分析";
  if (kind === "DIAGNOSTIC_ANALYSIS") return "原因诊断";
  return "明确指标问数";
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
        : responseKind === "analysis"
          ? "验收契约已经满足，本步骤无需继续执行"
          : responseKind === "partial_analysis"
            ? "本轮已停止，仍有验收缺口未覆盖"
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
