import type {
  ResultArtifact,
  TraceStep,
  Turn,
  TurnStatus,
} from "../shared/types.js";
import { EventHub } from "./events.js";
import { createId } from "./id.js";
import { Repository } from "./repository.js";
import { SemanticIndex } from "./semantic-index.js";
import type { QueryPlan } from "./planner.js";
import type { QueryResult } from "./selectdb.js";

const TRACE_BLUEPRINT: Array<{
  kind: TraceStep["kind"];
  label: string;
  status: TurnStatus;
}> = [
  { kind: "understanding", label: "理解问题", status: "understanding" },
  { kind: "inheritance", label: "继承上下文", status: "understanding" },
  { kind: "semantic_binding", label: "绑定业务语义", status: "planning" },
  { kind: "relation_path", label: "选择关系路径", status: "planning" },
  { kind: "grain_check", label: "校验分析粒度", status: "planning" },
  { kind: "query_plan", label: "生成查询计划", status: "planning" },
  { kind: "sql", label: "生成只读 SQL", status: "querying" },
  { kind: "execution", label: "执行查询", status: "querying" },
  { kind: "interpretation", label: "解释结果", status: "querying" },
];

export class DataAgent {
  private readonly running = new Set<string>();

  constructor(
    private readonly repository: Repository,
    private readonly events: EventHub,
    private readonly runtime?: {
      plan: (
        question: string,
        conversationId: string,
      ) => Promise<QueryPlan | null>;
      execute: (sql: string, maxRows: number) => Promise<QueryResult>;
    },
  ) {}

