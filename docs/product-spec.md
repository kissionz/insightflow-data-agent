# InsightFlow Data Agent MVP 产品实现文档

版本：1.6

状态：MVP 核心链路已实现，进入真实业务迭代
日期：2026-07-28
目标终端：桌面 Web  
目标用户：本地单用户  
数据平台：阿里云 SelectDB  
默认语言：简体中文

## 1. 文档目的

本文档是 InsightFlow Data Agent MVP 的产品、交互、语义模型、技术架构和验收基准。后续实现必须以本文档为唯一产品基线。需求发生变化时，先更新本文档并确认，再修改实现。

## 2. 产品定义

InsightFlow 是基于现有 Montane Code Agent Runtime 构建的本地 Data Agent 网页应用。

用户通过自然语言提出业务问题。系统基于已发布的 Ontology 理解业务对象、指标、维度和关系，通过强类型 IR 编译 SelectDB SQL，执行安全校验，返回分析结论、图表和明细数据，并为每轮对话保存完整分析证据链。

### 2.1 核心价值

- 业务问题通过统一语义口径转换为查询。
- 每个结果都能追溯到 Ontology、关系路径和 SQL。
- 多轮追问可以继承上下文，但每轮保留独立审计记录。
- 查询受到只读、超时、行数、对象和敏感字段约束。
- 用户问数页面专注分析，不暴露数据源连接信息。

### 2.2 成功标准

1. 用户可以连续提出自然语言数据问题。
2. 系统能正确绑定已发布的指标、维度和对象。
3. 系统只能执行符合安全约束的只读查询。
4. 每轮对话都有完整、持久化的分析证据链。
5. 查询完成后优先展示结论、图表和数据表。
6. 历史会话重新打开后，结果和追踪仍可查看。
7. 多轮追问能明确显示继承、增加、修改和移除的条件。
8. 新增物理表不会触发已发布 Ontology 的全量重建。
9. 未指定单一指标的开放问题可以在一个受控事实对象内执行多步分析，并保留每步证据。

## 3. 已确认的产品决策

| 决策项 | 已确认方案 |
|---|---|
| 使用模式 | 本地优先、单用户、单工作区 |
| 数据源数量 | 一个 SelectDB 实例 |
| 业务库数量 | 一个业务 Database |
| 数据协议 | MySQL 网络协议，使用 SelectDB 方言适配 |
| 查询权限 | 只允许用户发起 `SELECT` 或 `WITH ... SELECT` |
| 查询超时 | 180 秒 |
| 最大返回行数 | 10,000 行 |
| 普通查询 | 自动执行，SQL 在本轮追踪中可查看 |
| 当前周期 | “今年、本月、本季度、本周”截止到当前日期；同比、环比使用同进度基期 |
| 高风险查询 | 必须审批 |
| 数据源配置 | Web 配置，密码保存到系统密钥链 |
| 问数页面 | 不展示任何数据源信息 |
| Ontology 建模 | 扫描后由用户勾选未建模表，增量生成草稿 |
| Ontology 编辑 | 发布版只读；任何修改先克隆为隔离草稿 |
| 属性建模 | 字段含义直接约束检索和 SQL；ID、关联实体、数字规则与可见性边界明确 |
| 属性可见性 | 分析可用、仅明细、完全隐藏三档 |
| 指标定义 | 独立指标目录；支持属性聚合基础指标与同事实对象内的强类型复合指标 |
| Ontology 存储 | 本地 SQLite |
| Ontology 检索 | 发布时编译本地语义索引 |
| 追踪模型 | 每轮对话独立追踪 |
| 模型可见聚合结果 | 最多 200 行 |
| 模型可见明细结果 | 最多 50 行 |
| 敏感字段 | 脱敏后才可发送给模型 |
| 界面语言 | 简体中文 |
| 设计基准 | 1440px 桌面端 |

## 4. MVP 范围

### 4.1 包含

- 新建、重命名、删除和恢复分析会话
- 多轮自然语言问数
- Montane 驱动的单事实对象多步开放分析与原因诊断
- Agent 流式输出与任务状态
- SelectDB 连接测试和元数据扫描
- 用户勾选物理表进行增量 Ontology 建模
- Object、Property、Relation、Metric、Dimension、Policy、Synonym 和 Lineage
- Ontology 草稿、验证、发布、回滚和停用
- 本地语义检索和关系路径选择
- SelectDB SQL 生成、安全检查、执行和取消
- 每轮问题理解、语义绑定、查询 IR、SQL 和结果证据
- KPI、趋势图、柱状图、排名图和数据表
- CSV 导出
- 本地持久化
- Token、成本、查询和审批审计

### 4.2 不包含

- 登录、组织、多租户和团队协作
- 多 SelectDB 实例
- 多业务库联合查询
- 移动端完整体验
- 仪表盘搭建器
- 定时报表和消息订阅
- 数据写回
- 用户自由执行任意 SQL
- 图数据库
- OWL 或 RDF 完整兼容
- 自动跨系统实体合并
- 实时协同编辑
- 企业级行列权限管理界面

## 5. 核心用户流程

### 5.1 数据源配置

1. 用户进入“数据管理”。
2. 填写 Host、Port、Username、Password、Catalog、Database 和 TLS 配置。
3. 非敏感连接配置保存到本地配置文件。
4. Password 保存到操作系统密钥链。
5. 系统测试连接和权限。
6. 连接成功后允许扫描业务库。

数据源配置、连接状态和凭据不进入问数页面。

### 5.2 Schema 扫描与增量建模

1. 扫描选定业务 Database 中账号可见的表、视图和字段。
2. 排除 `information_schema`、`mysql`、`__internal_schema` 等系统对象。
3. 生成本次物理 Schema 快照。
4. 与上一次快照对比。
5. 将表分类为未建模、建模中、已建模、有变更、已忽略或已下线。
6. 用户从未建模表中勾选目标表。
7. Agent 推荐创建新对象、补充已有对象、建立关系或忽略。
8. 用户确认后生成增量 Ontology 草稿。
9. 系统执行结构、关系、指标和样例查询验证。
10. 用户发布新 Ontology 版本。

新增表只进入未建模列表，不触发全量重建。

### 5.3 日常问数

1. 用户创建或打开会话。
2. 输入自然语言问题。
3. 系统创建独立 `turn_id`。
4. Agent 识别本轮意图和继承上下文。
5. Montane 先提交强类型问题语言框架：分析类型、时间、指标、对象、完整业务值、
   分组、计算方式和展现方式。分析类型分为明确指标问数、开放分析和原因诊断；
   具体商品名、组织名等业务值不能同时作为对象词。分析类型只生成验收契约，
   不限定固定执行链路或查询轮数。
