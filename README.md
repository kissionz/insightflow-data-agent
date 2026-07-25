# InsightFlow Data Agent

InsightFlow 是一个面向阿里云 SelectDB 的本地优先 Data Agent。它在一个桌面
Web 工作区中组合了本体语义层、受保护的只读 SQL、多轮分析，以及逐轮独立的
推理与查询追踪。

已确认的完整产品实现文档位于
[`docs/product-spec.md`](docs/product-spec.md).

## Local development

```bash
npm install
npm run dev
```

The web app runs at `http://127.0.0.1:4311`. The local API runs at
`http://127.0.0.1:4310`.

首次启动会创建一个本地演示工作区。可在「数据管理」中配置真实 SelectDB
连接；密码只写入 macOS 钥匙串。本体、版本和会话保存在：

```text
<workspace>/.montane/data-agent/ontology.sqlite
```

配置 `OPENAI_API_KEY` 与 `OPENAI_MODEL` 后，真实问数使用 `montane-code`
提供的模型适配器生成语义查询计划；未配置模型或数据源时，应用保持示例模式，
不会把示例结果伪装为真实查询。

## Validation

```bash
npm run build
npm test
```
