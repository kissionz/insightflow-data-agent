import type { OntologySnapshot } from "../src/shared/types.js";

export const testOntology: OntologySnapshot = {
  schemaVersion: 2,
  version: 1,
  status: "PUBLISHED",
  publishedAt: "2026-07-25T00:00:00.000Z",
  objects: [
    {
      id: "o_order",
      name: "order",
      label: "订单",
      description: "订单业务对象",
      sourceTableId: "t_orders",
      status: "PUBLISHED",
      objectType: "EVENT",
      grainPropertyIds: ["p_order_id"],
      grain: "一行代表一个订单",
      defaultTimePropertyId: undefined,
      exampleQuestions: [],
      synonyms: ["交易", "销售订单"],
      bindingPriority: 50,
      properties: [
        property("p_order_id", "order_id", "订单ID", "BIGINT", "ID"),
        property("p_order_amount", "pay_amount", "实付金额", "DECIMAL", "NUMBER"),
        property("p_store_id", "store_id", "门店", "BIGINT", "ENTITY_REFERENCE"),
        property(
          "p_customer_id",
          "customer_id",
          "客户",
          "BIGINT",
          "ENTITY_REFERENCE",
        ),
      ],
    },
    {
      id: "o_customer",
      name: "customer",
      label: "客户",
      description: "客户业务对象",
      sourceTableId: "t_customers",
      status: "PUBLISHED",
      objectType: "ENTITY",
      grainPropertyIds: ["p_customer_id"],
      grain: "一行代表一个客户",
      exampleQuestions: [],
      synonyms: ["会员"],
      bindingPriority: 50,
      properties: [
        property("p_customer_id", "customer_id", "客户ID", "BIGINT", "ID"),
        property(
          "p_customer_level",
          "member_level",
          "会员等级",
          "VARCHAR",
          "CATEGORY",
        ),
      ],
    },
    {
      id: "o_store",
      name: "store",
      label: "门店",
      description: "门店业务对象",
      sourceTableId: "t_stores",
      status: "PUBLISHED",
      objectType: "ENTITY",
      grainPropertyIds: ["p_store_id"],
      grain: "一行代表一个门店",
      exampleQuestions: [],
      synonyms: ["店铺"],
      bindingPriority: 50,
      properties: [
        property("p_store_id", "store_id", "门店ID", "BIGINT", "ID"),
      ],
    },
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
      sourcePropertyId: "p_customer_id",
      targetPropertyId: "p_customer_id",
      direction: "BIDIRECTIONAL",
      required: false,
      enabled: true,
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
      sourcePropertyId: "p_store_id",
      targetPropertyId: "p_store_id",
      direction: "BIDIRECTIONAL",
      required: false,
      enabled: true,
      fanoutRisk: "NONE",
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
      definitionMode: "VISUAL",
      sourcePropertyId: "p_order_amount",
      aggregation: "SUM",
      format: "currency",
      synonyms: ["销售额", "GMV"],
      status: "PUBLISHED",
    },
  ],
};

function property(
  id: string,
  name: string,
  label: string,
  dataType: string,
  meaning:
    | "ID"
    | "CODE"
    | "NAME"
    | "ENTITY_REFERENCE"
    | "CATEGORY"
    | "TIME"
    | "NUMBER"
    | "BOOLEAN"
    | "GEOGRAPHY"
    | "TEXT" = "TEXT",
) {
  return {
    id,
    name,
    label,
    dataType,
    sourceColumn: name,
    sensitive: false,
    description: "",
    meaning,
    unique: meaning === "ID",
    valueSearchable: ["CODE", "NAME", "CATEGORY", "BOOLEAN", "GEOGRAPHY"].includes(
      meaning,
    ),
    numericSpec:
      meaning === "NUMBER"
        ? {
            kind: "CURRENCY" as const,
            currency: "CNY",
            defaultAggregation: "SUM" as const,
            aggregationBehavior: "ADDITIVE" as const,
          }
        : undefined,
    visibility: "ANALYTICAL" as const,
    synonyms: [],
    detailOrder: 1,
    defaultDisplay: true,
    exportable: true,
    bindingPriority: 50,
  };
}