6. Semantic Retriever 按语言角色匹配已发布 Ontology；完整业务值优先查询值索引。
7. 值索引生成本轮不可改写的 `valueBindingId`，Montane 只提交本体 ID、
   操作符和绑定句柄。
8. 系统根据问题类型生成确定性验收契约。明确问数验收指定结果、范围、数据库证据
   和完整性；开放分析验收整体表现、适用的时间变化和结构；原因诊断验收现象、
   基准和主要驱动。没有可用时间字段或诊断维度时，对应验收项标记为不适用。
9. Montane 提交最小必要的结构化计划；每条计划必须引用仍未满足的验收项，
   IR 规则引擎逐步解析绑定句柄、时间、关系路径和数据粒度。
10. 当前自然周期按截至当天解析；同比和环比由 IR 生成独立的同进度历史窗口。
11. Doris SQL Compiler 生成参数化 SelectDB SQL。
12. SQL Guard 执行只读、范围和行数检查。
13. 每条查询返回精简 observation 和更新后的验收契约。下一条查询只有在能够
    关闭证据缺口时才允许执行；所有类型共用查询预算。
14. 所有必需验收项满足后才能显示“分析完成”；预算耗尽或没有进展但仍有缺口时
    显示“部分完成”，并列出未验收项。系统返回综合结论、主结果图表和数据表。
15. 本轮分析证据链完整保存，最终业务绑定、候选诊断以及每一步 IR、SQL、结果
   分开展示。
16. 用户基于结果继续追问。

## 6. 信息架构

### 6.1 全局导航

固定宽度 68px：

- 对话
- 语义模型
- 数据管理
- 审计
- 设置

### 6.2 问数页面

| 区域 | 宽度 | 内容 |
|---|---:|---|
| 全局导航 | 68px | 产品级导航 |
| 会话列表 | 260px | 会话搜索、分组和历史 |
| 主工作区 | 弹性，最小 720px | 多轮问数、追踪、结果 |
| 上下文面板 | 235px | 本轮语义上下文 |

右侧上下文面板只展示：

- 当前指标及口径
- 维度
- 筛选条件
- 时间范围
- Ontology 对象
- 关系路径
- 查询粒度
- 返回行数限制

右侧上下文面板不展示：

- SelectDB 名称
- Host、Port、Username
- Cluster、Catalog 和 Database 连接信息
- 数据源连接状态
- 数据源切换控件

### 6.3 语义模型页面

包含：

- 物理表目录
- 未建模表选择
- 对象列表
- 对象属性编辑
- 对象关系图
- 指标目录
- 维度目录
- 术语和同义词
- 验证结果
- Ontology 版本历史

### 6.4 数据管理页面

包含：

- SelectDB 连接配置
- 连接测试
- Schema 扫描
- 扫描历史
- Schema 差异
- 表状态分组
- 敏感字段标记
- 忽略规则

## 7. 对话与分析证据链

### 7.1 基本结构

```text
Conversation
├── Turn 1
│   ├── User Message
│   ├── Assistant Response
│   ├── Trace
│   └── Result Artifact
├── Turn 2
│   ├── User Message
│   ├── Assistant Response
│   ├── Trace
│   └── Result Artifact
└── Composer
```

分析证据链属于每一轮，不固定展示在输入框上方。它展示可审计的结构化产物，
不展示模型隐藏思维过程。

### 7.2 展示行为

- 当前执行轮次：追踪自动展开并实时更新。
- 已完成轮次：追踪默认折叠，保留摘要。
- 失败轮次：自动展开到失败步骤。
- 澄清轮次：展示已识别信息和缺失信息。
- 输入框固定在页面底部。
- 后续轮次不能覆盖前一轮追踪。

### 7.3 每轮证据步骤

1. 问题理解
2. 语义绑定
3. 查询方案
4. 编译 SQL
5. 数据结果

每步保存摘要、结构化事实和来源；查询方案保存强类型 IR，SQL 步骤保存最终
SQL 与参数，数据结果保存行数、字段和截断状态。理解错误从意图层纠正，绑定
错误从本体候选纠正，SQL 不允许绕过 IR 直接修改。

多步分析产生的 SQL 在“编译 SQL”步骤中按真实执行顺序列出为 `SQL 1`、
`SQL 2` 等独立条目。每条均可展开查看完整参数化 SQL 和参数；后续查询不能覆盖
前一条 SQL。查询方案中的对应分析步骤同时显示 SQL 编号，建立目标与实际查询的
一一映射。

开放分析在“查询方案”步骤内追加展示 `AnalysisRun`：

```text
开放分析路径
  -> Step 1 总览：目标、选择依据、IR、SQL、结果
  -> Step 2 诊断：由 Step 1 observation 触发
  -> Step 3 佐证：由前一步真实变化触发
  -> Montane 综合结论
```

后一步不能覆盖前一步证据。失败重试也保留为独立步骤，便于定位计划或本体错误。

```ts
type TraceStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "waiting_for_approval"
  | "failed";
```

### 7.4 多轮继承

每轮保存：

- `parent_turn_id`
- 继承的指标
- 继承的维度
- 继承的筛选条件
- 本轮新增条件
- 本轮修改条件
- 本轮移除条件
- 使用的 Ontology 发布版本
- 最终关系路径
- 最终 SQL

### 7.5 无 SQL 轮次

解释指标、请求澄清或引用历史结果时仍生成追踪：

```text
本轮类型：指标解释
SQL：未执行
信息来源：已发布 Ontology
原因：用户询问指标口径
```

## 8. Ontology 领域模型

### 8.1 核心元素

| 元素 | 职责 |
|---|---|
| Object | 客户、订单、商品等业务对象 |
| Property | 对象属性及底层字段映射 |
| Relation | 对象之间的业务关系 |
| Metric | 可复用的统一业务指标 |
| Dimension | 时间、地区、渠道等分析维度 |
| AnalysisRun | 开放或诊断问题的一次受控多步分析运行 |
| AnalysisStep | 单条动态查询的目标、依据、IR、SQL、结果与状态 |
| Policy | 默认筛选、敏感字段和查询限制 |
| Synonym | 中文术语、别名和自然语言映射 |
| Lineage | 语义元素到表、字段和 SQL 的映射 |
| Version | Ontology 发布版本 |

### 8.2 关系类型

- `REFERENCE`
- `COMPOSITION`
- `ASSOCIATION`
- `HIERARCHY`
- `EVENT_PARTICIPATION`
- `IDENTITY`
- `DERIVED`

### 8.3 关系基数

- `ONE_TO_ONE`
- `ONE_TO_MANY`
- `MANY_TO_ONE`
- `MANY_TO_MANY`

