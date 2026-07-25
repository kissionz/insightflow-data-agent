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

首次启动会创建一个本地演示工作区。可在「数据管理」中配置真实 SelectDB
连接；密码只写入 macOS 钥匙串。本体、版本和会话保存在：

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

配置 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 SelectDB 后进入真实查询模式。未配置
模型或数据源时仍通过同一 AgentLoop 和工具链运行演示模型，不会把示例结果
标记成真实查询。`.montane/sessions/` 中会保留原始 Harness 事件记录。

## 验证

```bash
npm run build
npm test
```