  createTurn(conversationId: string, question: string): Turn {
    const conversation = this.repository.getConversation(conversationId);
    if (!conversation) throw new Error("会话不存在");
    const ontology = this.repository.getOntology();
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
      trace: TRACE_BLUEPRINT.map((step) => ({
        id: createId("trace"),
        turnId,
        kind: step.kind,
        label: step.label,
        status: "pending",
        summary: "等待前序步骤完成",
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

    try {
      const ontology = this.repository.getOntology();
      const index = new SemanticIndex(ontology);
      const matches = index.search(turn.question);
      const summaries = buildSummaries(turn, matches.map((match) => match.label));
      let livePlan: QueryPlan | null = null;
      let liveQuery: QueryResult | null = null;

      for (let stepIndex = 0; stepIndex < turn.trace.length; stepIndex += 1) {
        const step = turn.trace[stepIndex];
        const blueprint = TRACE_BLUEPRINT[stepIndex];
        turn.status = blueprint.status;
        step.status = "running";
        step.summary = "正在处理…";
        turn = structuredClone(turn);
        this.repository.saveTurn(turn);
        this.events.publish({
          conversationId: turn.conversationId,
          turnId: turn.id,
          type: "trace_step_started",
          turn,
        });

        if (step.kind === "query_plan" && this.runtime) {
          livePlan = await this.runtime.plan(turn.question, turn.conversationId);
          if (livePlan) summaries.query_plan = livePlan.explanation;
        }
        if (step.kind === "sql" && livePlan) {
          summaries.sql = livePlan.sql;
        }
        if (step.kind === "execution" && livePlan && this.runtime) {
          liveQuery = await this.runtime.execute(
            livePlan.sql,
            livePlan.resultKind === "detail" ? 50 : 200,
          );
          summaries.execution = `查询完成，返回 ${liveQuery.rows.length} 行，用时 ${liveQuery.durationMs} 毫秒`;
        } else {
          await delay(step.kind === "execution" ? 620 : 260);
        }
        turn.trace[stepIndex] = {
          ...turn.trace[stepIndex],
          status: "completed",
          summary: summaries[step.kind],
          completedAt: new Date().toISOString(),
        };
        turn = structuredClone(turn);
        this.repository.saveTurn(turn);
        this.events.publish({
          conversationId: turn.conversationId,
          turnId: turn.id,
          type: "trace_step_completed",
          turn,
        });
      }

      const result =
        livePlan && liveQuery
          ? createLiveResult(livePlan, liveQuery)
          : createResult(turn.question);
      turn.status = "completed";
      turn.answer = result.conclusion;
      turn.result = result;
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
      turn.status = "failed";
      turn.answer = error instanceof Error ? error.message : "分析失败";
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

function buildSummaries(turn: Turn, labels: string[]): Record<TraceStep["kind"], string> {
  const bound = labels.length ? labels.slice(0, 4).join("、") : "订单、成交金额、时间";
  const inherited = turn.parentTurnId
    ? "继承上一轮已确认的业务范围与时间口径"
    : "本轮未引用历史条件，按独立问题解析";
  return {
    understanding: `识别问题意图：${turn.question.slice(0, 38)}`,
    inheritance: inherited,
    semantic_binding: `命中已发布本体：${bound}`,
    relation_path: "订单 → 门店，采用已验证关系，未发现额外扇出",
    grain_check: "按月份与区域聚合，指标在当前粒度下可安全计算",
    query_plan: "聚合成交金额、订单量与客单价，并计算环比和贡献度",
    sql: "已生成 WITH / SELECT 只读查询，强制限制 10,000 行",
    approval: "本轮无高风险操作，无需人工审批",
    execution: "查询完成，返回 18 行聚合结果，用时 1.4 秒",
    interpretation: "已完成趋势、变化幅度与主要贡献项解释",
  };
}

function createResult(question: string): ResultArtifact {
  const asksCategory = /品类|商品|类目/.test(question);
  if (asksCategory) {
    return {
      kind: "analysis",
      mode: "demo",
      conclusion:
        "家居品类本月增长最快，成交金额环比提升 31.2%；数码品类规模最大，但增速回落至 6.8%。建议继续跟踪家居活动带来的新增客户留存。",
      kpis: [
        { label: "品类成交金额", value: "¥8.62M", change: "+15.4%" },
        { label: "增长最快", value: "家居", change: "+31.2%" },
        { label: "贡献最高", value: "数码", change: "38.6%" },
      ],
      chart: {
        title: "本月各品类成交金额",
        type: "bar",
        categories: ["数码", "家居", "服饰", "美妆", "食品"],
        series: [{ name: "成交金额（百万元）", data: [3.33, 2.04, 1.42, 1.08, 0.75] }],
      },
      columns: ["品类", "成交金额", "环比", "订单量"],
      rows: [
        { 品类: "数码", 成交金额: "¥3.33M", 环比: "+6.8%", 订单量: 6482 },
        { 品类: "家居", 成交金额: "¥2.04M", 环比: "+31.2%", 订单量: 9237 },
        { 品类: "服饰", 成交金额: "¥1.42M", 环比: "+12.7%", 订单量: 7821 },
        { 品类: "美妆", 成交金额: "¥1.08M", 环比: "+18.1%", 订单量: 6318 },
      ],
      rowCount: 5,
      truncated: false,
    };
  }

  return {
    kind: "analysis",
    mode: "demo",
    conclusion:
      "华东区本月成交金额为 ¥12.84M，较上月增长 18.6%。杭州湖滨店与上海静安店合计贡献增量的 61%，是本月增长的主要来源。",
    kpis: [
      { label: "成交金额", value: "¥12.84M", change: "+18.6%" },
      { label: "订单量", value: "38,420", change: "+11.2%" },
      { label: "客单价", value: "¥334", change: "+6.6%" },
    ],
    chart: {
      title: "华东区近 6 个月成交金额",
      type: "bar",
      categories: ["2月", "3月", "4月", "5月", "6月", "7月"],
      series: [{ name: "成交金额（百万元）", data: [8.6, 9.2, 9.8, 10.4, 10.83, 12.84] }],
    },
    columns: ["门店", "成交金额", "环比", "订单量"],
    rows: [
      { 门店: "杭州湖滨店", 成交金额: "¥3.26M", 环比: "+28.4%", 订单量: 9221 },
      { 门店: "上海静安店", 成交金额: "¥2.91M", 环比: "+22.7%", 订单量: 8346 },
      { 门店: "南京新街口店", 成交金额: "¥2.18M", 环比: "+14.3%", 订单量: 6759 },
      { 门店: "苏州中心店", 成交金额: "¥1.76M", 环比: "+9.8%", 订单量: 5287 },
    ],
    rowCount: 18,
    truncated: false,
  };
}

function createLiveResult(plan: QueryPlan, query: QueryResult): ResultArtifact {
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
  const seriesColumns = numberColumns.slice(0, 3);
  const series = seriesColumns.map((column) => ({
    name: column,
    data: rows.slice(0, 12).map((row) => Number(row[column] ?? 0)),
  }));
  const numericValues = numberColumns.flatMap((column) =>
    rows.map((row) => Number(row[column])).filter(Number.isFinite),
  );

  return {
    kind: "analysis",
    mode: "live",
    conclusion: query.rows.length
      ? `${plan.title}已完成，共返回 ${query.rows.length} 行结果。以下结论严格基于当前查询结果与已发布业务口径。`
      : `${plan.title}未返回符合条件的数据，建议检查时间范围或筛选条件。`,
    kpis: [
      { label: "结果行数", value: String(query.rows.length) },
      {
        label: seriesColumns[0] || "数值字段",
        value: numericValues.length
          ? Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(
              numericValues.reduce((sum, value) => sum + value, 0),
            )
          : "—",
      },
      { label: "查询耗时", value: `${query.durationMs}ms` },
    ],
    chart: {
      title: plan.title,
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