### 8.4 底层映射类型

- `DIRECT_KEY`
- `BRIDGE_TABLE`
- `MULTI_HOP_PATH`
- `RULE_BASED`
- `MATERIALIZED`

### 8.5 MVP 关系限制

- `IDENTITY` 只允许人工确认。
- `DERIVED` 只支持虚拟定义，不自动物化。
- 时间关系只支持 `valid_from` 和 `valid_to`。
- 多条等价 Join 路径必须指定默认路径。
- 高扇出路径不能自动执行，必须澄清或审批。

### 8.6 Ontology 生命周期

```text
DRAFT -> VERIFIED -> PUBLISHED -> DEPRECATED
```

只有 `PUBLISHED` 版本可用于正式问数。每轮查询必须保存其使用的 `ontology_version_id`。

### 8.7 草稿隔离与发布

- 已发布版本在界面和运行时均为只读。
- 编辑已发布版本时，系统克隆完整快照并创建下一版本草稿。
- 草稿中的对象、属性、指标、关系和规则只写入草稿快照。
- 草稿不进入本地语义索引，也不发送给 Montane，不影响正在进行的问数。
- 同一工作区只保留一个活动草稿；新增物理表追加到该草稿，不重复复制已建模表。
- 放弃草稿会恢复其中新增表的未建模状态，不修改已发布版本。
- 从草稿删除对象时，同时移除其指标和关系，来源表恢复为未建模并可重新选择。
- 发布前必须通过对象类型、唯一 ID、行级粒度、数字聚合规则、关系端点和危险 SQL 校验。
- 发布成功后，新快照成为唯一运行版本并重建语义索引；旧发布版本继续保留为历史版本。

### 8.8 属性可见性

| 模式 | 本地语义索引 | 发送给 Montane | 查询结果展示 |
|---|---|---|---|
| `ANALYTICAL` 分析可用 | 是 | 是 | 可用于查询、筛选、分组和明细 |
| `DETAIL_ONLY` 仅明细 | 否 | 否 | 明细查询时由确定性代码自动追加 |
| `HIDDEN` 完全隐藏 | 否 | 否 | 不展示、不导出 |

`DETAIL_ONLY` 字段不会参与自然语言召回，也不会出现在给 Montane 的 Ontology 上下文中。仅当查询结果被判定为单对象明细、字段启用默认明细展示且 SQL 结构可安全改写时，系统才把它追加到投影列。聚合查询、多表歧义查询和复杂投影不会自动追加。

### 8.9 对象类型、ID 与行级粒度

| 对象类型 | 示例 | ID 规则 | 行级粒度 |
|---|---|---|---|
| `ENTITY` 业务实体 | 客户、商品、门店 | 必须且只能有一个 ID | ID 自动确定一行 |
| `EVENT` 业务事件 | 订单、支付、访问 | 最多一个 ID | 无 ID 时必须选择粒度字段 |
| `SNAPSHOT` 状态快照 | 库存日快照 | 不使用 ID | 实体、时间等字段共同确定 |
| `AGGREGATE` 汇总结果 | 门店日销售 | 不使用 ID | 分组维度共同确定 |
| `RELATIONSHIP` 关联记录 | 用户角色关系 | 不使用 ID | 至少两个关联实体共同确定 |

ID 只表达“当前对象是谁”。同一对象只能有一个逻辑 ID；订单号、会员号和外部系统编码属于“编号”，即使具有唯一性，也不能成为第二个 ID。指向其他对象的字段属于“关联实体”，必须通过 Relation 关联到目标对象的 ID。

`grainPropertyIds` 结构化记录一行数据由哪些字段唯一确定。对象已有 ID 时系统自动使用 ID；没有 ID 的事件、快照、汇总和关联记录必须显式配置。Montane 根据粒度选择 `COUNT(*)`、`COUNT(DISTINCT ...)`、预聚合字段和安全 Join，避免重复计算。

维度层级通过 `dimensionHierarchies` 独立描述可安全上卷和下钻的维度顺序，例如
“类目 → SPU → SKU”和“事业部 → 组织单元 → 店铺”。每一级引用已发布对象属性；
跨对象的相邻层级必须存在非高扇出、非多对多关系。维度层级不替代对象关系，而是
为每组 Top N、自然语言中的“下面一层”、开放分析下钻顺序和聚合安全提供规划依据。

### 8.10 字段含义与调用规则

字段分类只在会改变语义检索、SQL 生成、格式或校验时存在：

| 字段含义 | 系统行为 |
|---|---|
| ID | 当前对象唯一身份，作为关系默认目标 |
| 编号 | 精确业务查找，可附加唯一约束 |
| 名称 | 自然语言匹配和结果展示 |
| 关联实体 | 生成对象关系与 Join 路径 |
| 分类 | 筛选、分组和属性值定位 |
| 时间 | 时间范围、趋势、同比环比 |
| 数字 | 按数字子类型和聚合规则计算 |
| 布尔值 | 生成布尔条件，不参与数值聚合 |
| 地理位置 | 地域匹配、筛选和层级分析 |
| 文本 | 描述性展示，默认不参与聚合 |

数字属性统一使用 `NUMBER`，不再单独定义“数量”。数字规则包括：

- `GENERAL` 一般数字：分数、件数、温度、重量等。
- `CURRENCY` 货币：配置币种，为汇率换算和跨币种聚合预留约束。
- `RATIO` 比率：默认禁止直接求和。
- 聚合性质分为可加、半可加和不可加，并配置默认聚合方式与单位。
- 分析可用的 `NUMBER` 属性只要默认聚合不是 `NONE`，即可作为属性型度量进入
  指标角色检索。IR 使用本体配置的 `SUM`、`AVG`、`MIN` 或 `MAX` 编译 SQL，
  不要求为每个数字字段重复创建正式指标。
- 正式 Metric 用于过滤指标、比率、跨字段公式和其他需要独立治理的复杂口径；
  属性型度量不能绕过数字规则自由选择聚合方式。

### 8.11 属性值定位

本地语义索引分别返回对象、属性和指标，不再把属性命中折叠成对象命中。Montane 遇到“华东”“VIP”“上海门店”等具体业务值时调用 `PropertyValueSearch`：

1. 只搜索已发布、分析可用、非敏感且启用值定位的字段。
2. 发布 Ontology 后异步构建按版本隔离的 SQLite 属性值索引。
3. 问数时先对全部可检索属性执行全局精确值检索；Ontology 名称、同义词和分词
   候选仅参与结果排序，不得作为排除其他属性的硬过滤条件。
4. 两层均未命中时，最多对四个候选 SelectDB 列并发执行参数化、只读、限行查询。
5. 命中结果以对象、属性、值、频次、证据等级和优先级返回；唯一胜出项生成
   仅在本轮有效且不可改写的 `valueBindingId`。
