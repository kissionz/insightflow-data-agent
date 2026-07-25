import type {
  Conversation,
  OntologySnapshot,
  PhysicalTable,
  ResultArtifact,
  TraceStep,
} from "../shared/types.js";

const publishedAt = "2026-07-25T02:18:00.000Z";

export const demoTables: PhysicalTable[] = [
  table("t_orders", "fact_orders", "订单事实表", "MODELED", 2_486_120),
  table("t_customers", "dim_customers", "客户主数据", "MODELED", 184_320),
  table("t_products", "dim_products", "商品主数据", "MODELED", 8_542),
  table("t_stores", "dim_stores", "门店主数据", "MODELED", 236),
  table("t_order_items", "fact_order_items", "订单商品明细", "MODELED", 7_942_880),
  table("t_campaigns", "dim_campaigns", "营销活动配置", "UNMODELED", 88),
  table("t_refunds", "fact_refunds", "退款事实表", "UNMODELED", 42_713),
];

function table(
  id: string,
  name: string,
  description: string,
  status: PhysicalTable["status"],
  rowEstimate: number,
): PhysicalTable {
  return {
    id,
    catalog: "internal",
    database: "retail_analytics",
    name,
    type: "TABLE",
    status,
    rowEstimate,
    description,
    fingerprint: `${name}:v1`,
    scannedAt: publishedAt,
    columns: [
      {
        name: `${name.replace(/^(fact|dim)_/, "").replace(/s$/, "")}_id`,
        dataType: "BIGINT",
        nullable: false,
        sensitive: false,
      },
      {
        name: "created_at",
        dataType: "DATETIME",
        nullable: false,
        sensitive: false,
      },
    ],
  };
}

export const demoOntology: OntologySnapshot = {
  version: 4,
  status: "PUBLISHED",
  publishedAt,
  objects: [
    object("o_order", "order", "订单", "t_orders", ["交易", "销售订单"], [
      property("p_order_id", "order_id", "订单编号", "BIGINT"),
      property("p_order_amount", "pay_amount", "实付金额", "DECIMAL"),
      property("p_order_date", "order_date", "下单日期", "DATE"),
      property("p_store_id", "store_id", "门店编号", "BIGINT"),
      property("p_customer_id", "customer_id", "客户编号", "BIGINT"),
    ]),
    object("o_customer", "customer", "客户", "t_customers", ["顾客", "会员"], [
      property("p_customer_id", "customer_id", "客户编号", "BIGINT"),
      property("p_customer_region", "region_name", "区域", "VARCHAR"),
      property("p_customer_level", "member_level", "会员等级", "VARCHAR"),
    ]),
    object("o_product", "product", "商品", "t_products", ["产品", "SKU"], [
      property("p_product_id", "product_id", "商品编号", "BIGINT"),
      property("p_product_category", "category_name", "商品类目", "VARCHAR"),
    ]),
    object("o_store", "store", "门店", "t_stores", ["店铺", "直营网点"], [
      property("p_store_id", "store_id", "门店编号", "BIGINT"),
      property("p_store_name", "store_name", "门店名称", "VARCHAR"),
      property("p_store_region", "region_name", "门店区域", "VARCHAR"),
    ]),
  ],
  relations: [
    {
      id: "r_order_customer",
      name: "订单属于客户",
      sourceObjectId: "o_order",
      targetObjectId: "o_customer",
      type: "EVENT_PARTICIPATION",
      cardinality: "MANY_TO_ONE",
      joinExpression: "fact_orders.customer_id = dim_customers.customer_id",
      fanoutRisk: "NONE",
      status: "PUBLISHED",
    },
    {
      id: "r_order_store",
      name: "订单发生于门店",
      sourceObjectId: "o_order",
      targetObjectId: "o_store",
      type: "REFERENCE",
      cardinality: "MANY_TO_ONE",
      joinExpression: "fact_orders.store_id = dim_stores.store_id",
      fanoutRisk: "NONE",
      status: "PUBLISHED",
    },
    {
      id: "r_order_product",
      name: "订单包含商品",
      sourceObjectId: "o_order",
      targetObjectId: "o_product",
      type: "COMPOSITION",
      cardinality: "MANY_TO_MANY",
      joinExpression:
        "fact_orders.order_id = fact_order_items.order_id AND fact_order_items.product_id = dim_products.product_id",
      fanoutRisk: "HIGH",
      status: "PUBLISHED",
    },
  ],
  metrics: [
    {
      id: "m_gmv",
      name: "gmv",
      label: "成交金额",
      description: "支付成功订单的实付金额之和",
      objectId: "o_order",
      expression: "SUM(fact_orders.pay_amount)",
      aggregation: "SUM",
      format: "currency",
      synonyms: ["销售额", "交易额", "GMV", "营收"],
      status: "PUBLISHED",
    },
    {
      id: "m_order_count",
      name: "order_count",
      label: "订单量",
      description: "去重订单数量",
      objectId: "o_order",
      expression: "COUNT(DISTINCT fact_orders.order_id)",
      aggregation: "COUNT_DISTINCT",
      format: "number",
      synonyms: ["订单数", "成交单量"],
      status: "PUBLISHED",
    },
    {
      id: "m_aov",
      name: "average_order_value",
      label: "客单价",
      description: "成交金额除以订单量",
      objectId: "o_order",
      expression:
        "SUM(fact_orders.pay_amount) / NULLIF(COUNT(DISTINCT fact_orders.order_id), 0)",
      aggregation: "AVG",
      format: "currency",
      synonyms: ["平均订单金额", "AOV"],
      status: "PUBLISHED",
    },
  ],
};

