import type { OntologySnapshot } from "../src/shared/types.js";

export const testOntology: OntologySnapshot = {
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
      synonyms: ["交易", "销售订单"],
      properties: [
        property("p_order_id", "order_id", "订单编号", "BIGINT"),
        property("p_order_amount", "pay_amount", "实付金额", "DECIMAL"),
        property("p_store_id", "store_id", "门店编号", "BIGINT"),
        property("p_customer_id", "customer_id", "客户编号", "BIGINT"),
      ],
    },
    {
      id: "o_customer",
      name: "customer",
      label: "客户",
      description: "客户业务对象",
      sourceTableId: "t_customers",
      status: "PUBLISHED",
      synonyms: ["会员"],
      properties: [
        property("p_customer_id", "customer_id", "客户编号", "BIGINT"),
        property("p_customer_level", "member_level", "会员等级", "VARCHAR"),
      ],
    },
    {
      id: "o_store",
      name: "store",
      label: "门店",
      description: "门店业务对象",
      sourceTableId: "t_stores",
      status: "PUBLISHED",
      synonyms: ["店铺"],
      properties: [
        property("p_store_id", "store_id", "门店编号", "BIGINT"),
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
      synonyms: ["销售额", "GMV"],
      status: "PUBLISHED",
    },
  ],
};

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