6. 裁决顺序为：精确值、前缀值、完整名称、同义词、N-gram；证据等级相同时，
   仅在同一原文片段与同一语义角色内比较对象优先级、属性优先级和频次。
7. 最高证据与优先级仍相同时必须向用户澄清；不同语义角色的对象不得互相淘汰。
8. 每个属性最多索引 5,000 个高频值，超过上限标记为部分索引。
9. 查询结果按需写入本地缓存，不对高基数字段做无边界全量扫描。
10. 设置页展示每个属性的索引状态、来源对象、物理字段、不同值数量、覆盖频次、
   高频样例和失败原因，供本体建模人员核对。

`DETAIL_ONLY`、`HIDDEN` 和敏感字段禁止建立值索引或按需定位。

### 8.12 对象编辑清单

- 基础：业务名称、对象类型、描述、分类、结构化行级粒度、同义词、匹配优先级。
- 属性：字段含义、匹配优先级、唯一约束、关联目标、数字规则、值定位权限、可见性、描述、同义词、默认明细展示、导出权限。
- 指标：名称、口径、格式、单位、同义词、时间字段，以及可视化或 SQL 定义模式。
- 关系：来源和目标对象、关联字段、关系类型、基数、方向、连接表达式、是否启用、是否必需。
- 规则：默认时间字段、默认筛选、负责人和示例问题。
- 物理来源表和字段映射在本次 MVP 编辑器中只读，避免误改血缘。

Ontology 快照使用 `schemaVersion: 2`。旧版对象级 `primaryKey`、属性级 `OBJECT_IDENTIFIER` 和 `BUSINESS_KEY` 在读取时迁移为新版字段含义。旧快照存在多个对象标识时保留运行兼容，并在下一版草稿中要求人工确认唯一 ID；草稿未确认前禁止发布。

## 9. 物理 Schema 生命周期

### 9.1 表状态

| 状态 | 含义 | 默认行为 |
|---|---|---|
| `UNMODELED` | 新发现且没有 Ontology 映射 | 可勾选建模 |
| `DRAFTING` | 已进入未发布草稿 | 不允许重复选择 |
| `MODELED` | 已映射到已发布 Ontology | 从新建模列表排除 |
| `CHANGED` | 已建模但物理结构变化 | 进入影响检查 |
| `IGNORED` | 用户选择暂不建模 | 默认隐藏，可恢复 |
| `REMOVED` | 已建模表从数据源消失 | 告警，不自动删模型 |

### 9.2 结构变化规则

- 新增普通字段：建议补充属性，当前版本继续可用。
- 删除已映射字段：标记受影响对象和指标。
- 字段改名：建议迁移映射，不自动替换。
- 字段类型变化：重新验证表达式和 Join。
- 主键或 Join 字段变化：标记高风险。
- 表消失：保留历史版本，相关对象标记不可用。

未变化对象不会因为发布新版本而重新建模。

## 10. 指标模型

每个指标至少包含：

```ts
interface MetricDefinition {
  id: string;
  metricType: "BASE" | "DERIVED";
  name: string;
  label: string;
  description: string;
  objectId: string;
  definitionMode: "VISUAL" | "SQL";
  expression: string;
  aggregation: "SUM" | "COUNT" | "COUNT_DISTINCT" | "AVG" | "MIN" | "MAX" | "CUSTOM";
  sourcePropertyId?: string;
  filterExpression?: string;
  timePropertyId?: string;
  leftMetricId?: string;
  rightMetricId?: string;
  calculationOperator?: "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE" | "RATIO";
  scale?: number;
  unit?: string;
  format: "currency" | "number" | "percent";
  synonyms: string[];
  status: "DRAFT" | "PUBLISHED" | "DEPRECATED";
}
```

指标在独立的指标中心维护，不再作为对象编辑页的子表单。基础指标通过聚合方式、
来源属性和可选过滤条件生成 SelectDB 兼容表达式，也可以使用高级 SQL 表达式。
复合指标通过左右指标、受控运算符和缩放系数组成依赖图，左右指标可以继续引用复合
指标。当前 MVP 仅允许同一事实对象内组合，并在保存、发布和编译阶段拒绝缺失依赖、
重复操作数、循环依赖和跨事实对象公式；多事实来源的指标编排留待后续版本。

Montane 命中已发布复合指标时只提交该指标 ID，不重新生成临时公式。IR 编译器递归
展开治理公式，除法和比率统一使用 `NULLIF` 保护除零，并在查询追踪中展示命中的
复合指标、展开公式和依赖指标。临时派生指标同样保留有向无环依赖图，例如：

```text
毛利额 = 销售额 - 成本额
毛利率 = 毛利额 / 销售额 × 100
```

## 11. Ontology 存储

### 11.1 目录

```text
<workspace>/.montane/
├── sessions/
└── data-agent/
    ├── ontology.sqlite
    ├── results/
    ├── exports/
    └── backups/
```

### 11.2 存储边界

| 数据 | 保存位置 |
|---|---|
| Ontology 和 Schema 目录 | `.montane/data-agent/ontology.sqlite` |
| 对话与每轮追踪 | `.montane/sessions/` |
| 查询结果 | `.montane/data-agent/results/` |
| Ontology YAML 快照 | `.montane/data-agent/exports/` |
| SelectDB 密码 | 系统密钥链 |
| 非敏感连接配置 | 本地用户配置 |
| 模型 Memory | 现有用户 Memory，不保存本体 |

SQLite 是 Ontology 运行时唯一真源。YAML 用于审阅、备份和迁移，不允许绕过验证直接覆盖当前版本。

## 12. 语义索引与快速检索

### 12.1 发布时编译

Ontology 发布时生成：

- `TermIndex`
- `EntityTypeIndex`
- `RelationGraph`
- `MetricCompatibilityIndex`
- `PublishedVersionCache`
- 可选的语义描述向量

### 12.2 检索优先级

1. 属性值精确匹配
2. 属性值前缀匹配
3. 完整名称匹配
4. 同义词匹配
5. 中文字符 N-gram 模糊匹配

人工对象/属性优先级不能跨越上述证据等级，只用于同一原文片段和同一语义角色
的候选裁决。

### 12.3 查询流程

```text
用户问题
  -> 强类型问题语言框架
  -> 完整业务值索引 / 分角色本体召回
  -> 不可改写的值绑定句柄
  -> 对象关系图扩展
  -> 粒度和扇出校验
  -> 语义查询计划
  -> SelectDB SQL
```

当前发布版本常驻内存。应用启动、发布新版本或回滚版本时重建索引。新增但未建模的表不进入索引。

