import { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  Brain,
  CaretDown,
  CaretRight,
  ChartBar,
  Check,
  CheckCircle,
  CirclesFour,
  Clock,
  Database,
  DotsThreeVertical,
  GearSix,
  GitBranch,
  Info,
  Link as LinkIcon,
  MagnifyingGlass,
  FloppyDisk,
  PencilSimple,
  Plus,
  SealCheck,
  Sparkle,
  Table,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import type {
  BootstrapPayload,
  Conversation,
  DataSourceInput,
  Metric,
  OntologyObject,
  OntologyRelation,
  OntologySnapshot,
  OntologyValidationResult,
  PhysicalTable,
  PropertyValueIndexProperty,
  TraceStep,
  Turn,
} from "../shared/types";
import { api } from "./api";
import type { InsightChartOption } from "./components/ChartView";

const ChartView = lazy(() =>
  import("./components/ChartView").then((module) => ({ default: module.ChartView })),
);

type Page = "chat" | "ontology" | "data" | "audit" | "settings";

const NAV_ITEMS: Array<{
  page: Page;
  label: string;
  icon: typeof ChartBar;
}> = [
  { page: "chat", label: "问数", icon: ChartBar },
  { page: "ontology", label: "本体", icon: CirclesFour },
  { page: "data", label: "数据", icon: Database },
  { page: "audit", label: "审计", icon: BookOpenText },
];

export function App() {
  const [page, setPage] = useState<Page>("chat");
  const [state, setState] = useState<BootstrapPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .bootstrap()
      .then((payload) => {
        setState(payload);
        setSelectedId(payload.conversations[0]?.id ?? "");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    return api.subscribe(selectedId, (event) => {
      if (!event.turn) return;
      setState((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          conversations: previous.conversations.map((conversation) =>
            conversation.id === selectedId
              ? upsertTurn(conversation, event.turn!)
              : conversation,
          ),
        };
      });
    });
  }, [selectedId]);

  const selected =
    state?.conversations.find((conversation) => conversation.id === selectedId) ?? null;

  async function createConversation() {
    try {
      const conversation = await api.createConversation();
      setState((previous) =>
        previous
          ? { ...previous, conversations: [conversation, ...previous.conversations] }
          : previous,
      );
      setSelectedId(conversation.id);
      setPage("chat");
    } catch (reason) {
      setError(asMessage(reason));
    }
  }

  if (loading) return <LoadingScreen />;
  if (!state) return <FatalState message={error || "无法加载应用"} />;

  return (
    <div className="app-shell">
      <GlobalNav page={page} onChange={setPage} />
      {page === "chat" ? (
        <>
          <ConversationRail
            conversations={state.conversations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreate={createConversation}
          />
          <ChatWorkspace
            conversation={selected}
            ontology={state.ontology}
            onTurnCreated={(turn) =>
              setState((previous) =>
                previous
                  ? {
                      ...previous,
                      conversations: previous.conversations.map((conversation) =>
                        conversation.id === turn.conversationId
                          ? upsertTurn(conversation, turn)
                          : conversation,
                      ),
                    }
                  : previous,
              )
            }
            onError={setError}
          />
          <ContextPanel conversation={selected} ontology={state.ontology} />
        </>
      ) : (
        <ManagementWorkspace
          page={page}
          state={state}
          onState={setState}
          onBack={() => setPage("chat")}
          onError={setError}
        />
      )}
      {error && <Toast message={error} onClose={() => setError("")} />}
    </div>
  );
}

function GlobalNav({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  return (
    <nav className="global-nav" aria-label="全局导航">
      <button className="brand-mark" aria-label="InsightFlow 首页" onClick={() => onChange("chat")}>
        <Sparkle weight="fill" size={22} />
      </button>
      <div className="nav-items">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.page}
              className={`nav-item ${page === item.page ? "active" : ""}`}
              onClick={() => onChange(item.page)}
              aria-label={item.label}
              title={item.label}
            >
              <Icon size={22} weight={page === item.page ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <button
        className={`nav-item nav-bottom ${page === "settings" ? "active" : ""}`}
        onClick={() => onChange("settings")}
        aria-label="设置"
      >
        <GearSix size={22} />
        <span>设置</span>
      </button>
    </nav>
  );
}

function ConversationRail({
  conversations,
  selectedId,
  onSelect,
  onCreate,
}: {
  conversations: Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = conversations.filter((item) =>
    item.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <aside className="conversation-rail">
      <div className="product-lockup">
        <div>
          <strong>InsightFlow</strong>
          <span>Data Agent</span>
        </div>
        <span className="version-chip">MVP</span>
      </div>
      <button className="primary-button new-analysis" onClick={onCreate}>
        <Plus size={17} weight="bold" /> 新建分析
      </button>
      <label className="search-field">
        <MagnifyingGlass size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话"
          aria-label="搜索会话"
        />
      </label>
      <div className="rail-section-label">
        <span>最近分析</span>
        <span>{filtered.length}</span>
      </div>
      <div className="conversation-list">
        {filtered.map((conversation) => (
          <button
            key={conversation.id}
            className={`conversation-item ${
              selectedId === conversation.id ? "selected" : ""
            }`}
            onClick={() => onSelect(conversation.id)}
          >
            <span className="conversation-dot" />
            <span className="conversation-copy">
              <strong>{conversation.title}</strong>
              <small>{relativeTime(conversation.updatedAt)}</small>
            </span>
            <DotsThreeVertical size={16} />
          </button>
        ))}
      </div>
      <div className="rail-footer">
        <span className="health-dot" />
        <div>
          <strong>语义服务正常</strong>
          <small>Montane Harness · 本地运行</small>
        </div>
      </div>
    </aside>
  );
}

function ChatWorkspace({
  conversation,
  ontology,
  onTurnCreated,
  onError,
}: {
  conversation: Conversation | null;
  ontology: OntologySnapshot;
  onTurnCreated: (turn: Turn) => void;
  onError: (message: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const isRunning = conversation?.turns.some((turn) => !isTerminal(turn.status)) ?? false;

  async function submit() {
    if (!conversation || !question.trim() || isRunning) return;
    const nextQuestion = question.trim();
    setQuestion("");
    try {
      onTurnCreated(await api.createTurn(conversation.id, nextQuestion));
    } catch (reason) {
      setQuestion(nextQuestion);
      onError(asMessage(reason));
    }
  }

  if (!conversation) {
    return (
      <main className="main-workspace empty-workspace">
        <Sparkle size={28} weight="fill" />
        <h1>开始一次可信分析</h1>
        <p>创建会话后，用自然语言询问业务数据。</p>
      </main>
    );
  }

  return (
    <main className="main-workspace">
      <header className="workspace-header">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            可信问数工作区
          </div>
          <h1>{conversation.title}</h1>
        </div>
        <div className="header-meta">
          <span>
            <SealCheck size={16} weight="fill" />
            本体 v{ontology.version}
          </span>
          <button className="icon-button" aria-label="更多操作">
            <DotsThreeVertical size={20} />
          </button>
        </div>
      </header>
      <section className="turn-stream" aria-live="polite">
        {conversation.turns.length === 0 ? (
          <StarterPrompts onPick={setQuestion} />
        ) : (
          conversation.turns.map((turn) => <TurnCard key={turn.id} turn={turn} />)
        )}
      </section>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              isRunning ? "当前问题分析中，请稍候…" : "基于当前结果继续追问，或开始新的分析…"
            }
            disabled={isRunning}
            aria-label="输入分析问题"
          />
          <div className="composer-footer">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <button
              className="send-button"
              disabled={!question.trim() || isRunning}
              onClick={() => void submit()}
              aria-label="发送问题"
            >
              <ArrowUp size={18} weight="bold" />
            </button>
          </div>
        </div>
        <p className="disclaimer">结果基于已发布业务本体生成，请结合业务判断使用。</p>
      </div>
    </main>
  );
}

function StarterPrompts({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="starter">
      <div className="starter-icon">
        <Brain size={28} weight="duotone" />
      </div>
      <h2>想从业务数据中了解什么？</h2>
      <p>我会展示从语义理解、关系路径到查询执行的完整过程。</p>
      <div className="prompt-grid">
        {[
          "分析华东区本月经营表现，并与上月对比",
          "哪些商品品类增长最快？主要原因是什么？",
          "找出订单量下降但客单价上升的门店",
        ].map((prompt) => (
          <button key={prompt} onClick={() => onPick(prompt)}>
            <Sparkle size={16} />
            <span>{prompt}</span>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

function TurnCard({ turn }: { turn: Turn }) {
  const [traceOpen, setTraceOpen] = useState(!isTerminal(turn.status));
  useEffect(() => {
    setTraceOpen(!isTerminal(turn.status));
  }, [turn.status]);
  const completed = turn.trace.filter((step) => step.status === "completed").length;
  const skipped = turn.trace.filter((step) => step.status === "skipped").length;
  const activeStep = turn.trace.find((step) => step.status === "running");
  const terminal = isTerminal(turn.status);

  return (
    <article className="turn-card">
      <div className="question-row">
        <div className="avatar">你</div>
        <div>
          <span className="message-label">你的问题</span>
          <p>{turn.question}</p>
        </div>
        <time>{formatTime(turn.createdAt)}</time>
      </div>
      <button className="trace-summary" onClick={() => setTraceOpen((value) => !value)}>
        <span
          className={`trace-orb ${
            turn.status === "completed"
              ? "done"
              : turn.status === "failed"
                ? "failed"
                : turn.status === "needs_clarification"
                  ? "waiting"
                  : ""
          }`}
        >
          {turn.status === "completed" ? (
            <Check size={14} weight="bold" />
          ) : turn.status === "needs_clarification" ? (
            <Info size={15} />
          ) : (
            <Brain size={15} />
          )}
        </span>
        <span className="trace-summary-copy">
          <strong>
            {terminal
              ? "分析证据链"
              : activeStep?.label || "正在准备分析"}
          </strong>
          <small>
            {terminal
              ? `${completed} 个完成${skipped ? ` · ${skipped} 个未执行` : ""} · 本体 v${turn.ontologyVersion}`
              : `${activeStep?.summary || "初始化上下文"} · ${completed}/${turn.trace.length}`}
          </small>
        </span>
        <StatusBadge status={turn.status} />
        {traceOpen ? <CaretDown size={16} /> : <CaretRight size={16} />}
      </button>
      {traceOpen && <TraceTimeline trace={turn.trace} />}
      {turn.result ? (
        <ResultCard turn={turn} />
      ) : turn.answer && terminal ? (
        <TextAnswer turn={turn} />
      ) : (
        <RunningResult status={turn.status} />
      )}
    </article>
  );
}

function TraceTimeline({ trace }: { trace: TraceStep[] }) {
  return (
    <div className="trace-panel" aria-label="本轮分析证据链">
      {trace.map((step, index) => (
        <div className={`trace-step ${step.status}`} key={step.id}>
          <div className="trace-axis">
            <span>
              {step.status === "completed" ? (
                <Check size={12} weight="bold" />
              ) : step.status === "skipped" ? (
                "–"
              ) : step.status === "running" ? (
                <span className="spinner" />
              ) : (
                index + 1
              )}
            </span>
            {index < trace.length - 1 && <i />}
          </div>
          <div className="trace-copy">
            <strong>{step.label}</strong>
            <p>{step.summary}</p>
            {step.facts?.length ? (
              <dl className="trace-facts">
                {step.facts.map((fact, factIndex) => (
                  <div key={`${fact.label}-${fact.entityId ?? factIndex}`}>
                    <dt>{fact.label}</dt>
                    <dd>
                      <span>{fact.value}</span>
                      {fact.source && <small>{fact.source}</small>}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {step.detail && <p className="trace-detail">{step.detail}</p>}
            {step.code && (
              <details className="trace-code">
                <summary>
                  查看{step.code.language === "sql"
                    ? "编译 SQL"
                    : step.kind === "semantic_binding"
                      ? "候选诊断"
                      : "查询 IR"}
                </summary>
                <pre><code>{step.code.content}</code></pre>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultCard({ turn }: { turn: Turn }) {
  const result = turn.result!;
  const chartOption: InsightChartOption = {
    tooltip: { trigger: "axis", confine: true },
    grid: { left: 44, right: 16, top: 38, bottom: 30 },
    xAxis: {
      type: "category" as const,
      data: result.chart.categories,
      axisLine: { lineStyle: { color: "#d7deea" } },
      axisTick: { show: false },
      axisLabel: { color: "#667085", fontSize: 11 },
    },
    yAxis: {
      type: "value" as const,
      splitLine: { lineStyle: { color: "#eef2f7" } },
      axisLabel: { color: "#98a2b3", fontSize: 11 },
    },
    series: result.chart.series.map((series) => ({
      ...series,
      type: result.chart.type as "bar" | "line",
      barMaxWidth: 30,
      itemStyle: {
        color: "#146ef5",
        borderRadius: result.chart.type === "bar" ? [4, 4, 0, 0] : 0,
      },
      lineStyle: { width: 3 },
      smooth: true,
    })),
  };

  return (
    <div className="answer-block">
      <div className="answer-heading">
        <div className="agent-avatar">
          <Sparkle size={17} weight="fill" />
        </div>
        <div>
          <span className="message-label">InsightFlow</span>
          <strong>分析完成</strong>
        </div>
        <span className="completed-chip">
          <CheckCircle size={15} weight="fill" /> 真实查询
        </span>
      </div>
      <p className="conclusion">{result.conclusion}</p>
      <div className="kpi-grid">
        {result.kpis.map((kpi) => (
          <div className="kpi-card" key={kpi.label}>
            <span>{kpi.label}</span>
            <strong>{kpi.value}</strong>
            {kpi.change && <small>{kpi.change} 环比</small>}
          </div>
        ))}
      </div>
      <div className="visual-card">
        <div className="card-title-row">
          <div>
            <span className="section-kicker">趋势</span>
            <h3>{result.chart.title}</h3>
          </div>
          <button className="subtle-button">查看数据</button>
        </div>
        <Suspense fallback={<div className="chart-view chart-loading">正在绘制趋势…</div>}>
          <ChartView option={chartOption} />
        </Suspense>
      </div>
      <div className="data-table-card">
        <div className="card-title-row">
          <div>
            <span className="section-kicker">明细</span>
            <h3>主要贡献项</h3>
          </div>
          <span className="row-count">{result.rowCount} 行</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index}>
                  {result.columns.map((column) => (
                    <td key={column}>{row[column]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TextAnswer({ turn }: { turn: Turn }) {
  const needsConfiguration = turn.responseKind === "configuration_required";
  return (
    <div className={`text-answer ${needsConfiguration ? "configuration" : ""}`}>
      <div className="agent-avatar">
        {needsConfiguration ? <GearSix size={17} /> : <Sparkle size={17} weight="fill" />}
      </div>
      <div>
        <span className="message-label">
          {needsConfiguration ? "运行条件未就绪" : "InsightFlow"}
        </span>
        <p>{turn.answer}</p>
      </div>
    </div>
  );
}

function RunningResult({ status }: { status: Turn["status"] }) {
  if (status === "failed") {
    return (
      <div className="inline-state danger">
        <X size={17} weight="bold" /> 本轮分析失败，请展开追踪查看原因后重试。
      </div>
    );
  }
  return (
    <div className="running-result">
      <span className="skeleton line wide" />
      <span className="skeleton line" />
      <div className="skeleton-grid">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function ContextPanel({
  conversation,
  ontology,
}: {
  conversation: Conversation | null;
  ontology: OntologySnapshot;
}) {
  const turn = conversation?.turns.at(-1);
  const semantic = turn?.trace.find((step) => step.kind === "semantic_binding");
  const plan = turn?.trace.find((step) => step.kind === "query_plan");
  const sql = turn?.trace.find((step) => step.kind === "sql");
  const execution = turn?.trace.find((step) => step.kind === "execution");
  return (
    <aside className="context-panel">
      <header>
        <span>分析上下文</span>
        <Info size={17} />
      </header>
      <section>
        <h3>当前问题</h3>
        <p className="context-question">
          {turn?.question || "发送问题后，这里会显示本轮实际分析上下文。"}
        </p>
      </section>
      <section>
        <h3>本轮追踪</h3>
        <ContextItem
          icon={CirclesFour}
          label="语义绑定"
          value={semantic?.summary || "尚未执行"}
        />
        <ContextItem
          icon={GitBranch}
          label="查询方案"
          value={plan?.summary || "尚未执行"}
        />
        <ContextItem
          icon={Table}
          label="编译 SQL"
          value={sql?.summary || "尚未执行"}
        />
        <ContextItem
          icon={Database}
          label="查询执行"
          value={execution?.summary || "尚未执行"}
        />
      </section>
      <section>
        <h3>结果类型</h3>
        <div className={`context-result-kind ${turn?.result ? "verified" : ""}`}>
          {turn?.result ? <SealCheck size={18} weight="fill" /> : <Info size={18} />}
          <span>
            <strong>{turn?.result ? "真实查询结果" : "未产生数据结果"}</strong>
            <small>
              {turn?.result
                ? "结论来自本轮 SelectDB 返回数据"
                : "一般对话或运行条件不足时不会生成图表"}
            </small>
          </span>
        </div>
      </section>
      <section className="context-version">
        <h3>语义版本</h3>
        <div>
          <SealCheck size={18} weight="fill" />
          <span>
            <strong>Ontology v{turn?.ontologyVersion ?? ontology.version}</strong>
            <small>已发布 · 可追溯</small>
          </span>
        </div>
      </section>
    </aside>
  );
}

function ContextItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof ChartBar;
  label: string;
  value: string;
}) {
  return (
    <div className="context-item">
      <span className="context-icon">
        <Icon size={16} />
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}

function ManagementWorkspace({
  page,
  state,
  onState,
  onBack,
  onError,
}: {
  page: Page;
  state: BootstrapPayload;
  onState: React.Dispatch<React.SetStateAction<BootstrapPayload | null>>;
  onBack: () => void;
  onError: (message: string) => void;
}) {
  return (
    <main className="management-workspace">
      <header className="management-header">
        <div>
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} /> 返回问数
          </button>
          <h1>
            {page === "ontology"
              ? "业务本体"
              : page === "data"
                ? "数据管理"
                : page === "audit"
                  ? "分析审计"
                  : "工作区设置"}
          </h1>
          <p>
            {page === "ontology"
              ? "将物理表转化为可解释、可复用的业务语义。"
              : page === "data"
                ? "管理 SelectDB 连接、Schema 扫描与表建模状态。"
                : page === "audit"
                  ? "按会话与轮次回溯语义、SQL 和结果。"
                  : "配置本地工作区与运行参数。"}
          </p>
        </div>
        <div className="header-product">
          <Sparkle size={18} weight="fill" /> InsightFlow
        </div>
      </header>
      {page === "ontology" && (
        <OntologyPage
          ontology={state.ontology}
          draft={state.ontologyDraft}
          tables={state.tables}
          onState={onState}
          onError={onError}
        />
      )}
      {page === "data" && (
        <DataPage
          source={state.dataSource}
          tables={state.tables}
          onState={onState}
          onError={onError}
        />
      )}
      {page === "audit" && <AuditPage conversations={state.conversations} />}
      {page === "settings" && (
        <SettingsPage
          runtime={state.runtime}
          config={state.agentConfig}
          valueIndex={state.valueIndex}
          onState={onState}
          onError={onError}
        />
      )}
    </main>
  );
}

function OntologyPage({
  ontology,
  draft: ontologyDraft,
  tables,
  onState,
  onError,
}: {
  ontology: OntologySnapshot;
  draft?: OntologySnapshot;
  tables: PhysicalTable[];
  onState: React.Dispatch<React.SetStateAction<BootstrapPayload | null>>;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [validation, setValidation] = useState<OntologyValidationResult | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const working = ontologyDraft ?? ontology;
  const [focusedId, setFocusedId] = useState(working.objects[0]?.id ?? "");
  const available = tables.filter((table) => table.status === "UNMODELED");
  const drafting = Boolean(ontologyDraft);
  const focusedObject =
    working.objects.find((object) => object.id === focusedId) ??
    working.objects[0] ??
    null;
  useEffect(() => {
    if (!focusedObject && working.objects[0]) {
      setFocusedId(working.objects[0].id);
    }
  }, [focusedObject, working.objects]);
  async function draft() {
    try {
      const result = await api.createDrafts(selected);
      onState((previous) =>
        previous
          ? { ...previous, ontologyDraft: result.ontology, tables: result.tables }
          : previous,
      );
      setSelected([]);
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  async function beginEditing() {
    try {
      const result = await api.createOntologyDraft();
      onState((previous) =>
        previous ? { ...previous, ontologyDraft: result.ontology } : previous,
      );
      setValidation(null);
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  async function validate() {
    try {
      setValidation(await api.validateOntologyDraft());
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  async function discard() {
    try {
      const result = await api.discardOntologyDraft();
      onState((previous) =>
        previous
          ? {
              ...previous,
              ontology: result.ontology,
              ontologyDraft: undefined,
              tables: result.tables,
            }
          : previous,
      );
      setValidation(null);
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  async function publish() {
    try {
      const result = await api.publishOntology();
      onState((previous) =>
        previous
          ? {
              ...previous,
              ontology: result.ontology,
              ontologyDraft: undefined,
              tables: result.tables,
              valueIndex: result.valueIndex,
            }
          : previous,
      );
      setValidation(result.validation);
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  async function removeObject(object: OntologyObject) {
    setDeletingId(object.id);
    try {
      const result = await api.deleteOntologyObject(object.id);
      onState((previous) =>
        previous
          ? {
              ...previous,
              ontologyDraft: result.ontology,
              tables: result.tables,
            }
          : previous,
      );
      setValidation(result.validation);
      setFocusedId((current) =>
        result.ontology.objects.some((candidate) => candidate.id === current)
          ? current
          : (result.ontology.objects[0]?.id ?? ""),
      );
      setPendingDeleteId("");
    } catch (reason) {
      onError(asMessage(reason));
    } finally {
      setDeletingId("");
    }
  }
  return (
    <div className="management-content ontology-management-content">
      <div className="stats-row">
        <StatCard label="业务对象" value={working.objects.length} icon={CirclesFour} />
        <StatCard label="对象关系" value={working.relations.length} icon={GitBranch} />
        <StatCard label="业务指标" value={working.metrics.length} icon={ChartBar} />
        <StatCard label="当前版本" value={`v${ontology.version}`} icon={SealCheck} />
      </div>
      <div className={`ontology-grid ${drafting ? "editing" : ""}`}>
        <section className="panel ontology-list">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">业务语义</span>
              <h2>对象目录</h2>
            </div>
            <span className={`status-pill ${drafting ? "warning" : "success"}`}>
              {drafting ? "草稿待发布" : "已发布"}
            </span>
          </div>
          {working.objects.length ? (
            working.objects.map((object) => (
              <div
                className={`ontology-object-row ${drafting ? "editable" : ""} ${
                  pendingDeleteId === object.id ? "confirming" : ""
                }`}
                key={object.id}
              >
                <button
                  className={`ontology-object ${
                    focusedObject?.id === object.id ? "selected" : ""
                  }`}
                  onClick={() => setFocusedId(object.id)}
                  aria-pressed={focusedObject?.id === object.id}
                >
                  <span className="object-icon">
                    <CirclesFour size={18} />
                  </span>
                  <span>
                    <strong>{object.label}</strong>
                    <small>{object.name} · {object.properties.length} 个属性</small>
                  </span>
                  <CaretRight size={16} />
                </button>
                {drafting && pendingDeleteId !== object.id && (
                  <button
                    className="ontology-object-delete"
                    onClick={() => setPendingDeleteId(object.id)}
                    aria-label={`删除对象 ${object.label}`}
                    title="从草稿移除对象"
                  >
                    <Trash size={15} />
                  </button>
                )}
                {pendingDeleteId === object.id && (
                  <div className="object-delete-confirm">
                    <span>同时移除指标和关系，来源表回到待建模。</span>
                    <button
                      className="subtle-button"
                      onClick={() => setPendingDeleteId("")}
                      disabled={deletingId === object.id}
                    >
                      取消
                    </button>
                    <button
                      className="subtle-button danger-text"
                      onClick={() => void removeObject(object)}
                      disabled={deletingId === object.id}
                    >
                      {deletingId === object.id ? "移除中" : "确认移除"}
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="ontology-empty">
              <CirclesFour size={24} />
              <strong>还没有本体对象</strong>
              <p>先到数据管理扫描 Schema，再勾选待建模表生成草稿。</p>
            </div>
          )}
        </section>
        <section className="panel object-inspector">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">对象定义</span>
              <h2>{focusedObject?.label || "对象详情"}</h2>
            </div>
            {focusedObject && (
              <span className={`status-pill ${focusedObject.status === "DRAFT" ? "warning" : "success"}`}>
                {ontologyStatusLabel(focusedObject.status)}
              </span>
            )}
          </div>
          {focusedObject ? (
            <OntologyObjectInspector
              key={`${working.version}-${working.objects.length}-${working.metrics.length}-${working.relations.length}-${focusedObject.id}`}
              object={focusedObject}
              ontology={working}
              tables={tables}
              onSelectObject={setFocusedId}
              editable={drafting}
              onSaved={(updated, result) => {
                onState((previous) =>
                  previous ? { ...previous, ontologyDraft: updated } : previous,
                );
                setValidation(result);
              }}
              onError={onError}
            />
          ) : (
            <div className="inspector-empty">
              <Database size={28} />
              <strong>等待 Schema 建模</strong>
              <p>对象生成后可在这里检查来源表、属性、指标和关系。</p>
            </div>
          )}
        </section>
        <section className="panel draft-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">增量建模</span>
              <h2>待建模对象</h2>
            </div>
            <span className="count-badge">{available.length}</span>
          </div>
          <p className="panel-note">仅列出尚未建模的新表；已建模对象不会被重复生成。</p>
          <div className="draft-table-list">
            {available.length ? (
              available.map((table) => (
                <label key={table.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(table.id)}
                    onChange={(event) =>
                      setSelected((items) =>
                        event.target.checked
                          ? [...items, table.id]
                          : items.filter((id) => id !== table.id),
                      )
                    }
                  />
                  <span>
                    <strong>{table.name}</strong>
                    <small>{table.description || "尚无业务描述"}</small>
                  </span>
                </label>
              ))
            ) : (
              <div className="compact-empty">
                <CheckCircle size={22} weight="fill" />
                所有可见表均已处理
              </div>
            )}
          </div>
          <button
            className="secondary-button full"
            disabled={!selected.length}
            onClick={() => void draft()}
          >
            <Sparkle size={17} /> 生成本体草稿
          </button>
          {!drafting ? (
            <button className="primary-button full" onClick={() => void beginEditing()}>
              <PencilSimple size={17} /> 编辑已发布版本
            </button>
          ) : (
            <>
              <button className="secondary-button full" onClick={() => void validate()}>
                <CheckCircle size={17} /> 校验草稿
              </button>
              <button className="primary-button full" onClick={() => void publish()}>
                <SealCheck size={17} /> 发布 v{working.version}
              </button>
              <button className="subtle-button full danger-text" onClick={() => void discard()}>
                <Trash size={16} /> 放弃草稿
              </button>
            </>
          )}
          {validation && (
            <div className={`validation-summary ${validation.valid ? "valid" : "invalid"}`}>
              <strong>{validation.valid ? "校验通过" : "需要修正"}</strong>
              <span>
                {validation.issues.length
                  ? `${validation.issues.filter((issue) => issue.level === "ERROR").length} 个错误，${validation.issues.filter((issue) => issue.level === "WARNING").length} 个提醒`
                  : "可以发布当前草稿"}
              </span>
              {validation.issues.slice(0, 3).map((issue) => (
                <small key={`${issue.code}-${issue.entityId ?? issue.objectId ?? ""}`}>
                  {issue.message}
                </small>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function OntologyObjectInspector({
  object,
  ontology,
  tables,
  onSelectObject,
  editable,
  onSaved,
  onError,
}: {
  object: OntologySnapshot["objects"][number];
  ontology: OntologySnapshot;
  tables: PhysicalTable[];
  onSelectObject: (id: string) => void;
  editable: boolean;
  onSaved: (
    ontology: OntologySnapshot,
    validation: OntologyValidationResult,
  ) => void;
  onError: (message: string) => void;
}) {
  const source = tables.find((table) => table.id === object.sourceTableId);
  const metrics = ontology.metrics.filter((metric) => metric.objectId === object.id);
  const relations = ontology.relations.filter(
    (relation) =>
      relation.sourceObjectId === object.id || relation.targetObjectId === object.id,
  );
  if (editable) {
    return (
      <OntologyObjectEditor
        key={`${ontology.version}-${object.id}`}
        object={object}
        ontology={ontology}
        tables={tables}
        source={source}
        metrics={metrics}
        relations={relations}
        onSaved={onSaved}
        onError={onError}
      />
    );
  }
  return (
    <div className="object-detail">
      <div className="object-summary">
        <div>
          <span>对象类型</span>
          <strong>{objectTypeLabel(object.objectType)}</strong>
        </div>
        <div>
          <span>对象编码</span>
          <strong>{object.name}</strong>
        </div>
        <div>
          <span>来源表</span>
          <strong>{source ? `${source.database}.${source.name}` : "来源表不可用"}</strong>
        </div>
        <div>
          <span>行级粒度</span>
          <strong>{effectiveGrainLabel(object)}</strong>
        </div>
      </div>
      <p className="object-description">{object.description || "暂无业务描述"}</p>
      <div className="detail-section-heading">
        <h3>属性</h3>
        <span>{object.properties.length}</span>
      </div>
      <div className="property-table-wrap">
        <table className="property-table">
          <thead>
            <tr>
              <th>业务名称</th>
              <th>物理字段</th>
              <th>字段含义</th>
              <th>查询约束</th>
              <th>可见性</th>
            </tr>
          </thead>
          <tbody>
            {object.properties.map((property) => (
              <tr key={property.id}>
                <td><strong>{property.label}</strong><small>{property.name}</small></td>
                <td>{property.sourceColumn}</td>
                <td>
                  <strong>{propertyMeaningLabel(property.meaning)}</strong>
                  <small>{property.dataType}</small>
                </td>
                <td>
                  <div className="property-role-summary">
                    <span>{propertyConstraintLabel(property, object)}</span>
                    {property.meaning === "ENTITY_REFERENCE" && (
                      <span className="relation">
                        {relationTargetLabel(property.id, object.id, relations, ontology)}
                      </span>
                    )}
                  </div>
                </td>
                <td>{propertyVisibilityLabel(property.visibility)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="inspector-columns">
        <section>
          <div className="detail-section-heading">
            <h3>指标</h3>
            <span>{metrics.length}</span>
          </div>
          <div className="semantic-list">
            {metrics.length ? metrics.map((metric) => (
              <div key={metric.id}>
                <ChartBar size={16} />
                <span><strong>{metric.label}</strong><small>{metric.expression}</small></span>
              </div>
            )) : <p>该对象暂未定义指标</p>}
          </div>
        </section>
        <section>
          <div className="detail-section-heading">
            <h3>关系</h3>
            <span>{relations.length}</span>
          </div>
          <div className="semantic-list">
            {relations.length ? relations.map((relation) => {
              const peerId =
                relation.sourceObjectId === object.id
                  ? relation.targetObjectId
                  : relation.sourceObjectId;
              const peer = ontology.objects.find((item) => item.id === peerId);
              return (
                <button key={relation.id} onClick={() => onSelectObject(peerId)}>
                  <LinkIcon size={16} />
                  <span>
                    <strong>{relation.name}</strong>
                    <small>{peer?.label || peerId} · {cardinalityLabel(relation.cardinality)}</small>
                  </span>
                  <CaretRight size={14} />
                </button>
              );
            }) : <p>该对象暂未定义关系</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

type OntologyEditorTab = "basic" | "properties" | "metrics" | "relations" | "rules";

function OntologyObjectEditor({
  object,
  ontology,
  tables,
  source,
  metrics,
  relations,
  onSaved,
  onError,
}: {
  object: OntologyObject;
  ontology: OntologySnapshot;
  tables: PhysicalTable[];
  source?: PhysicalTable;
  metrics: Metric[];
  relations: OntologyRelation[];
  onSaved: (
    ontology: OntologySnapshot,
    validation: OntologyValidationResult,
  ) => void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<OntologyEditorTab>("basic");
  const [draftObject, setDraftObject] = useState(() => structuredClone(object));
  const [draftMetrics, setDraftMetrics] = useState(() => structuredClone(metrics));
  const [draftRelations, setDraftRelations] = useState(() => structuredClone(relations));
  const [selectedMetricId, setSelectedMetricId] = useState(metrics[0]?.id ?? "");
  const [selectedRelationId, setSelectedRelationId] = useState(relations[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const selectedMetric = draftMetrics.find((metric) => metric.id === selectedMetricId);
  const selectedRelation = draftRelations.find(
    (relation) => relation.id === selectedRelationId,
  );

  function changeObject(patch: Partial<OntologyObject>) {
    setDraftObject((current) => ({ ...current, ...patch }));
    setDirty(true);
  }
  function changeProperty(
    propertyId: string,
    patch: Partial<OntologyObject["properties"][number]>,
  ) {
    changeObject({
      properties: draftObject.properties.map((property) =>
        property.id === propertyId ? { ...property, ...patch } : property,
      ),
    });
  }
  function changePropertyMeaning(
    propertyId: string,
    meaning: OntologyObject["properties"][number]["meaning"],
  ) {
    const currentProperty = draftObject.properties.find(
      (property) => property.id === propertyId,
    );
    if (!currentProperty) return;
    const outgoingRelations = draftRelations.filter(
      (relation) =>
        relation.sourceObjectId === draftObject.id &&
        relation.sourcePropertyId === propertyId,
    );
    if (
      currentProperty.meaning === "ENTITY_REFERENCE" &&
      meaning !== "ENTITY_REFERENCE" &&
      outgoingRelations.length &&
      !window.confirm("修改字段含义会同时删除该字段建立的对象关系，是否继续？")
    ) {
      return;
    }
    let properties = draftObject.properties.map((property) => ({ ...property }));
    if (meaning === "ID") {
      const existingId = properties.find(
        (property) => property.meaning === "ID" && property.id !== propertyId,
      );
      if (
        existingId &&
        !window.confirm(
          `当前 ID 是“${existingId.label}”。是否替换为“${currentProperty.label}”？原字段将改为编号。`,
        )
      ) {
        return;
      }
      properties = properties.map((property) =>
        property.id === existingId?.id
          ? {
              ...property,
              meaning: "CODE" as const,
              unique: true,
              valueSearchable: !property.sensitive,
            }
          : property,
      );
    }
    properties = properties.map((property) => {
      if (property.id !== propertyId) return property;
      return {
        ...property,
        meaning,
        unique: meaning === "ID" ? true : meaning === "CODE" ? property.unique : false,
        valueSearchable:
          !property.sensitive && defaultValueSearchableForMeaning(meaning),
        numericSpec:
          meaning === "NUMBER"
            ? property.numericSpec ?? defaultNumericSpec()
            : undefined,
        visibility:
          meaning === "ID" || meaning === "ENTITY_REFERENCE"
            ? ("ANALYTICAL" as const)
            : property.visibility,
      };
    });
    setDraftObject((current) => ({
      ...current,
      identityReviewRequired:
        meaning === "ID" ? false : current.identityReviewRequired,
      properties,
      grainPropertyIds:
        meaning === "ID"
          ? [propertyId]
          : current.grainPropertyIds.filter((id) => id !== propertyId),
    }));
    if (
      currentProperty.meaning === "ENTITY_REFERENCE" &&
      meaning !== "ENTITY_REFERENCE"
    ) {
      setDraftRelations((items) =>
        items.filter(
          (relation) =>
            relation.sourceObjectId !== draftObject.id ||
            relation.sourcePropertyId !== propertyId,
        ),
      );
    }
    setDirty(true);
  }
  function setEntityReferenceTarget(propertyId: string, targetObjectId: string) {
    if (!targetObjectId) return;
    const property = draftObject.properties.find(
      (candidate) => candidate.id === propertyId,
    );
    const target = ontology.objects.find(
      (candidate) => candidate.id === targetObjectId,
    );
    const targetId = target?.properties.find(
      (candidate) => candidate.meaning === "ID",
    );
    if (!property || !target || !targetId) {
      onError("目标对象必须先配置唯一 ID");
      return;
    }
    changePropertyMeaning(propertyId, "ENTITY_REFERENCE");
    const currentRelation = draftRelations.find(
      (relation) =>
        relation.sourceObjectId === draftObject.id &&
        relation.sourcePropertyId === propertyId,
    );
    const nextRelation: OntologyRelation = {
      id: currentRelation?.id ?? createClientId("relation"),
      name: `${draftObject.label}关联${target.label}`,
      sourceObjectId: draftObject.id,
      targetObjectId: target.id,
      sourcePropertyId: property.id,
      targetPropertyId: targetId.id,
      type: currentRelation?.type ?? "REFERENCE",
      cardinality: currentRelation?.cardinality ?? "MANY_TO_ONE",
      joinExpression: relationJoinExpression(
        draftObject,
        target,
        property.id,
        targetId.id,
        source,
        tables.find((table) => table.id === target.sourceTableId),
      ),
      direction: currentRelation?.direction ?? "BIDIRECTIONAL",
      required: currentRelation?.required ?? false,
      enabled: true,
      fanoutRisk: currentRelation?.fanoutRisk ?? "NONE",
      status: "DRAFT",
    };
    setDraftRelations((items) =>
      currentRelation
        ? items.map((relation) =>
            relation.id === currentRelation.id ? nextRelation : relation,
          )
        : [...items, nextRelation],
    );
    setDirty(true);
  }
  function toggleGrainProperty(propertyId: string, checked: boolean) {
    changeObject({
      grainPropertyIds: checked
        ? [...new Set([...draftObject.grainPropertyIds, propertyId])]
        : draftObject.grainPropertyIds.filter((id) => id !== propertyId),
    });
  }
  function changeMetric(metricId: string, patch: Partial<Metric>) {
    setDraftMetrics((items) =>
      items.map((metric) =>
        metric.id === metricId ? { ...metric, ...patch } : metric,
      ),
    );
    setDirty(true);
  }
  function changeRelation(relationId: string, patch: Partial<OntologyRelation>) {
    setDraftRelations((items) =>
      items.map((relation) =>
        relation.id === relationId ? { ...relation, ...patch } : relation,
      ),
    );
    setDirty(true);
  }
  function addMetric() {
    const sourceProperty = draftObject.properties.find(
      (property) =>
        property.visibility === "ANALYTICAL" && property.meaning === "NUMBER",
    );
    const defaultAggregation =
      sourceProperty?.numericSpec?.defaultAggregation ?? "NONE";
    const metric: Metric = {
      id: createClientId("metric"),
      objectId: object.id,
      name: `metric_${draftMetrics.length + 1}`,
      label: "新指标",
      description: "",
      definitionMode: "VISUAL",
      sourcePropertyId: sourceProperty?.id,
      expression: "",
      aggregation:
        defaultAggregation === "NONE"
          ? sourceProperty
            ? "AVG"
            : "COUNT"
          : defaultAggregation,
      format: "number",
      synonyms: [],
      status: "DRAFT",
    };
    setDraftMetrics((items) => [...items, metric]);
    setSelectedMetricId(metric.id);
    setDirty(true);
  }
  function addRelation() {
    const target = ontology.objects.find((candidate) => candidate.id !== object.id);
    if (!target) {
      onError("至少需要两个业务对象才能创建关系");
      return;
    }
    const sourceProperty =
      draftObject.properties.find(
        (property) =>
          property.visibility === "ANALYTICAL" &&
          property.meaning === "ENTITY_REFERENCE",
      ) ??
      draftObject.properties.find(
        (property) =>
          property.visibility === "ANALYTICAL" && property.meaning === "CODE",
      ) ??
      draftObject.properties.find(
        (property) =>
          property.visibility === "ANALYTICAL" && property.meaning !== "ID",
      );
    const targetProperty =
      target.properties.find(
        (property) =>
          property.visibility === "ANALYTICAL" &&
          property.meaning === "ID",
      );
    if (!sourceProperty || !targetProperty) {
      onError("请先为源对象选择关联字段，并为目标对象配置唯一 ID");
      return;
    }
    const relation: OntologyRelation = {
      id: createClientId("relation"),
      name: `${object.label}关联${target.label}`,
      sourceObjectId: draftObject.id,
      targetObjectId: target.id,
      sourcePropertyId: sourceProperty?.id,
      targetPropertyId: targetProperty?.id,
      type: "REFERENCE",
      cardinality: "MANY_TO_ONE",
      joinExpression: relationJoinExpression(
        draftObject,
        target,
        sourceProperty?.id,
        targetProperty?.id,
        source,
        tables.find((table) => table.id === target.sourceTableId),
      ),
      direction: "BIDIRECTIONAL",
      required: false,
      enabled: true,
      fanoutRisk: "NONE",
      status: "DRAFT",
    };
    changePropertyMeaning(sourceProperty.id, "ENTITY_REFERENCE");
    setDraftRelations((items) => [...items, relation]);
    setSelectedRelationId(relation.id);
    setDirty(true);
  }
  async function save() {
    setSaving(true);
    try {
      const normalizedMetrics = draftMetrics.map((metric) => ({
        ...metric,
        expression:
          metric.definitionMode === "VISUAL"
            ? visualMetricExpression(metric, draftObject)
            : metric.expression,
      }));
      const objectToSave = {
        ...draftObject,
        identityReviewRequired:
          draftObject.properties.filter((property) => property.meaning === "ID")
            .length === 1
            ? false
            : draftObject.identityReviewRequired,
      };
      const result = await api.saveOntologyObject(
        objectToSave,
        normalizedMetrics,
        draftRelations,
      );
      setDraftObject(objectToSave);
      setDraftMetrics(normalizedMetrics);
      setDirty(false);
      onSaved(result.ontology, result.validation);
    } catch (reason) {
      onError(asMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  const tabs: Array<{ id: OntologyEditorTab; label: string; count?: number }> = [
    { id: "basic", label: "基本信息" },
    { id: "properties", label: "属性", count: draftObject.properties.length },
    { id: "metrics", label: "指标", count: draftMetrics.length },
    { id: "relations", label: "关系", count: draftRelations.length },
    { id: "rules", label: "规则" },
  ];
  return (
    <div className="ontology-editor">
      <div className="editor-toolbar">
        <div className="editor-tabs" role="tablist" aria-label="对象编辑分区">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
              role="tab"
              aria-selected={tab === item.id}
            >
              {item.label}
              {item.count !== undefined && <span>{item.count}</span>}
            </button>
          ))}
        </div>
        <div className="save-state">
          <span className={dirty ? "dirty" : ""}>{dirty ? "有未保存修改" : "已保存"}</span>
          <button
            className="primary-button"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <FloppyDisk size={16} /> {saving ? "保存中" : "保存对象"}
          </button>
        </div>
      </div>

      {tab === "basic" && (
        <div className="editor-section">
          <div className="form-grid ontology-form-grid">
            <EditorField label="业务名称">
              <input
                value={draftObject.label}
                onChange={(event) => changeObject({ label: event.target.value })}
              />
            </EditorField>
            <EditorField label="对象编码">
              <input
                value={draftObject.name}
                onChange={(event) => changeObject({ name: event.target.value })}
              />
            </EditorField>
            <EditorField label="来源表">
              <input
                value={source ? `${source.database}.${source.name}` : "来源表不可用"}
                disabled
              />
            </EditorField>
            <EditorField label="对象类型">
              <select
                value={draftObject.objectType}
                onChange={(event) =>
                  changeObject({
                    objectType: event.target.value as OntologyObject["objectType"],
                    grainPropertyIds:
                      event.target.value === "ENTITY"
                        ? draftObject.properties
                            .filter((property) => property.meaning === "ID")
                            .map((property) => property.id)
                        : draftObject.grainPropertyIds,
                  })
                }
              >
                {OBJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {objectTypeLabel(type)}
                  </option>
                ))}
              </select>
            </EditorField>
            <EditorField label="匹配优先级">
              <input
                type="number"
                min={0}
                max={100}
                value={draftObject.bindingPriority}
                title="仅在同一原文片段、同一语义角色且证据等级相同时参与裁决"
                onChange={(event) =>
                  changeObject({
                    bindingPriority: Math.min(
                      100,
                      Math.max(0, Number(event.target.value) || 0),
                    ),
                  })
                }
              />
            </EditorField>
            <EditorField label="业务分类">
              <input
                value={draftObject.category ?? ""}
                placeholder="例如：交易域"
                onChange={(event) => changeObject({ category: event.target.value })}
              />
            </EditorField>
            <EditorField label="当前行级粒度" wide>
              <input
                value={effectiveGrainLabel(draftObject)}
                disabled
              />
            </EditorField>
            <EditorField label="粒度补充说明" wide>
              <input
                value={draftObject.grain}
                placeholder="可选，例如：每日闭店后的库存状态"
                onChange={(event) => changeObject({ grain: event.target.value })}
              />
            </EditorField>
            <EditorField label="业务描述" wide>
              <textarea
                rows={3}
                value={draftObject.description}
                onChange={(event) => changeObject({ description: event.target.value })}
              />
            </EditorField>
            <EditorField label="对象同义词" wide>
              <input
                value={draftObject.synonyms.join("、")}
                placeholder="用顿号或逗号分隔"
                onChange={(event) =>
                  changeObject({ synonyms: splitTerms(event.target.value) })
                }
              />
            </EditorField>
          </div>
        </div>
      )}

      {tab === "properties" && (
        <div className="editor-section property-editor">
          <div className="editor-help">
            <Info size={16} />
            字段含义只保留会影响检索、SQL 或校验的业务语义。ID 表示当前对象，关联实体表示它指向的其他对象。
          </div>
          <div
            className="property-edit-table"
            tabIndex={0}
            aria-label="属性配置表，可横向滚动查看更多配置"
          >
            <div className="property-edit-grid">
              <div className="property-edit-row header">
                <span>业务名称</span>
                <span>物理字段</span>
                <span>字段含义</span>
                <span>匹配优先级</span>
                <span>查询约束</span>
                <span>可用范围</span>
                <span>数字规则（类型 / 可加性 / 默认聚合 / 单位）</span>
                <span>口径说明</span>
                <span>同义词</span>
                <span>值定位</span>
                <span>明细展示</span>
                <span>导出</span>
              </div>
              {draftObject.properties.map((property) => {
              const sourceRelation = draftRelations.find(
                (relation) =>
                  relation.sourceObjectId === draftObject.id &&
                  relation.sourcePropertyId === property.id,
              );
              const hasObjectId = draftObject.properties.some(
                (candidate) => candidate.meaning === "ID",
              );
              return (
                <div className="property-edit-row" key={property.id}>
                  <input
                    value={property.label}
                    onChange={(event) =>
                      changeProperty(property.id, { label: event.target.value })
                    }
                  />
                  <div className="physical-field">
                    <code>{property.sourceColumn}</code>
                    <small>{property.dataType}</small>
                  </div>
                  <select
                    aria-label={`${property.label}字段含义`}
                    value={property.meaning}
                    onChange={(event) =>
                      changePropertyMeaning(
                        property.id,
                        event.target
                          .value as OntologyObject["properties"][number]["meaning"],
                      )
                    }
                  >
                    {PROPERTY_MEANINGS.map((meaning) => (
                      <option key={meaning} value={meaning}>
                        {propertyMeaningLabel(meaning)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    aria-label={`${property.label}匹配优先级`}
                    title="仅在同一原文片段、同一语义角色且证据等级相同时参与裁决"
                    value={property.bindingPriority}
                    onChange={(event) =>
                      changeProperty(property.id, {
                        bindingPriority: Math.min(
                          100,
                          Math.max(0, Number(event.target.value) || 0),
                        ),
                      })
                    }
                  />
                  <div className="property-constraint-cell">
                    {property.meaning === "ID" && (
                      <span className="identity-chip">当前对象唯一 ID</span>
                    )}
                    {property.meaning === "CODE" && (
                      <label className="compact-check">
                        <input
                          type="checkbox"
                          checked={property.unique}
                          onChange={(event) =>
                            changeProperty(property.id, {
                              unique: event.target.checked,
                            })
                          }
                        />
                        编号唯一
                      </label>
                    )}
                    {property.meaning === "ENTITY_REFERENCE" && (
                      <select
                        aria-label={`${property.label}关联目标`}
                        value={sourceRelation?.targetObjectId ?? ""}
                        onChange={(event) =>
                          setEntityReferenceTarget(property.id, event.target.value)
                        }
                      >
                        <option value="">选择目标对象</option>
                        {ontology.objects
                          .filter(
                            (candidate) =>
                              candidate.id !== draftObject.id &&
                              candidate.properties.some(
                                (targetProperty) => targetProperty.meaning === "ID",
                              ),
                          )
                          .map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.label}
                            </option>
                          ))}
                      </select>
                    )}
                    {(property.meaning === "ID" || !hasObjectId) && (
                      <label className="compact-check">
                        <input
                          type="checkbox"
                          checked={
                            property.meaning === "ID" ||
                            draftObject.grainPropertyIds.includes(property.id)
                          }
                          disabled={property.meaning === "ID"}
                          onChange={(event) =>
                            toggleGrainProperty(property.id, event.target.checked)
                          }
                        />
                        {property.meaning === "ID" ? "自动确定一行" : "共同确定一行"}
                      </label>
                    )}
                  </div>
                  <select
                    value={property.visibility}
                    aria-label={`${property.label}可用范围`}
                    disabled={
                      property.meaning === "ID" ||
                      property.meaning === "ENTITY_REFERENCE"
                    }
                    onChange={(event) =>
                      changeProperty(property.id, {
                        visibility: event.target
                          .value as OntologyObject["properties"][number]["visibility"],
                      })
                    }
                  >
                    <option value="ANALYTICAL">分析属性</option>
                    <option value="DETAIL_ONLY">仅明细展示</option>
                    <option value="HIDDEN">完全隐藏</option>
                  </select>
                  {property.meaning === "NUMBER" && property.numericSpec ? (
                    <div className="numeric-rule-grid">
                      <select
                        aria-label={`${property.label}数字类型`}
                        value={property.numericSpec.kind}
                        onChange={(event) =>
                          changeProperty(property.id, {
                            numericSpec: {
                              ...property.numericSpec!,
                              kind: event.target.value as NonNullable<
                                typeof property.numericSpec
                              >["kind"],
                              aggregationBehavior:
                                event.target.value === "RATIO"
                                  ? "NON_ADDITIVE"
                                  : property.numericSpec!.aggregationBehavior,
                              defaultAggregation:
                                event.target.value === "RATIO" &&
                                property.numericSpec!.defaultAggregation === "SUM"
                                  ? "AVG"
                                  : property.numericSpec!.defaultAggregation,
                            },
                          })
                        }
                      >
                        <option value="GENERAL">一般数字</option>
                        <option value="CURRENCY">货币</option>
                        <option value="RATIO">比率</option>
                      </select>
                      <select
                        aria-label={`${property.label}聚合性质`}
                        value={property.numericSpec.aggregationBehavior}
                        onChange={(event) =>
                          changeProperty(property.id, {
                            numericSpec: {
                              ...property.numericSpec!,
                              aggregationBehavior: event.target
                                .value as NonNullable<
                                typeof property.numericSpec
                              >["aggregationBehavior"],
                              defaultAggregation:
                                event.target.value === "NON_ADDITIVE" &&
                                property.numericSpec!.defaultAggregation === "SUM"
                                  ? "AVG"
                                  : property.numericSpec!.defaultAggregation,
                            },
                          })
                        }
                      >
                        <option value="ADDITIVE">可加</option>
                        <option value="SEMI_ADDITIVE">半可加</option>
                        <option value="NON_ADDITIVE">不可加</option>
                      </select>
                      <select
                        aria-label={`${property.label}默认聚合`}
                        value={property.numericSpec.defaultAggregation}
                        onChange={(event) =>
                          changeProperty(property.id, {
                            numericSpec: {
                              ...property.numericSpec!,
                              defaultAggregation: event.target
                                .value as NonNullable<
                                typeof property.numericSpec
                              >["defaultAggregation"],
                            },
                          })
                        }
                      >
                        <option value="NONE">不默认聚合</option>
                        <option
                          value="SUM"
                          disabled={
                            property.numericSpec.kind === "RATIO" ||
                            property.numericSpec.aggregationBehavior ===
                              "NON_ADDITIVE"
                          }
                        >
                          求和
                        </option>
                        <option value="AVG">平均</option>
                        <option value="MIN">最小值</option>
                        <option value="MAX">最大值</option>
                      </select>
                      <input
                        aria-label={`${property.label}单位或币种`}
                        value={
                          property.numericSpec.kind === "CURRENCY"
                            ? property.numericSpec.currency ?? ""
                            : property.numericSpec.unit ?? ""
                        }
                        placeholder={
                          property.numericSpec.kind === "CURRENCY"
                            ? "币种，如 CNY"
                            : "单位，如 kg"
                        }
                        onChange={(event) =>
                          changeProperty(property.id, {
                            numericSpec: {
                              ...property.numericSpec!,
                              ...(property.numericSpec!.kind === "CURRENCY"
                                ? { currency: event.target.value }
                                : { unit: event.target.value }),
                            },
                          })
                        }
                      />
                    </div>
                  ) : (
                    <span className="property-not-applicable">不适用</span>
                  )}
                  <input
                    value={property.description}
                    placeholder="属性口径说明"
                    onChange={(event) =>
                      changeProperty(property.id, { description: event.target.value })
                    }
                  />
                  <input
                    value={property.synonyms.join("、")}
                    placeholder="同义词"
                    disabled={property.visibility !== "ANALYTICAL"}
                    onChange={(event) =>
                      changeProperty(property.id, {
                        synonyms: splitTerms(event.target.value),
                      })
                    }
                  />
                  <div className="property-toggle-cell">
                    {isValueSearchableMeaning(property.meaning) ? (
                      <label className="inline-check" title="允许通过属性值定位该字段">
                        <input
                          type="checkbox"
                          checked={property.valueSearchable}
                          disabled={
                            property.sensitive ||
                            property.visibility !== "ANALYTICAL"
                          }
                          onChange={(event) =>
                            changeProperty(property.id, {
                              valueSearchable: event.target.checked,
                            })
                          }
                        />
                        允许
                      </label>
                    ) : (
                      <span className="property-not-applicable">—</span>
                    )}
                  </div>
                  <div className="property-toggle-cell">
                    <label className="inline-check" title="查询明细时默认展示">
                      <input
                        type="checkbox"
                        checked={property.defaultDisplay}
                        disabled={property.visibility !== "DETAIL_ONLY"}
                        onChange={(event) =>
                          changeProperty(property.id, {
                            defaultDisplay: event.target.checked,
                          })
                        }
                      />
                      默认
                    </label>
                  </div>
                  <div className="property-toggle-cell">
                    <label className="inline-check" title="允许导出该字段">
                      <input
                        type="checkbox"
                        checked={property.exportable}
                        disabled={property.visibility === "HIDDEN"}
                        onChange={(event) =>
                          changeProperty(property.id, {
                            exportable: event.target.checked,
                          })
                        }
                      />
                      允许
                    </label>
                  </div>
                </div>
              );
              })}
            </div>
          </div>
        </div>
      )}

      {tab === "metrics" && (
        <div className="editor-section split-editor">
          <EditorEntityList
            title="指标"
            items={draftMetrics.map((metric) => ({
              id: metric.id,
              label: metric.label,
              detail: metric.expression || "尚未生成表达式",
            }))}
            selectedId={selectedMetricId}
            onSelect={setSelectedMetricId}
            onAdd={addMetric}
          />
          {selectedMetric ? (
            <div className="entity-form">
              <div className="entity-form-heading">
                <strong>指标定义</strong>
                <button
                  className="subtle-button danger-text"
                  onClick={() => {
                    setDraftMetrics((items) =>
                      items.filter((metric) => metric.id !== selectedMetric.id),
                    );
                    setSelectedMetricId("");
                    setDirty(true);
                  }}
                >
                  <Trash size={14} /> 删除指标
                </button>
              </div>
              <div className="form-grid ontology-form-grid">
                <EditorField label="指标名称">
                  <input
                    value={selectedMetric.label}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, { label: event.target.value })
                    }
                  />
                </EditorField>
                <EditorField label="指标标识">
                  <input
                    value={selectedMetric.name}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, { name: event.target.value })
                    }
                  />
                </EditorField>
                <EditorField label="定义方式">
                  <select
                    value={selectedMetric.definitionMode}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, {
                        definitionMode: event.target.value as Metric["definitionMode"],
                        aggregation:
                          event.target.value === "SQL"
                            ? "CUSTOM"
                            : selectedMetric.aggregation === "CUSTOM"
                              ? "SUM"
                              : selectedMetric.aggregation,
                      })
                    }
                  >
                    <option value="VISUAL">可视化配置</option>
                    <option value="SQL">SQL 表达式</option>
                  </select>
                </EditorField>
                <EditorField label="展示格式">
                  <select
                    value={selectedMetric.format}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, {
                        format: event.target.value as Metric["format"],
                      })
                    }
                  >
                    <option value="number">数值</option>
                    <option value="currency">金额</option>
                    <option value="percent">百分比</option>
                  </select>
                </EditorField>
                {selectedMetric.definitionMode === "VISUAL" ? (
                  <>
                    <EditorField label="聚合方式">
                      <select
                        value={selectedMetric.aggregation}
                        onChange={(event) =>
                          changeMetric(selectedMetric.id, {
                            aggregation: event.target.value as Metric["aggregation"],
                          })
                        }
                      >
                        {["SUM", "COUNT", "COUNT_DISTINCT", "AVG", "MIN", "MAX"].map(
                          (aggregation) => (
                            <option key={aggregation}>{aggregation}</option>
                          ),
                        )}
                      </select>
                    </EditorField>
                    <EditorField label="计算字段">
                      <select
                        value={selectedMetric.sourcePropertyId ?? ""}
                        disabled={selectedMetric.aggregation === "COUNT"}
                        onChange={(event) =>
                          changeMetric(selectedMetric.id, {
                            sourcePropertyId: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">请选择属性</option>
                        {draftObject.properties
                          .filter((property) => property.visibility === "ANALYTICAL")
                          .map((property) => (
                            <option key={property.id} value={property.id}>
                              {property.label}
                            </option>
                          ))}
                      </select>
                    </EditorField>
                    <EditorField label="固定过滤条件" wide>
                      <input
                        value={selectedMetric.filterExpression ?? ""}
                        placeholder="例如：order_status = 'PAID'"
                        onChange={(event) =>
                          changeMetric(selectedMetric.id, {
                            filterExpression: event.target.value,
                          })
                        }
                      />
                    </EditorField>
                    <EditorField label="生成表达式" wide>
                      <code className="expression-preview">
                        {visualMetricExpression(selectedMetric, draftObject) || "等待配置"}
                      </code>
                    </EditorField>
                  </>
                ) : (
                  <EditorField label="SQL 表达式" wide>
                    <textarea
                      rows={4}
                      value={selectedMetric.expression}
                      placeholder="例如：SUM(pay_amount)"
                      onChange={(event) =>
                        changeMetric(selectedMetric.id, {
                          expression: event.target.value,
                        })
                      }
                    />
                  </EditorField>
                )}
                <EditorField label="指标描述" wide>
                  <textarea
                    rows={3}
                    value={selectedMetric.description}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, {
                        description: event.target.value,
                      })
                    }
                  />
                </EditorField>
                <EditorField label="同义词" wide>
                  <input
                    value={selectedMetric.synonyms.join("、")}
                    onChange={(event) =>
                      changeMetric(selectedMetric.id, {
                        synonyms: splitTerms(event.target.value),
                      })
                    }
                  />
                </EditorField>
              </div>
            </div>
          ) : (
            <div className="entity-empty">选择一个指标，或新增指标。</div>
          )}
        </div>
      )}

      {tab === "relations" && (
        <div className="editor-section split-editor">
          <EditorEntityList
            title="对象关系"
            items={draftRelations.map((relation) => ({
              id: relation.id,
              label: relation.name,
              detail: cardinalityLabel(relation.cardinality),
            }))}
            selectedId={selectedRelationId}
            onSelect={setSelectedRelationId}
            onAdd={addRelation}
          />
          {selectedRelation ? (
            <RelationEditor
              relation={selectedRelation}
              ontology={ontology}
              tables={tables}
              onChange={(patch) => {
                changeRelation(selectedRelation.id, patch);
                if (
                  patch.sourcePropertyId &&
                  selectedRelation.sourceObjectId === draftObject.id
                ) {
                  changePropertyMeaning(
                    patch.sourcePropertyId,
                    "ENTITY_REFERENCE",
                  );
                }
              }}
              onDelete={() => {
                setDraftRelations((items) =>
                  items.filter((relation) => relation.id !== selectedRelation.id),
                );
                setSelectedRelationId("");
                setDirty(true);
              }}
            />
          ) : (
            <div className="entity-empty">选择一个关系，或新增关系。</div>
          )}
        </div>
      )}

      {tab === "rules" && (
        <div className="editor-section">
          <div className="form-grid ontology-form-grid">
            <EditorField label="默认时间字段">
              <select
                value={draftObject.defaultTimePropertyId ?? ""}
                onChange={(event) =>
                  changeObject({
                    defaultTimePropertyId: event.target.value || undefined,
                  })
                }
              >
                <option value="">不设置</option>
                {draftObject.properties
                  .filter((property) => property.meaning === "TIME")
                  .map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.label}
                    </option>
                  ))}
              </select>
            </EditorField>
            <EditorField label="默认过滤条件" wide>
              <textarea
                rows={4}
                value={draftObject.defaultFilter ?? ""}
                placeholder="例如：is_deleted = 0"
                onChange={(event) =>
                  changeObject({ defaultFilter: event.target.value })
                }
              />
            </EditorField>
            <EditorField label="负责人">
              <input
                value={draftObject.owner ?? ""}
                onChange={(event) => changeObject({ owner: event.target.value })}
              />
            </EditorField>
            <EditorField label="示例问题" wide>
              <textarea
                rows={5}
                value={draftObject.exampleQuestions.join("\n")}
                placeholder={"每行一个问题\n例如：本月订单明细"}
                onChange={(event) =>
                  changeObject({
                    exampleQuestions: event.target.value
                      .split(/\r?\n/)
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
              />
            </EditorField>
          </div>
        </div>
      )}
    </div>
  );
}

function EditorField({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "wide" : ""}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function EditorEntityList({
  title,
  items,
  selectedId,
  onSelect,
  onAdd,
}: {
  title: string;
  items: Array<{ id: string; label: string; detail: string }>;
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="entity-list">
      <div>
        <strong>{title}</strong>
        <button className="subtle-button" onClick={onAdd}>
          <Plus size={14} /> 新增
        </button>
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          className={selectedId === item.id ? "selected" : ""}
          onClick={() => onSelect(item.id)}
        >
          <strong>{item.label}</strong>
          <small>{item.detail}</small>
        </button>
      ))}
      {!items.length && <p>暂未配置</p>}
    </aside>
  );
}

function RelationEditor({
  relation,
  ontology,
  tables,
  onChange,
  onDelete,
}: {
  relation: OntologyRelation;
  ontology: OntologySnapshot;
  tables: PhysicalTable[];
  onChange: (patch: Partial<OntologyRelation>) => void;
  onDelete: () => void;
}) {
  const source = ontology.objects.find(
    (object) => object.id === relation.sourceObjectId,
  );
  const target = ontology.objects.find(
    (object) => object.id === relation.targetObjectId,
  );
  function analyticalProperties(object?: OntologyObject) {
    return object?.properties.filter(
      (property) => property.visibility === "ANALYTICAL",
    ) ?? [];
  }
  function expression(
    nextSource = source,
    nextTarget = target,
    sourcePropertyId = relation.sourcePropertyId,
    targetPropertyId = relation.targetPropertyId,
  ) {
    if (!nextSource || !nextTarget) return "";
    return relationJoinExpression(
      nextSource,
      nextTarget,
      sourcePropertyId,
      targetPropertyId,
      tables.find((table) => table.id === nextSource.sourceTableId),
      tables.find((table) => table.id === nextTarget.sourceTableId),
    );
  }
  return (
    <div className="entity-form">
      <div className="entity-form-heading">
        <strong>关系定义</strong>
        <button className="subtle-button danger-text" onClick={onDelete}>
          <Trash size={14} /> 删除关系
        </button>
      </div>
      <div className="form-grid ontology-form-grid">
        <EditorField label="关系名称" wide>
          <input
            value={relation.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </EditorField>
        <EditorField label="源对象">
          <select
            value={relation.sourceObjectId}
            onChange={(event) => {
              const nextSource = ontology.objects.find(
                (object) => object.id === event.target.value,
              );
              const nextProperty = analyticalProperties(nextSource)[0];
              onChange({
                sourceObjectId: event.target.value,
                sourcePropertyId: nextProperty?.id,
                joinExpression: expression(
                  nextSource,
                  target,
                  nextProperty?.id,
                  relation.targetPropertyId,
                ),
              });
            }}
          >
            {ontology.objects.map((object) => (
              <option key={object.id} value={object.id}>{object.label}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="源字段">
          <select
            value={relation.sourcePropertyId ?? ""}
            onChange={(event) =>
              onChange({
                sourcePropertyId: event.target.value,
                joinExpression: expression(
                  source,
                  target,
                  event.target.value,
                  relation.targetPropertyId,
                ),
              })
            }
          >
            {analyticalProperties(source).map((property) => (
              <option key={property.id} value={property.id}>{property.label}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="目标对象">
          <select
            value={relation.targetObjectId}
            onChange={(event) => {
              const nextTarget = ontology.objects.find(
                (object) => object.id === event.target.value,
              );
              const nextProperty =
                analyticalProperties(nextTarget).find(
                  (property) => property.meaning === "ID",
                );
              onChange({
                targetObjectId: event.target.value,
                targetPropertyId: nextProperty?.id,
                joinExpression: expression(
                  source,
                  nextTarget,
                  relation.sourcePropertyId,
                  nextProperty?.id,
                ),
              });
            }}
          >
            {ontology.objects.map((object) => (
              <option key={object.id} value={object.id}>{object.label}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="目标字段">
          <select
            value={relation.targetPropertyId ?? ""}
            onChange={(event) =>
              onChange({
                targetPropertyId: event.target.value,
                joinExpression: expression(
                  source,
                  target,
                  relation.sourcePropertyId,
                  event.target.value,
                ),
              })
            }
          >
            {analyticalProperties(target)
              .filter((property) => property.meaning === "ID")
              .map((property) => (
              <option key={property.id} value={property.id}>{property.label}</option>
              ))}
          </select>
        </EditorField>
        <EditorField label="基数">
          <select
            value={relation.cardinality}
            onChange={(event) =>
              onChange({
                cardinality: event.target.value as OntologyRelation["cardinality"],
              })
            }
          >
            <option value="ONE_TO_ONE">一对一</option>
            <option value="ONE_TO_MANY">一对多</option>
            <option value="MANY_TO_ONE">多对一</option>
            <option value="MANY_TO_MANY">多对多</option>
          </select>
        </EditorField>
        <EditorField label="关系类型">
          <select
            value={relation.type}
            onChange={(event) =>
              onChange({ type: event.target.value as OntologyRelation["type"] })
            }
          >
            {RELATION_TYPES.map((type) => (
              <option key={type} value={type}>{relationTypeLabel(type)}</option>
            ))}
          </select>
        </EditorField>
        <EditorField label="查询方向">
          <select
            value={relation.direction}
            onChange={(event) =>
              onChange({
                direction: event.target.value as OntologyRelation["direction"],
              })
            }
          >
            <option value="BIDIRECTIONAL">双向</option>
            <option value="SOURCE_TO_TARGET">源到目标</option>
            <option value="TARGET_TO_SOURCE">目标到源</option>
          </select>
        </EditorField>
        <EditorField label="Join 表达式" wide>
          <input
            value={relation.joinExpression}
            onChange={(event) => onChange({ joinExpression: event.target.value })}
          />
        </EditorField>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={relation.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          启用关系
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={relation.required}
            onChange={(event) => onChange({ required: event.target.checked })}
          />
          必须存在目标记录
        </label>
      </div>
    </div>
  );
}

function DataPage({
  source,
  tables,
  onState,
  onError,
}: {
  source: BootstrapPayload["dataSource"];
  tables: PhysicalTable[];
  onState: React.Dispatch<React.SetStateAction<BootstrapPayload | null>>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(!source.configured);
  const [scanning, setScanning] = useState(false);
  async function scan() {
    setScanning(true);
    try {
      const result = await api.scanSchema();
      onState((previous) => (previous ? { ...previous, tables: result.tables } : previous));
    } catch (reason) {
      onError(asMessage(reason));
    } finally {
      setScanning(false);
    }
  }
  return (
    <div className="management-content">
      <section className="connection-card">
        <div className="connection-icon">
          <Database size={24} weight="duotone" />
        </div>
        <div className="connection-main">
          <div>
            <span className="section-kicker">SelectDB · MySQL Protocol</span>
            <h2>{source.configured ? source.database : "尚未配置业务库"}</h2>
          </div>
          {source.configured ? (
            <div className="connection-meta">
              <span><CheckCircle size={16} weight="fill" /> 已连接</span>
              <small>{source.username}@{source.host}:{source.port}</small>
            </div>
          ) : (
            <span className="status-pill warning">需要配置</span>
          )}
        </div>
        <button className="secondary-button" onClick={() => setEditing(true)}>
          {source.configured ? "修改连接" : "配置连接"}
        </button>
      </section>
      <div className="data-toolbar">
        <div>
          <h2>Schema 目录</h2>
          <p>扫描只读取元数据，不会自动创建或覆盖本体。</p>
        </div>
        <button
          className="primary-button"
          disabled={!source.configured || scanning}
          onClick={() => void scan()}
        >
          <ArrowClockwise size={17} className={scanning ? "rotating" : ""} />
          {scanning ? "扫描中…" : "扫描 Schema"}
        </button>
      </div>
      <section className="panel table-catalog">
        <table>
          <thead>
            <tr>
              <th>表对象</th>
              <th>类型</th>
              <th>预估行数</th>
              <th>建模状态</th>
              <th>最近扫描</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((table) => (
              <tr key={table.id}>
                <td>
                  <span className="table-name">
                    <Table size={17} />
                    <span><strong>{table.name}</strong><small>{table.description}</small></span>
                  </span>
                </td>
                <td>{table.type}</td>
                <td>{table.rowEstimate?.toLocaleString() ?? "—"}</td>
                <td><TableStatus status={table.status} /></td>
                <td>{new Date(table.scannedAt).toLocaleDateString("zh-CN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editing && (
        <DataSourceDialog
          source={source}
          onClose={() => setEditing(false)}
          onSaved={(config) => {
            onState((previous) => (previous ? { ...previous, dataSource: config } : previous));
            setEditing(false);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function DataSourceDialog({
  source,
  onClose,
  onSaved,
  onError,
}: {
  source: BootstrapPayload["dataSource"];
  onClose: () => void;
  onSaved: (source: BootstrapPayload["dataSource"]) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<DataSourceInput>({
    host: source.host ?? "",
    port: source.port ?? 9030,
    username: source.username ?? "",
    password: "",
    catalog: source.catalog ?? "internal",
    database: source.database ?? "",
    tls: source.tls ?? false,
  });
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState("");
  const update = <K extends keyof DataSourceInput>(key: K, value: DataSourceInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  async function test() {
    setTesting(true);
    setTested("");
    try {
      const result = await api.testDataSource(form);
      setTested(`连接成功 · ${result.version}`);
    } catch (reason) {
      onError(asMessage(reason));
    } finally {
      setTesting(false);
    }
  }
  async function save() {
    try {
      const result = await api.saveDataSource(form);
      onSaved(result.config);
    } catch (reason) {
      onError(asMessage(reason));
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="source-title">
        <div className="dialog-heading">
          <div>
            <span className="section-kicker">阿里云版 Doris</span>
            <h2 id="source-title">配置 SelectDB</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </div>
        <p className="dialog-note">
          Windows 使用当前用户的 DPAPI 加密保存密码，macOS 使用系统钥匙串；SQLite
          只保留非敏感连接参数。
        </p>
        <div className="form-grid">
          <Field label="主机地址" wide>
            <input value={form.host} onChange={(e) => update("host", e.target.value)} placeholder="selectdb.example.com" />
          </Field>
          <Field label="端口">
            <input type="number" value={form.port} onChange={(e) => update("port", Number(e.target.value))} />
          </Field>
          <Field label="Catalog">
            <input value={form.catalog} onChange={(e) => update("catalog", e.target.value)} />
          </Field>
          <Field label="用户名">
            <input value={form.username} onChange={(e) => update("username", e.target.value)} />
          </Field>
          <Field label="密码">
            <input type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder={source.passwordStored ? "留空则沿用已保存密码" : "请输入密码"} />
          </Field>
          <Field label="业务 Database" wide>
            <input value={form.database} onChange={(e) => update("database", e.target.value)} placeholder="retail_analytics" />
          </Field>
        </div>
        {tested && <div className="test-success"><CheckCircle size={17} weight="fill" /> {tested}</div>}
        <div className="dialog-actions">
          <button className="secondary-button" onClick={() => void test()} disabled={testing || !form.password}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button className="primary-button" onClick={() => void save()}>保存配置</button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={wide ? "wide" : ""}><span>{label}</span>{children}</label>;
}

function AuditPage({ conversations }: { conversations: Conversation[] }) {
  const turns = conversations.flatMap((conversation) =>
    conversation.turns.map((turn) => ({ conversation, turn })),
  );
  return (
    <div className="management-content">
      <section className="panel audit-list">
        <div className="panel-heading">
          <div><span className="section-kicker">逐轮可追溯</span><h2>分析运行记录</h2></div>
          <span className="count-badge">{turns.length}</span>
        </div>
        {turns.map(({ conversation, turn }) => (
          <div className="audit-row" key={turn.id}>
            <span className="audit-icon"><Clock size={18} /></span>
            <span className="audit-main">
              <strong>{turn.question}</strong>
              <small>{conversation.title} · {formatFullTime(turn.createdAt)}</small>
            </span>
            <span className="audit-version">本体 v{turn.ontologyVersion}</span>
            <span>{turn.trace.length} 步</span>
            <StatusBadge status={turn.status} />
            <CaretRight size={17} />
          </div>
        ))}
      </section>
    </div>
  );
}

function SettingsPage({
  runtime,
  config,
  valueIndex,
  onState,
  onError,
}: {
  runtime: BootstrapPayload["runtime"];
  config: BootstrapPayload["agentConfig"];
  valueIndex: BootstrapPayload["valueIndex"];
  onState: React.Dispatch<React.SetStateAction<BootstrapPayload | null>>;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    businessInstructions: config.businessInstructions,
    timezone: config.timezone,
  });
  const [saving, setSaving] = useState(false);
  const [indexing, setIndexing] = useState(valueIndex.status === "building");
  const [indexProperties, setIndexProperties] = useState<
    PropertyValueIndexProperty[]
  >([]);
  const [indexDetailsLoading, setIndexDetailsLoading] = useState(true);
  const [indexSearch, setIndexSearch] = useState("");
  useEffect(() => {
    let cancelled = false;
    setIndexDetailsLoading(true);
    api
      .valueIndexProperties()
      .then((result) => {
        if (!cancelled) setIndexProperties(result.properties);
      })
      .catch((reason) => {
        if (!cancelled) onError(asMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setIndexDetailsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError, valueIndex.ontologyVersion, valueIndex.updatedAt]);
  useEffect(() => {
    if (!indexing) return;
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.valueIndexStatus();
        if (cancelled) return;
        onState((previous) =>
          previous ? { ...previous, valueIndex: result.status } : previous,
        );
        if (result.status.status !== "building") setIndexing(false);
      } catch (reason) {
        if (cancelled) return;
        setIndexing(false);
        onError(asMessage(reason));
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [indexing, onError, onState]);
  async function save() {
    setSaving(true);
    try {
      const result = await api.saveAgentConfig(form);
      onState((previous) =>
        previous ? { ...previous, agentConfig: result.config } : previous,
      );
    } catch (reason) {
      onError(asMessage(reason));
    } finally {
      setSaving(false);
    }
  }
  async function rebuildIndex() {
    setIndexing(true);
    try {
      const result = await api.rebuildValueIndex();
      onState((previous) =>
        previous ? { ...previous, valueIndex: result.status } : previous,
      );
    } catch (reason) {
      onError(asMessage(reason));
      setIndexing(false);
    }
  }
  const normalizedIndexSearch = indexSearch.trim().toLocaleLowerCase("zh-CN");
  const visibleIndexProperties = indexProperties.filter((property) => {
    if (!normalizedIndexSearch) return true;
    return [
      property.objectLabel,
      property.propertyLabel,
      property.sourceColumn,
      property.semanticMeaning,
      ...property.topValues.map((value) => value.value),
    ].some((value) =>
      value.toLocaleLowerCase("zh-CN").includes(normalizedIndexSearch),
    );
  });
  return (
    <div className="management-content settings-grid">
      <section className="panel agent-config-panel">
        <div className="agent-config-heading">
          <div>
            <h2>Montane业务指令</h2>
            <p>核心安全协议和IR输出格式固定生效，这里只补充当前工作区的业务解释规则。</p>
          </div>
          <span className="status-pill">版本 {config.version}</span>
        </div>
        <label className="setting-field">
          <span>业务指令</span>
          <textarea
            rows={6}
            value={form.businessInstructions}
            placeholder="例如：销售额默认指支付成功订单的实付金额；自然年按北京时间解释。"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                businessInstructions: event.target.value,
              }))
            }
          />
          <small>不能覆盖只读查询、敏感字段和已发布本体约束。</small>
        </label>
        <div className="agent-config-actions">
          <label className="setting-field compact">
            <span>业务时区</span>
            <select
              value={form.timezone}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  timezone: event.target.value,
                }))
              }
            >
              <option value="Asia/Shanghai">Asia/Shanghai</option>
              <option value="UTC">UTC</option>
              <option value="Asia/Hong_Kong">Asia/Hong_Kong</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
            </select>
          </label>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void save()}
          >
            <FloppyDisk size={16} /> {saving ? "保存中…" : "保存业务指令"}
          </button>
        </div>
      </section>
      <section className="panel value-index-section">
        <div className="value-index-panel">
          <div className="setting-icon"><MagnifyingGlass size={20} /></div>
          <div>
            <h2>属性值索引</h2>
            <p>
              本体 v{valueIndex.ontologyVersion} · {valueIndex.indexedProperties} 个属性 ·
              {" "}{valueIndex.indexedValues.toLocaleString()} 个值
              {valueIndex.partialProperties
                ? ` · ${valueIndex.partialProperties} 个高基数字段仅保留高频值`
                : ""}
            </p>
            {valueIndex.error && <small className="setting-error">{valueIndex.error}</small>}
          </div>
          <div className="value-index-actions">
            <span className={`status-pill ${valueIndexStatusTone(valueIndex.status)}`}>
              {valueIndexStatusLabel(valueIndex.status)}
            </span>
            <button
              className="secondary-button"
              disabled={indexing}
              onClick={() => void rebuildIndex()}
            >
              <ArrowClockwise size={16} className={indexing ? "rotating" : ""} />
              {indexing ? "构建中" : "重建索引"}
            </button>
          </div>
        </div>
        <details className="index-detail-panel" open>
          <summary>
            <span><CaretRight size={14} /> 索引明细</span>
            <small>{indexProperties.length} 个属性有构建记录</small>
          </summary>
          <div className="index-rule-line">
            <strong>索引规则</strong>
            <span>仅发布本体</span>
            <span>允许值检索</span>
            <span>排除敏感与隐藏属性</span>
            <span>每个属性保留频次最高的 5,000 个值</span>
            <span>查询时全局精确值优先，词形候选只参与排序</span>
          </div>
          <div className="index-detail-toolbar">
            <label>
              <MagnifyingGlass size={15} />
              <input
                aria-label="筛选索引明细"
                value={indexSearch}
                placeholder="搜索对象、属性、字段或样例值"
                onChange={(event) => setIndexSearch(event.target.value)}
              />
            </label>
            <span>
              {indexDetailsLoading
                ? "正在读取…"
                : `显示 ${visibleIndexProperties.length} / ${indexProperties.length}`}
            </span>
          </div>
          <div className="index-table-scroll">
            <table className="index-detail-table">
              <thead>
                <tr>
                  <th>对象</th>
                  <th>属性与字段</th>
                  <th>分类</th>
                  <th>索引覆盖</th>
                  <th>高频样例值</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {visibleIndexProperties.map((property) => (
                  <tr key={property.propertyId}>
                    <td>
                      <strong>{property.objectLabel}</strong>
                      <small>{property.objectId}</small>
                    </td>
                    <td>
                      <strong>{property.propertyLabel}</strong>
                      <small>{property.sourceColumn} · {property.propertyId}</small>
                    </td>
                    <td>{propertyMeaningLabel(property.semanticMeaning)}</td>
                    <td>
                      <strong>{property.distinctValues.toLocaleString()} 个值</strong>
                      <small>覆盖频次 {property.coveredRows.toLocaleString()}</small>
                    </td>
                    <td>
                      <div className="index-value-list">
                        {property.topValues.length
                          ? property.topValues.map((value) => (
                              <span key={value.value}>
                                {value.value}<small>{value.frequency.toLocaleString()}</small>
                              </span>
                            ))
                          : <small>没有可索引值</small>}
                      </div>
                    </td>
                    <td>
                      <span className={`status-pill ${indexPropertyStatusTone(property.status)}`}>
                        {indexPropertyStatusLabel(property.status)}
                      </span>
                      {property.error && <small className="setting-error">{property.error}</small>}
                    </td>
                  </tr>
                ))}
                {!indexDetailsLoading && !visibleIndexProperties.length && (
                  <tr>
                    <td colSpan={6} className="index-empty">
                      {indexProperties.length
                        ? "没有匹配的索引属性或样例值"
                        : "尚无属性级索引记录，请先重建索引"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section className="panel setting-card">
        <div className="setting-icon"><Brain size={20} /></div>
        <div>
          <h2>真实问数链路</h2>
          <p>
            {runtime.analysisReady
              ? `SelectDB 与 Montane 已就绪，当前使用 ${runtime.provider || "已配置 provider"} / ${runtime.model || "默认模型"}。`
              : runtime.modelConfigured
                ? `Montane 已加载 ${runtime.provider || "模型运行时"}，请确认 SelectDB 连接与本体已发布。`
                : runtime.modelError || "Montane CLI 模型运行时不可用；InsightFlow 不要求单独配置模型密钥。"}
          </p>
        </div>
        <span className={`status-pill ${runtime.analysisReady ? "success" : "warning"}`}>
          {runtime.analysisReady ? "已就绪" : "待配置"}
        </span>
      </section>
      <section className="panel setting-card">
        <div className="setting-icon"><Clock size={20} /></div>
        <div><h2>IR查询执行</h2><p>IR v2 支持时间粒度、同比环比、派生与窗口计算、逻辑筛选树和聚合安全校验；最大超时180秒，聚合最多200行，明细最多50行。</p></div>
        <span className="status-pill success">已启用</span>
      </section>
      <section className="panel setting-card">
        <div className="setting-icon"><SealCheck size={20} /></div>
        <div><h2>安全策略</h2><p>Montane不持有SQL工具，只能提交本体ID和结构化分析意图。</p></div>
        <span className="status-pill success">强制</span>
      </section>
      <section className="panel setting-card">
        <div className="setting-icon"><Database size={20} /></div>
        <div><h2>本地存储</h2><p>本体、版本和追踪记录保存在当前工作区 .montane 目录。</p></div>
        <span className="status-pill">SQLite</span>
      </section>
    </div>
  );
}

function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof ChartBar }) {
  return (
    <div className="stat-card">
      <span className="stat-icon"><Icon size={20} /></span>
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function TableStatus({ status }: { status: PhysicalTable["status"] }) {
  const labels: Record<PhysicalTable["status"], string> = {
    UNMODELED: "待建模",
    DRAFTING: "草稿中",
    MODELED: "已建模",
    CHANGED: "结构变更",
    IGNORED: "已忽略",
    REMOVED: "已移除",
  };
  return <span className={`table-status ${status.toLowerCase()}`}>{labels[status]}</span>;
}

function StatusBadge({ status }: { status: Turn["status"] }) {
  const label =
    status === "completed"
      ? "已完成"
      : status === "failed"
        ? "失败"
        : status === "needs_clarification"
          ? "待补充"
          : "执行中";
  return <span className={`turn-status ${status}`}>{label}</span>;
}

const OBJECT_TYPES: OntologyObject["objectType"][] = [
  "ENTITY",
  "EVENT",
  "SNAPSHOT",
  "AGGREGATE",
  "RELATIONSHIP",
];

const PROPERTY_MEANINGS: OntologyObject["properties"][number]["meaning"][] = [
  "ID",
  "CODE",
  "NAME",
  "ENTITY_REFERENCE",
  "CATEGORY",
  "TIME",
  "NUMBER",
  "BOOLEAN",
  "GEOGRAPHY",
  "TEXT",
];

const RELATION_TYPES: OntologyRelation["type"][] = [
  "REFERENCE",
  "COMPOSITION",
  "ASSOCIATION",
  "HIERARCHY",
  "EVENT_PARTICIPATION",
  "IDENTITY",
  "DERIVED",
];

function splitTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function createClientId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function visualMetricExpression(metric: Metric, object: OntologyObject): string {
  const property = object.properties.find(
    (candidate) => candidate.id === metric.sourcePropertyId,
  );
  const field =
    metric.aggregation === "COUNT"
      ? "*"
      : property
        ? `\`${property.sourceColumn.replaceAll("`", "``")}\``
        : "";
  if (!field) return "";
  const filter = metric.filterExpression?.trim();
  if (!filter) {
    return metric.aggregation === "COUNT_DISTINCT"
      ? `COUNT(DISTINCT ${field})`
      : `${metric.aggregation}(${field})`;
  }
  if (metric.aggregation === "COUNT") {
    return `SUM(CASE WHEN ${filter} THEN 1 ELSE 0 END)`;
  }
  if (metric.aggregation === "COUNT_DISTINCT") {
    return `COUNT(DISTINCT CASE WHEN ${filter} THEN ${field} END)`;
  }
  return `${metric.aggregation}(CASE WHEN ${filter} THEN ${field} END)`;
}

function relationJoinExpression(
  sourceObject: OntologyObject,
  targetObject: OntologyObject,
  sourcePropertyId: string | undefined,
  targetPropertyId: string | undefined,
  sourceTable?: PhysicalTable,
  targetTable?: PhysicalTable,
): string {
  const sourceProperty = sourceObject.properties.find(
    (property) => property.id === sourcePropertyId,
  );
  const targetProperty = targetObject.properties.find(
    (property) => property.id === targetPropertyId,
  );
  if (!sourceProperty || !targetProperty) return "";
  return `${sourceTable?.name ?? sourceObject.name}.${sourceProperty.sourceColumn} = ${targetTable?.name ?? targetObject.name}.${targetProperty.sourceColumn}`;
}

function propertyVisibilityLabel(
  visibility: OntologyObject["properties"][number]["visibility"],
): string {
  return {
    ANALYTICAL: "分析属性",
    DETAIL_ONLY: "仅明细展示",
    HIDDEN: "完全隐藏",
  }[visibility];
}

function objectTypeLabel(type: OntologyObject["objectType"]): string {
  return {
    ENTITY: "业务实体",
    EVENT: "业务事件",
    SNAPSHOT: "状态快照",
    AGGREGATE: "汇总结果",
    RELATIONSHIP: "关联记录",
  }[type];
}

function propertyMeaningLabel(
  type: OntologyObject["properties"][number]["meaning"],
): string {
  return {
    ID: "ID",
    CODE: "编号",
    NAME: "名称",
    ENTITY_REFERENCE: "关联实体",
    CATEGORY: "分类",
    TIME: "时间",
    NUMBER: "数字",
    BOOLEAN: "布尔值",
    GEOGRAPHY: "地理位置",
    TEXT: "文本",
  }[type];
}

function defaultNumericSpec(): NonNullable<
  OntologyObject["properties"][number]["numericSpec"]
> {
  return {
    kind: "GENERAL",
    defaultAggregation: "NONE",
    aggregationBehavior: "NON_ADDITIVE",
  };
}

function isValueSearchableMeaning(
  meaning: OntologyObject["properties"][number]["meaning"],
): boolean {
  return ["CODE", "NAME", "CATEGORY", "BOOLEAN", "GEOGRAPHY"].includes(meaning);
}

function defaultValueSearchableForMeaning(
  meaning: OntologyObject["properties"][number]["meaning"],
): boolean {
  return isValueSearchableMeaning(meaning);
}

function effectiveGrainLabel(object: OntologyObject): string {
  const idProperty = object.properties.find((property) => property.meaning === "ID");
  const ids = idProperty ? [idProperty.id] : object.grainPropertyIds;
  const labels = ids
    .map((id) => object.properties.find((property) => property.id === id)?.label)
    .filter(Boolean);
  if (!labels.length) return "尚未配置";
  return labels.length === 1
    ? `一行由“${labels[0]}”唯一确定`
    : `一行由“${labels.join(" × ")}”共同确定`;
}

function propertyConstraintLabel(
  property: OntologyObject["properties"][number],
  object: OntologyObject,
): string {
  if (property.meaning === "ID") return "唯一 ID";
  if (object.grainPropertyIds.includes(property.id)) return "构成行级粒度";
  if (property.meaning === "NUMBER" && property.numericSpec) {
    return `${numericKindLabel(property.numericSpec.kind)} · ${aggregationBehaviorLabel(
      property.numericSpec.aggregationBehavior,
    )}`;
  }
  if (property.unique) return "唯一";
  if (property.valueSearchable) return "可定位属性值";
  return "无额外约束";
}

function numericKindLabel(
  kind: NonNullable<OntologyObject["properties"][number]["numericSpec"]>["kind"],
): string {
  return {
    GENERAL: "一般数字",
    CURRENCY: "货币",
    RATIO: "比率",
  }[kind];
}

function aggregationBehaviorLabel(
  behavior: NonNullable<
    OntologyObject["properties"][number]["numericSpec"]
  >["aggregationBehavior"],
): string {
  return {
    ADDITIVE: "可加",
    SEMI_ADDITIVE: "半可加",
    NON_ADDITIVE: "不可加",
  }[behavior];
}

function relationTargetLabel(
  propertyId: string,
  objectId: string,
  relations: OntologyRelation[],
  ontology: OntologySnapshot,
): string {
  const relation = relations.find(
    (candidate) =>
      candidate.sourceObjectId === objectId &&
      candidate.sourcePropertyId === propertyId,
  );
  return relation
    ? `关联 ${ontology.objects.find((object) => object.id === relation.targetObjectId)?.label ?? "未知对象"}`
    : "待选择目标对象";
}

function relationTypeLabel(type: OntologyRelation["type"]): string {
  return {
    REFERENCE: "引用",
    COMPOSITION: "组成",
    ASSOCIATION: "关联",
    HIERARCHY: "层级",
    EVENT_PARTICIPATION: "事件参与",
    IDENTITY: "身份映射",
    DERIVED: "派生",
  }[type];
}

function ontologyStatusLabel(status: OntologySnapshot["status"]): string {
  const labels: Record<OntologySnapshot["status"], string> = {
    DRAFT: "草稿",
    VERIFIED: "已校验",
    PUBLISHED: "已发布",
    DEPRECATED: "已停用",
  };
  return labels[status];
}

function cardinalityLabel(
  cardinality: OntologySnapshot["relations"][number]["cardinality"],
): string {
  const labels: Record<typeof cardinality, string> = {
    ONE_TO_ONE: "1:1",
    ONE_TO_MANY: "1:N",
    MANY_TO_ONE: "N:1",
    MANY_TO_MANY: "N:N",
  };
  return labels[cardinality];
}

function valueIndexStatusLabel(
  status: BootstrapPayload["valueIndex"]["status"],
): string {
  return {
    idle: "尚未构建",
    building: "构建中",
    ready: "已就绪",
    partial: "部分可用",
    failed: "构建失败",
  }[status];
}

function valueIndexStatusTone(
  status: BootstrapPayload["valueIndex"]["status"],
): string {
  if (status === "ready") return "success";
  if (status === "building" || status === "partial") return "warning";
  return "";
}

function indexPropertyStatusLabel(
  status: PropertyValueIndexProperty["status"],
): string {
  return {
    ready: "已索引",
    partial: "高频截断",
    empty: "无值",
    failed: "失败",
  }[status];
}

function indexPropertyStatusTone(
  status: PropertyValueIndexProperty["status"],
): string {
  if (status === "ready") return "success";
  if (status === "partial" || status === "empty") return "warning";
  return "danger";
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="toast" role="alert">
      <Warning size={18} weight="fill" />
      <span>{message}</span>
      <button onClick={onClose} aria-label="关闭"><X size={16} /></button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="brand-mark"><Sparkle size={24} weight="fill" /></div>
      <strong>InsightFlow</strong>
      <span>正在加载可信语义工作区…</span>
    </div>
  );
}

function FatalState({ message }: { message: string }) {
  return (
    <div className="loading-screen fatal">
      <Warning size={30} />
      <strong>无法启动 InsightFlow</strong>
      <span>{message}</span>
      <button className="primary-button" onClick={() => location.reload()}>重新加载</button>
    </div>
  );
}

function upsertTurn(conversation: Conversation, turn: Turn): Conversation {
  const turns = [...conversation.turns];
  const index = turns.findIndex((item) => item.id === turn.id);
  if (index >= 0) turns[index] = turn;
  else turns.push(turn);
  return { ...conversation, turns, updatedAt: new Date().toISOString() };
}

function isTerminal(status: Turn["status"]): boolean {
  return ["completed", "failed", "cancelled", "needs_clarification"].includes(status);
}

function asMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请稍后重试";
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
