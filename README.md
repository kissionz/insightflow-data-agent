# InsightFlow Data Agent

InsightFlow 是一个面向阿里云 SelectDB 的本地优先 Data Agent。它在一个桌面
Web 工作区中组合了本体语义层、受保护的只读 SQL、多轮分析，以及逐轮独立的
分析证据链。

已确认的完整产品实现文档位于
[`docs/product-spec.md`](docs/product-spec.md).

## 本地开发

```bash
npm install
npm run dev
```

Web 应用运行在 `http://127.0.0.1:4311`，本地 API 运行在
`http://127.0.0.1:4310`。

`montane-code` 固定到 GitHub 上经过验证的 commit。`npm install` 会自动下载并
执行 SDK 构建；`dev`、`build`、`start` 和 `test` 前还会运行依赖检查：

- 当前项目已经安装且 Harness 导出完整：直接复用。
- 本机存在 `MONTANE_CODE_PATH`、同级 `data-engineer` 或全局安装：发现后接入。
- 都不存在：从 GitHub 自动安装固定版本，并输出可执行的错误提示。

首次启动为空工作区，不会预置业务表、本体对象、会话或分析结果。先在「数据
管理」配置真实 SelectDB 连接并扫描 Schema，再到「本体」选择未建模表生成
草稿。Windows 通过 `ProtectedData` 使用当前用户的 DPAPI 加密保存密码，支持
Unicode 路径和密码；macOS 使用系统钥匙串。也可以通过 `SELECTDB_PASSWORD`
环境变量注入密码。本体、版本和会话保存在：

```text
<workspace>/.montane/data-agent/ontology.sqlite
```

每轮问数都通过完整 Montane Harness 执行：

```text
AgentLoop
  -> SessionManager / SessionStore
  -> ToolRegistry
      -> SubmitQuestionFrame
      -> OntologySearch
      -> PropertyValueSearch
      -> ExecuteAnalysisPlan
          -> Query IR
          -> Doris SQL Compiler
          -> SelectDB
  -> PermissionGate
  -> AgentReporter
```

InsightFlow 不单独配置或调用大模型。它通过 Montane SDK 读取与 CLI 完全相同
的用户配置、provider、模型、Base URL 和可信 env-file，再把所有理解、规划、
结果解释交给同一个 Montane AgentLoop。Montane 只提交引用已发布本体 ID 的
结构化分析意图；SQL 由确定性 IR 规则引擎编译，Montane 不持有 SQL 执行工具。只要 Montane CLI 本身能够
正常回答问题，SDK 会自动复用默认用户配置以及全局安装或 `npm link` 的 CLI
运行环境；InsightFlow 不要求再配置一份 API Key。

发布本体后，系统会在后台为允许值定位的非敏感属性构建按本体版本隔离的
SQLite 属性值索引。问数时先形成时间、指标、完整业务值等强类型语言框架，再在
全部可检索属性中寻找精确值。唯一命中会生成本轮不可改写的值绑定句柄；关联对象
筛选由 IR 编译为相关 `EXISTS`，不会把名称值错误写到事实表外键上。Ontology
词形候选只进入候选诊断，SelectDB 实时字段探测仅作为小范围兜底。「设置」页可检查每个对象
属性的索引状态、物理字段、值数量、覆盖频次和高频样例值。
「设置」页可以维护带版本号的工作区业务指令和业务时区，核心安全协议不可修改。

SelectDB 或 Montane 运行条件不完整时会明确指出原因，不会生成固定图表、示例
数据或虚构结论。每轮仍保留完整追踪，未执行的语义与 SQL 步骤会标记为“未执行”。
`.montane/sessions/` 中会保留原始 Harness 事件记录；「设置」页会显示实际复用
的 Montane provider 与模型。

## 验证

```bash
npm run build
npm test
```