MVP 不部署独立向量数据库。Ontology 达到更大规模后，可以通过接口增加 Embedding 索引，而不改变查询规划器。

## 13. Agent 工作流

现有 Montane Runtime 可复用：

- `AgentLoop`
- `SessionStore`
- `SessionManager`
- 模型客户端
- `ToolRegistry`
- `PermissionGate`
- `MachineReporter`

新增专用 Data Agent 工具：

- `SearchOntology`
- `GetObjectDefinition`
- `GetMetricDefinition`
- `ResolveRelationPath`
- `BuildQueryPlan`
- `GenerateSelectDbSql`
- `ValidateSelectDbSql`
- `ExplainSelectDbQuery`
- `ExecuteSelectDbQuery`
- `CancelSelectDbQuery`
- `InspectQueryResult`
- `CreateVisualizationSpec`

MVP 当前将上述职责收敛为五个组合工具：

- `SubmitQuestionFrame`：保存本轮强类型问题语言框架，不绑定具体字段。
- `OntologySearch`：返回精简的已发布对象、度量和候选关系；度量候选包括正式
  Metric，以及带默认聚合规则的数字属性。词形匹配只作为候选诊断，且不会用
  业务值短语搜索属性名称。相同问题框架的重复检索复用首次结果。
- `DiscoverAnalysisSpace`：仅用于开放分析和原因诊断，按对象优先级选出一个
  事实对象，并返回其已发布正式指标、受控数字属性、时间字段和可安全到达的诊断维度。它不执行
  查询，也不把“销售表现”等主题词伪造成指标。
- `PropertyValueSearch`：全局检索发布值索引，再通过缓存和小范围 SelectDB 兜底
  定位问题框架中声明的原始业务值；唯一胜出项返回 `valueBindingId`。指标名、
  计算词和模型扩展近义词会被拒绝。
- `ExecuteAnalysisPlan`：对模型暴露紧凑 Evidence Request，只接收本轮可见的
  `O*/M*/D*/B*/A*` 短句柄、可选计算操作和分析步骤；服务端 Plan Synthesizer
  确定性补齐真实本体 ID、业务值筛选、时间窗口、验收项和安全默认值，再交给
  强类型 IR 编译器生成参数化 Doris SQL。关联对象仅用于筛选时默认生成相关
  `EXISTS` 子查询；若同一对象还用于分组或明细展示，则复用主查询 JOIN。

五个工具均注册到 `ToolRegistry`，由 `AgentLoop` 调用并经过 `PermissionGate`。
`AgentReporter` 将实际工具状态投影为每轮 UI 追踪，`SessionStore` 保存
`assistant_tool_calls`、`tool_result` 和 `assistant_final` 原始事件。

Montane 提示词分为不可修改的核心执行协议和可配置的工作区业务指令。业务指令
与业务时区保存在 SQLite，保存时递增版本；每个 Turn 记录实际使用的提示词版本。
工作区指令不得覆盖只读查询、本体边界、敏感字段和 IR Schema。

### 13.1 结构化输出稳定性

模型输出不再直接复刻完整 Query IR。稳定性分为六层：

1. 明确问数优先由 Plan Synthesizer 根据问题框架、本体候选和值绑定生成计划；
   模型只选择候选短句柄。
2. 开放分析和原因诊断每一步也只提交紧凑 Evidence Request，查询轮数仍由验收
   缺口和证据充分性决定，不由意图类型固定。
3. 工具返回的内部 ID 映射为本轮短句柄；句柄不可跨轮猜测或复用。
4. `ExecuteAnalysisPlan` 的 JSON Schema 随当前问题动态生成，只暴露当前可选
   指标、维度、值绑定、验收项以及当前问题可能用到的计算操作。
5. 官方 OpenAI 端点自动启用 strict function schema；OpenAI-compatible 端点
   默认不假设兼容，可在 Montane 模型能力中显式配置
   `supportsStrictToolSchema=true` 后开启。
6. Provider 返回非法函数参数 JSON 时，Montane 只记录解析位置和字符长度，
   不记录可能包含业务值的原始参数，并只自动重试一次。再次失败则安全停止，
   不执行 SQL，不进行可能改变语义的自动 JSON 修复。

紧凑请求中的所有顶层字段均为必填；无值使用空数组、`AUTO`、`0` 或空字符串。
这使 strict schema 可执行，同时避免大量可选嵌套字段造成漏逗号、漏括号和字段
组合不一致。临时复合指标使用 `C1/C2...` 在单个请求内形成小型计算 DAG，
服务端再映射为受控 `calc_*` ID，因此 `(销售额-成本额)/销售额` 等多步公式不会
因中间结果丢失而退化。

执行原则：

- LLM 负责意图理解、候选选择、澄清和结果解释。
- 确定性代码负责本体 ID 校验、IR、关系路径、粒度、SQL 编译、安全、参数和执行。
- LLM 不能直接调用 Bash 连接数据库。
- Montane 不持有自由 SQL 工具，查询只能通过 `ExecuteAnalysisPlan`。
- Agent 不得绕过已发布 Ontology 猜测字段关系。
- 模型不再接触 `measure_ids` 等内部长 ID。`OntologySearch` 和
  `DiscoverAnalysisSpace` 把当前候选映射为短句柄；`measure_refs` 支持一次
  提交最多 8 个指标。一个问题同时询问销售额、成本额、毛利率等多个指标时，
  必须在同一 Evidence Request 中完整提交，Plan Synthesizer 再映射为同一
  `AnalysisIntent.measureIds`，避免不必要的多轮 SQL 和指标丢失。
- 正式 Metric 短句柄按治理口径执行；带默认聚合规则的数字属性也可获得 M*
  短句柄并按受控规则执行。普通属性只能作为 D* 维度，不能伪装成指标。
- Query IR v3 将时间粒度与普通维度分离，支持 `DAY/WEEK/MONTH/QUARTER/YEAR`，
  月度问题必须编译为 `DATE_TRUNC(..., 'month')`，不能直接按原始日期分组。
- “今年、本月、本季度、本周”等未完成自然周期按截至当天的 `TO_DATE` 窗口执行。
  同比和环比不使用一段包含中间无关日期的连续范围，而是分别参数化当前窗口与
  同进度历史窗口；显式完整年月继续使用 `FULL_PERIOD`。
- 派生计算和正式复合指标仅支持强类型
  `ADD/SUBTRACT/MULTIPLY/DIVIDE/RATIO`。依赖可以指向同一查询中的其他派生
  计算或同一事实对象内的正式指标，编译器按有向无环图递归展开并拒绝循环；除零通过
  `NULLIF` 保护。同比和环比由 `YEAR_OVER_YEAR/PREVIOUS_PERIOD` 指定，
  规则引擎自动扩展底层取数时间并裁剪最终展示区间。