function object(
  id: string,
  name: string,
  label: string,
  sourceTableId: string,
  synonyms: string[],
  properties: ReturnType<typeof property>[],
) {
  return {
    id,
    name,
    label,
    description: `${label}业务对象`,
    sourceTableId,
    status: "PUBLISHED" as const,
    properties,
    synonyms,
  };
}

function property(id: string, name: string, label: string, dataType: string) {
  return {
    id,
    name,
    label,
    dataType,
    sourceColumn: name,
    sensitive: false,
  };
}

const demoResult: ResultArtifact = {
  kind: "analysis",
  mode: "demo",
  conclusion:
    "华东区本月成交金额为 ¥12.84M，较上月增长 18.6%。增长主要来自杭州湖滨店与上海静安店，两店合计贡献增量的 61%。",
  kpis: [
    { label: "成交金额", value: "¥12.84M", change: "+18.6%" },
    { label: "订单量", value: "38,420", change: "+11.2%" },
    { label: "客单价", value: "¥334", change: "+6.6%" },
  ],
  chart: {
    title: "华东区近 6 个月成交金额",
    type: "bar",
    categories: ["2月", "3月", "4月", "5月", "6月", "7月"],
    series: [
      { name: "成交金额（百万元）", data: [8.6, 9.2, 9.8, 10.4, 10.83, 12.84] },
    ],
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

const trace: TraceStep[] = [
  traceStep("tr_1", "understanding", "理解问题", "识别华东区、本月与环比分析意图"),
  traceStep("tr_2", "inheritance", "继承上下文", "本轮无省略条件，独立解析"),
  traceStep("tr_3", "semantic_binding", "绑定业务语义", "成交金额 → GMV；区域 → 门店区域"),
  traceStep("tr_4", "relation_path", "选择关系路径", "订单 → 门店，M:1，无扇出风险"),
  traceStep("tr_5", "grain_check", "校验分析粒度", "门店 × 月份，符合指标可加性约束"),
  traceStep("tr_6", "query_plan", "生成查询计划", "聚合近两月成交金额并计算门店贡献"),
  traceStep("tr_7", "sql", "生成只读 SQL", "SELECT / WITH SELECT，限制 10,000 行"),
  traceStep("tr_8", "execution", "执行查询", "返回 18 行，用时 1.4 秒"),
  traceStep("tr_9", "interpretation", "解释结果", "识别主要增长门店并生成结论"),
];

function traceStep(
  id: string,
  kind: TraceStep["kind"],
  label: string,
  summary: string,
): TraceStep {
  return {
    id,
    turnId: "turn_demo",
    kind,
    label,
    status: "completed",
    summary,
    createdAt: publishedAt,
    completedAt: publishedAt,
  };
}

export const demoConversation: Conversation = {
  id: "conv_demo",
  title: "华东区经营表现分析",
  createdAt: publishedAt,
  updatedAt: publishedAt,
  status: "active",
  turns: [
    {
      id: "turn_demo",
      conversationId: "conv_demo",
      question: "分析一下华东区这个月的经营表现，和上月相比有什么变化？",
      answer: demoResult.conclusion,
      status: "completed",
      createdAt: publishedAt,
      completedAt: publishedAt,
      ontologyVersion: 4,
      trace,
      result: demoResult,
    },
  ],
};
