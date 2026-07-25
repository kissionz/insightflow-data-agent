# InsightFlow Data Agent

InsightFlow 是一个面向阿里云 SelectDB 的本地优先 Data Agent。它在一个桌面
Web 工作区中组合了本体语义层、受保护的只读 SQL、多轮分析，以及逐轮独立的
推理与查询追踪。

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
草稿。Windows 使用当前用户的 DPAPI 加密保存密码，macOS 使用系统钥匙串；
也可以通过 `SELECTDB_PASSWORD` 环境变量注入密码。本体、版本和会话保存在：

```text
<workspace>/.montane/data-agent/ontology.sqlite
```

每轮问数都通过完整 Montane Harness 执行：

```text
AgentLoop
  -> SessionManager / SessionStore
  -> ToolRegistry
      -> OntologySearch
      -> SelectDBQuery
  -> PermissionGate
  -> AgentReporter
```

配置 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 SelectDB 后才允许真实查询。一般
对话仍通过 AgentLoop 返回文本响应；分析运行条件不完整时会明确指出缺失配置，
不会生成固定图表、示例数据或虚构结论。每轮仍保留完整追踪，未执行的语义与
SQL 步骤会标记为“未执行”。`.montane/sessions/` 中会保留原始 Harness 事件记录。

## 验证

```bash
npm run build
npm test
```