- 窗口计算支持
  `RANK/DENSE_RANK/RUNNING_SUM/MOVING_AVG/PERCENT_OF_TOTAL/
  PERCENT_OF_PARTITION`。全局占比不接受分区字段；组内占比至少需要一个
  分区字段，并支持“区域 + 渠道”等多个本体属性组成复合分区。分区字段必须
  同时出现在结果维度中，移动窗口限制为 2 至 365。
- 占比由 Doris 窗口函数确定性计算，不由 Montane 根据返回行口算。
  `PERCENT_OF_TOTAL` 的分母是当前业务筛选后的全体结果；
  `PERCENT_OF_PARTITION` 的分母是当前行所属复合分区内的全体结果。
  当前唯一允许的分母口径是
  `AFTER_BUSINESS_FILTERS_BEFORE_TOP_N`：先应用时间、权限和业务筛选，再计算
  分母，最后才执行排序、Top N 和结果行数限制。因此只展示 Top 5 时，占比之和
  可以小于 100%，但分母不会错误缩小为 Top 5。
- `DIVIDE/RATIO` 若左右引用同一指标会在执行前被拒绝，并提示改用上述占比算子，
  防止生成“自己除以自己”的全 100% 结果。正式结论中的数值必须来自
  `ExecuteAnalysisPlan` 的数据库结果，Montane 不得自行产生新的口算数值。
- `groupSelections` 表达每个分组内部的 `TOP_N/BOTTOM_N`，支持包含或排除并列。
  编译器先完成业务筛选和聚合，再生成分区 `RANK/ROW_NUMBER`，筛选每组名次，
  最后才执行全局排序和结果限制。“各类目最高的 SPU”不能降级为分区排名加
  全局 `LIMIT`。
- `periodConditions` 表达跨时间桶的 `EVERY/ANY/AT_LEAST_N` 条件。编译器先按
  “业务维度 + 时间粒度”计算指标，再按最终业务维度二次聚合，通过覆盖期间数和
  满足期间数完成集合判断；缺失期间可以配置为失败或忽略。指标阈值不能提前通过
  `aggregateFilters` 删除失败期间。
- “近 N 年”按最近 N 个完整自然年解析；结构化时间范围还支持
  `LAST_N_COMPLETE_PERIODS`，覆盖日、周、月、季度和年，并把预期期间数写入
  Query IR，供跨期间条件校验。
- Query IR v3 为每次查询生成 `resultContract`，记录计算来源、业务判断是否先于
  `LIMIT`、预期期间数和是否要求穷尽集合。运行结果结合真实截断状态生成
  `verification`；被截断结果不得生成完整名单，最终声明只允许引用数据库证据。
- 筛选支持最多四层 `AND/OR/NOT` 逻辑树；所有叶子仍执行属性权限、值绑定和
  参数化校验。
- 行级属性筛选与聚合后指标筛选严格分离。`filters/filter_expression` 只生成
  明细 `WHERE`；`aggregate_filters/aggregate_filter_expression` 引用已提交的
  指标或计算 ID，先按结果粒度汇总，再通过分层 CTE 生成等价 `HAVING` 语义。
  “销售额大于3000万”“毛利率大于75%”不得降级成来源属性条件。
- 问题语言框架中的指标阈值必须由最终聚合筛选 IR 逐项覆盖，包括指标、运算符和
  标准化阈值（万、亿、百分比）；缺失或降级的计划在访问 SelectDB 前被拒绝，
  不消耗成功查询预算。
- 聚合安全规则禁止多个事实对象直接混算，阻止会放大事实行的一对多/多对多路径，
  禁止比例或不可加数字求和，并禁止半可加指标跨时间直接求和。
- SQL 和查询参数必须写入对应轮次追踪。
- Evidence Request、Plan Synthesizer 展开的指标/维度/值绑定数量、最终 IR、
  SQL 和参数必须同时进入本轮追踪，便于区分“模型选错候选”和“规则展开错误”。
- 明确指标问数、开放分析和原因诊断共用同一查询循环与四条成功查询预算；
  意图只决定验收契约，不决定固定查询轮数。明确问数在截断、证据不完整或纠错时
  可以继续查询，开放分析在一条查询已经满足验收时可以立即结束。
- 每条计划通过 `analysis_step.acceptance_criterion_ids` 关联仍为 `PENDING`
  或 `BLOCKED` 的验收项。成功计划按结构化 IR 去重；不能关闭任何验收缺口的计划、
  重复计划和跨事实对象计划均被拒绝。
- 验收契约状态分为 `OPEN/SATISFIED/PARTIAL_BUDGET/PARTIAL_NO_PROGRESS/
  NEEDS_CLARIFICATION/FAILED`。查询预算只是停止约束，不能作为成功依据。
- 固定分析模板可以作为未来推荐路径，但不是开放分析的前置条件。Montane 在受控
  分析空间内动态规划，SQL 仍完全由 IR 编译器负责。

Data Agent 单轮不使用 Montane 的通用会话摘要压缩，避免摘要丢失问题框架、
值绑定、observation 和已完成查询；上下文保留本轮最多 120 个原始事件，完整
事件仍持久化到 SessionStore。当前通用循环最多 14 个模型回合、18 次工具调用和
360,000 输入 token；所有数据分析另有统一的四条成功查询预算。重复本体搜索、
重复 IR、跨事实对象、无验收目标查询和越界属性值搜索会被工具层拒绝，不能通过
扩大预算掩盖循环。

## 14. SelectDB 适配

SelectDB 使用 MySQL 网络协议，但必须由独立方言适配层处理，不能直接视为标准 MySQL。

参考：

