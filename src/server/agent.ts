import type {
  AgentReporter,
  ToolCall,
  ToolOutcome,
  ToolStatus,
} from "montane-code";
import type { TraceStep, Turn, TurnStatus } from "../shared/types.js";
import { EventHub } from "./events.js";
import { DataAgentHarness } from "./harness.js";
import { createId } from "./id.js";
import { Repository } from "./repository.js";

const TRACE_BLUEPRINT: Array<{
  kind: TraceStep["kind"];
  label: string;
}> = [
  { kind: "understanding", label: "理解问题" },
  { kind: "inheritance", label: "继承上下文" },
  { kind: "semantic_binding", label: "检索业务本体" },
  { kind: "relation_path", label: "解析关系路径" },
  { kind: "grain_check", label: "校验分析粒度" },
  { kind: "query_plan", label: "Harness 查询规划" },
  { kind: "sql", label: "生成只读 SQL" },
  { kind: "execution", label: "执行 SelectDB 工具" },
  { kind: "interpretation", label: "解释结果" },
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
      summary: string,
      detail?: string,
    ) => {
      const index = turn.trace.findIndex((step) => step.kind === kind);
      if (index < 0) return;
      const current = turn.trace[index]!;
      turn.trace[index] = {
        ...current,
        status,
        summary,
        detail,
        completedAt:
          status === "completed" || status === "failed"
            ? new Date().toISOString()
            : undefined,
      };
      persist(status === "running" ? "trace_step_started" : "trace_step_completed");
    };

    try {
      updateStep(
        "understanding",
        "completed",
        `问题已提交 Montane AgentLoop：${turn.question.slice(0, 42)}`,
      );
      updateStep(
        "inheritance",
        "completed",
        turn.parentTurnId
          ? "SessionStore 已加载同一会话的历史事件"
          : "SessionManager 已创建新的 Harness 会话",
      );
      turn.status = "planning";
      updateStep(
        "query_plan",
        "running",
        "AgentLoop 正在选择受控工具并生成执行计划",
      );

      const conversation = this.repository.getConversation(turn.conversationId);
      if (!conversation) throw new Error("会话不存在");
      const reporter = new HarnessTurnReporter(
        (kind, status, summary, detail) => {
          if (kind === "execution" && status === "running") turn.status = "querying";
          updateStep(kind, status, summary, detail);
        },
      );
      const output = await this.harness.run(conversation, turn, reporter);
      turn.status = "completed";
      turn.answer = output.answer;
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
      if (running) updateStep(running.kind, "failed", message);
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

class HarnessTurnReporter implements AgentReporter {
  private receivedText = false;

  constructor(
    private readonly update: (
      kind: TraceStep["kind"],
      status: TraceStep["status"],
      summary: string,
      detail?: string,
    ) => void,
  ) {}

  onTextDelta(_delta: string): void {
    if (this.receivedText) return;
    this.receivedText = true;
    this.update(
      "interpretation",
      "running",
      "AgentLoop 正在基于工具结果生成最终解释",
    );
  }

  onTextEnd(): void {
    if (!this.receivedText) return;
    this.receivedText = false;
    this.update(
      "interpretation",
      "completed",
      "最终结论已写入 Harness SessionStore",
    );
  }

  onToolStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    if (call.name === "OntologySearch") {
      this.handleOntologyStatus(status, result);
      return;
    }
    if (call.name === "SelectDBQuery") {
      this.handleQueryStatus(call, status, result);
    }
  }

  private handleOntologyStatus(status: ToolStatus, result?: ToolOutcome): void {
    if (status === "running") {
      this.update(
        "query_plan",
        "completed",
        "AgentLoop 已选择 OntologySearch 只读工具",
      );
      this.update(
        "semantic_binding",
        "running",
        "OntologySearch 正在检索已发布语义索引",
      );
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
      const labels =
        data?.matches?.map((match) => match.label).filter(Boolean).slice(0, 5) ?? [];
      const relations = data?.relations ?? [];
      this.update(
        "semantic_binding",
        "completed",
        labels.length ? `命中业务语义：${labels.join("、")}` : "完成本体检索",
      );
      this.update(
        "relation_path",
        "completed",
        relations.length
          ? `解析 ${relations.length} 条候选关系：${relations
              .slice(0, 2)
              .map((relation) => relation.name)
              .join("、")}`
          : "当前问题可在单一对象内完成",
      );
      this.update(
        "grain_check",
        "completed",
        relations.some((relation) => relation.fanoutRisk === "HIGH")
          ? "发现高扇出关系，Harness 将按去重口径生成查询"
          : "关系基数与聚合粒度检查通过",
      );
      return;
    }
    if (isFailure(status)) {
      this.update(
        "semantic_binding",
        "failed",
        result?.content || "OntologySearch 执行失败",
      );
    }
  }

  private handleQueryStatus(
    call: ToolCall,
    status: ToolStatus,
    result?: ToolOutcome,
  ): void {
    const sql = String(call.args.sql ?? "");
    if (status === "running") {
      this.update(
        "sql",
        "completed",
        "SQL 已通过 Harness 工具参数校验和只读安全检查",
        sql,
      );
      this.update(
        "execution",
        "running",
        "SelectDBQuery 正在执行受控查询",
      );
      return;
    }
    if (status === "succeeded") {
      const rowCount = Number(result?.data?.rowCount ?? 0);
      const mode = result?.data?.mode === "live" ? "真实查询" : "示例查询";
      this.update(
        "execution",
        "completed",
        `${mode}完成，返回 ${rowCount} 行`,
      );
      return;
    }
    if (isFailure(status)) {
      this.update(
        "execution",
        "failed",
        result?.content || "SelectDBQuery 执行失败",
      );
    }
  }
}

function isFailure(status: ToolStatus): boolean {
  return ["failed", "rejected", "denied"].includes(status);
}