- [Apache Doris MySQL Protocol](https://doris.apache.org/docs/3.x/db-connect/database-connect/)
- [Apache Doris System Tables](https://doris.apache.org/docs/3.0/admin-manual/system-tables/overview/)
- [Apache Doris Variables](https://doris.apache.org/docs/3.x/sql-manual/basic-element/variables/)
- [Apache Doris Kill Query](https://doris.apache.org/docs/3.x/admin-manual/workload-management/kill-query/)

### 14.1 连接策略

- MySQL 协议驱动
- 独立只读账号
- 一个 SelectDB 实例
- 一个业务 Database
- 保守连接池
- 每次查询分配 Trace ID
- TLS 配置保存在数据源设置

### 14.2 查询约束

- 用户查询仅允许单条 `SELECT` 或 `WITH ... SELECT`
- 禁止用户 DDL、DML、管理语句和多语句
- 默认最大返回 10,000 行
- 无显式 `LIMIT` 时由系统注入
- 服务端超时 180 秒
- SelectDB Session `query_timeout` 设置为 180 秒
- `ETIMEDOUT/ECONNRESET/PROTOCOL_CONNECTION_LOST/closed state` 等瞬时连接
  读取失败仅对只读查询自动重试一次；语义或 SQL 错误不重试。
- SSE 请求超时必须大于数据库超时
- 查询取消优先使用 Trace ID 和 `KILL QUERY`
- 不支持 Trace ID 时回退到连接级取消

### 14.3 SQL Guard

1. 移除注释并解析 AST。
2. 确认只有一条语句。
3. 根节点必须是查询。
4. 禁止文件、外部命令和管理函数。
5. 校验表和字段是否属于已发布 Ontology。
6. 校验关系路径是否已发布。
7. 检查多对多和一对多扇出。
8. 注入或收紧 `LIMIT 10000`。
9. 生成查询指纹。
10. 必要时执行 `EXPLAIN`。
11. 按风险级别决定自动执行或审批。

## 15. 查询审批策略

### 15.1 自动执行

满足以下全部条件时自动执行：

- 只读查询
- 使用已发布 Ontology
- 没有高扇出关系
- 返回上限不超过 10,000
- 没有敏感属性
- 查询成本未触发风险规则

SQL 始终可以在本轮追踪中查看。

### 15.2 必须审批

- 使用敏感属性
- 高扇出路径
- 查询范围明显过大
- `EXPLAIN` 显示高风险扫描
- 使用受限派生关系
- SQL Guard 无法确定安全性

## 16. 模型数据边界

- Schema 和已发布 Ontology 可以发送给模型。
- 聚合结果最多发送 200 行。
- 明细结果最多发送 50 行。
- 敏感字段脱敏后才可发送。
- 完整结果只保存在本地。
- 超出模型行数限制时，由本地代码生成摘要。
- 凭据和连接信息永不发送给模型。
- 日志不得记录 Password 或完整敏感字段值。

## 17. 结果与可视化

### 17.1 结果顺序

1. 分析结论
2. KPI 摘要
3. 推荐图表
4. 数据表
5. 可展开分析证据链

### 17.2 MVP 图表

- 单值 KPI
- 折线图
- 柱状图
- 横向排名条形图
- 少量互斥分类饼图
- 数据表

### 17.3 自动选择

- 时间维度加单指标：折线图
- 分类维度加单指标：柱状图
- Top N：横向条形图
- 单行聚合：KPI
- 多字段明细：数据表
- 无可靠映射：只显示表格

Agent 只生成白名单中的声明式图表规格。前端不执行 Agent 生成的 JavaScript。

## 18. UI 设计规范

视觉方向采用已确认的“结果优先主体，加每轮可追踪时间线”。

### 18.1 视觉原则

- 对话即工作区
- 结果优先
- 约束可见
- 状态无歧义
- 低装饰
- 逐层披露

### 18.2 色彩

- Primary：Blue 600，参考 `#146EF5`
- Ink：`#101828`
- Surface：`#F7F9FC`
- Border：`#E4E9F0`
- Success：`#16A05D`
- Warning：`#F59E0B`
- Danger：`#E5484D`

实现使用 OKLCH 语义 Token，并达到 WCAG AA。

### 18.3 字体

- 单一中文无衬线字体栈
- 页面标题：24/32，Semibold
- 区域标题：16/24，Semibold
- 正文：14/22，Regular
- 辅助文本：12/18，Regular
- 数据：28/36，Semibold
- SQL：等宽字体

### 18.4 间距与圆角

- 8px 基础网格
- 间距：4、8、12、16、24、32
- 输入框圆角：8px
- 按钮圆角：8px
- 面板圆角：8px
- 大结果容器圆角：10px
- 不使用胶囊式大圆角

### 18.5 动效

- 状态切换：150-250ms
- 只用于反馈和状态变化
- 不使用页面入场编排
- 支持 `prefers-reduced-motion`
- 查询完成后立即停止运行态动效

### 18.6 响应式

- 1440px 为设计基准
- 1280px 保持完整功能
- 低于 1200px 收起右侧上下文面板
- 低于 960px 收起会话列表
- MVP 不承诺移动端完整体验
- 优先支持最新版 Chrome 和 Edge

## 19. 页面状态

### 19.1 对话页

- 无会话
- 空会话
- 待输入
- 理解中
- 规划中
- 等待审批
- 查询中
- 已完成
- 需要澄清
- 部分完成
- 查询被取消
- 查询失败
- 服务不可用

### 19.2 Ontology 页面

- 尚未扫描
- 扫描中
- 待选择建模表
- 草稿生成中
- 草稿待审核
- 验证失败
- 验证通过
- 发布成功
- Schema 有变更
- 已发布版本存在受影响对象

### 19.3 结果

- 无数据
- 已截断
- 图表不可生成
- SQL 成功但解释失败
- 解释成功但导出失败

所有状态使用文字和图标表达，不依赖颜色。

## 20. 技术架构

```text
React Web UI
  -> Node Web BFF
  -> Montane Agent Runtime
  -> Semantic Retriever
  -> Governed Analysis Space
  -> Bounded Analysis Loop
  -> Typed Query IR
  -> Doris SQL Compiler
  -> SQL Guard
  -> SelectDB Adapter
  -> Alibaba Cloud SelectDB
```

并行持久化：

```text
Agent Runtime
  -> Session Event Store
  -> SQLite Ontology Repository
  -> Result Artifact Store
```

### 20.1 推荐技术栈

前端：

- React
- TypeScript
- Vite
- Tailwind CSS
- Radix UI Primitives
- Phosphor Icons
- TanStack Query
- TanStack Table
- Apache ECharts
- CodeMirror，只读 SQL 展示

后端：

- Node.js 22+
- TypeScript ESM
- Fastify
- SSE
- Zod
- MySQL 协议驱动
- SQLite
- 系统密钥链适配

现有 CLI 继续作为 Runtime 与 SDK，不解析终端文本来驱动 Web。

## 21. API 与事件

### 21.1 主要 API

```text
GET    /api/conversations
POST   /api/conversations
PATCH  /api/conversations/:id
DELETE /api/conversations/:id

GET    /api/conversations/:id/turns
POST   /api/conversations/:id/turns
GET    /api/turns/:id
GET    /api/turns/:id/trace
POST   /api/turns/:id/cancel
POST   /api/turns/:id/approval

GET    /api/ontology
POST   /api/schema/scan
GET    /api/schema/tables
POST   /api/ontology/drafts
POST   /api/ontology/validate
POST   /api/ontology/publish
POST   /api/ontology/rollback
PATCH  /api/ontology/:entityType/:id
PUT    /api/ontology/draft/metrics/:id
DELETE /api/ontology/draft/metrics/:id

GET    /api/data-source
PUT    /api/data-source
POST   /api/data-source/test

GET    /api/events
```

### 21.2 Data Agent 事件

- `turn_created`
- `trace_step_started`
- `trace_step_completed`
- `trace_step_failed`
- `ontology_context_resolved`
- `relation_path_selected`
- `query_plan_created`
- `sql_generated`
- `query_approval_requested`
- `query_started`
- `query_completed`
- `query_cancelled`
- `result_artifact_created`
- `visualization_created`
- `turn_completed`
- `turn_failed`

每个事件必须包含 `eventId`、`sessionId`、`conversationId`、`turnId`、`sequence`、`timestamp` 和 `type`。

## 22. 安全与隐私

- SelectDB 专用只读账号
- 密码保存到系统密钥链
- SQL AST 白名单
- 单语句限制
- 已发布 Ontology 对象限制
- 最大行数 10,000
- 查询超时 180 秒
- 查询取消能力
- Agent 查询预算
- 敏感属性审批
- 日志和错误脱敏
- 凭据不进入模型上下文
- 查询结果受行数和脱敏限制
- 所有查询与审批写入审计记录
- 禁止通过 Bash 绕过查询工具
- 本地状态目录使用当前用户最小文件权限

## 23. 测试与验收

### 23.1 单元测试

- Schema 状态分类
- 增量 Ontology 建模
- Ontology 实体和关系校验
- 关系路径选择
- 基数与扇出检测
- 多轮上下文继承
- SelectDB SQL 方言
- SQL AST 安全检查
- `LIMIT` 注入
- 180 秒超时
- Trace 状态机
- 权限和审批策略
- 模型数据行数限制和脱敏

### 23.2 集成测试

- SelectDB 连接配置和密钥链
- 元数据扫描
- 普通聚合查询
- 多表关系查询
- 查询超时
- 查询取消
- 空结果
- 10,000 行截断
- 连接中断
- Ontology 发布和回滚
- Schema 变更影响检查
- 会话恢复

### 23.3 端到端测试

- 配置 SelectDB 并完成扫描
- 勾选未建模表并发布 Ontology
- 新建会话并完成问数
- 连续三轮上下文追问
- 每轮追踪独立存在
- 历史轮次展开追踪
- 高风险查询审批
- 查询失败后重试
- CSV 导出
- 问数页面不存在数据源信息
- 键盘操作和焦点顺序
- 1440px、1280px 和收缩布局

### 23.4 硬性验收

- 每个 `turn_id` 必须对应一份追踪。
- 已执行查询必须保存最终 SQL。
- 同一轮存在多条 SQL 时必须全部按执行顺序独立展示，不能只保留最后一条。
- 无查询轮次必须保存未查询原因。
- 问数页面 API 不返回连接配置。
- 所有用户查询均通过 SQL Guard。
- 180 秒后查询必须结束或进入取消流程。
- 返回结果不超过 10,000 行。
- 新增物理表不改变当前已发布 Ontology。
- 已建模表不进入新建模默认选择。
- 未发布对象不进入问数语义索引。
- 历史会话恢复后结果与追踪一致。
- 所有分析类型共用四条成功查询预算；重复计划、跨事实对象计划和不能关闭验收
  缺口的计划必须被拒绝。
- 明确问数在首条结果被截断时允许执行纠正查询；验收满足后继续查询必须被拒绝。
- 开放分析主动停止但仍缺少适用的时间变化或结构证据时，结果必须标记为部分完成。
- 多步分析的目标、选择依据、IR、SQL 和结果样例必须按执行顺序持久化。
- 当前周期同比必须使用同进度历史窗口；完整历史周期不得冒充“同期”。
- 分组后的指标阈值必须编译为聚合后筛选，不能写入事实明细 `WHERE`；用户问题中的
  每个指标阈值必须完整出现在 Query IR 和参数化 SQL 中。
- 语义不完整或发生指标条件降级的计划不得执行数据库，也不得占用成功查询预算。
- Data Agent 有效模型轮次上限必须与配置的 14 轮预算一致，单轮状态不能因通用
  摘要压缩而丢失。
- 同一问题包含多个指标、业务值和同比/环比时，必须通过一个紧凑
  `measure_refs` 请求生成同一条受控 SQL；每个指标的比较列都必须保留。
- `ExecuteAnalysisPlan` 的动态 Schema 不得暴露内部 `root_object_id`、
  `measure_ids` 或完整 IR 树；当前候选之外的短句柄必须在查询前被拒绝。
- 非法函数参数 JSON 最多自动重试一次；连续失败不得执行 SQL，日志不得保存
  原始函数参数正文。支持 strict tool schema 的端点必须收到 `strict=true`。
- 正文与控件达到 WCAG AA。
- 现有 CLI 行为和测试不得回归。

## 24. 实施阶段

### 阶段 1：Web 与 Runtime 基础

- Web BFF
- React 应用壳
- SSE 事件桥接
- 会话列表与多轮消息
- Runtime SDK 接入

### 阶段 2：数据源与 SelectDB

- Web 数据源配置
- 系统密钥链
- SelectDB Adapter
- 元数据扫描
- SQL Guard
- 超时、取消和截断
- 查询审计

### 阶段 3：Ontology

- 物理 Schema 目录
- 表状态与差异
- 用户勾选建模
- 对象、属性和关系
- 指标、维度和术语
- 验证、发布和回滚
- 语义索引

### 阶段 4：Data Agent

- Semantic Retriever
- Montane 紧凑 Evidence Request + 服务端确定性 Plan Synthesizer
- 单事实对象 Governed Analysis Space
- 基于 observation 的有界多步分析循环
- 强类型 Query IR 与确定性 SelectDB SQL 编译
- 多轮上下文
- 每轮分析证据链
- 结果解释

### 阶段 5：结果与 UI

- 图表
- 表格
- CSV 导出
- 状态和错误
- 响应式适配
- 可访问性
- 视觉回归

### 阶段 6：验证与交付

- `npm run build`
- `npm test -- --run`
- 集成测试
- 端到端测试
- 浏览器视觉验收
- 修复后提交并推送 `main`

## 25. 当前交付与真实联调条件

产品级决策已经闭合，MVP 开发已启动并持续迭代。

真实 SelectDB 联调需要后续提供：

- 可访问的测试实例
- 只读账号
- 目标 Catalog 和 Database
- TLS 要求
- 至少一组可验证的业务问题与预期口径

模型联调需要使用当前 CLI 支持的模型配置和有效凭据。

真实实例参数和业务预期只用于联调与验收，不影响本地代码构建。
