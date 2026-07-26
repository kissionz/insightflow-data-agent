import { describe, expect, it } from "vitest";
import type { AnalysisIntent, PhysicalTable } from "../src/shared/types.js";
import { QueryIrCompiler } from "../src/server/query-ir.js";
import { testOntology } from "./fixtures.js";

describe("QueryIrCompiler", () => {
  it("compiles governed IDs and natural time into parameterized Doris SQL", () => {
    const ontology = structuredClone(testOntology);
    const order = ontology.objects[0];
    order.defaultTimePropertyId = "p_paid_at";
    order.properties.push(
      {
        id: "p_channel",
        name: "channel_code",
        label: "销售渠道",
        description: "订单来源渠道",
        dataType: "VARCHAR",
        sourceColumn: "channel_code",
        sensitive: false,
        meaning: "CATEGORY",
        unique: false,
        valueSearchable: true,
        visibility: "ANALYTICAL",
        synonyms: ["渠道"],
        defaultDisplay: true,
        exportable: true,
      },
      {
        id: "p_paid_at",
        name: "paid_at",
        label: "支付时间",
        description: "支付完成时间",
        dataType: "DATETIME",
        sourceColumn: "paid_at",
        sensitive: false,
        meaning: "TIME",
        unique: false,
        valueSearchable: false,
        visibility: "ANALYTICAL",
        synonyms: [],
        defaultDisplay: true,
        exportable: true,
      },
    );
    const intent: AnalysisIntent = {
      rootObjectId: "o_order",
      measureIds: ["m_gmv"],
      dimensionPropertyIds: [],
      filters: [
        {
          propertyId: "p_channel",
          operator: "EQ",
          businessValue: "线上",
          value: "ONLINE",
        },
      ],
      timeRange: { expression: "今年" },
      resultKind: "aggregate",
      title: "今年线上渠道销售额",
    };
    const compiler = new QueryIrCompiler(() => new Date(2026, 6, 26));
    const compiled = compiler.compile(intent, ontology, [ordersTable()]);

    expect(compiled.sql).toContain(
      "SUM(t0.`pay_amount`) AS `成交金额`",
    );
    expect(compiled.sql).toContain("t0.`channel_code` = ?");
    expect(compiled.sql).toContain("t0.`paid_at` >= ?");
    expect(compiled.parameters).toEqual([
      "ONLINE",
      "2026-01-01 00:00:00",
      "2027-01-01 00:00:00",
    ]);
    expect(compiled.ir.timeRange).toMatchObject({
      propertyId: "p_paid_at",
      expression: "今年",
    });
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "筛选条件",
        value: "销售渠道 = 线上",
        source: "属性值索引映射为 ONLINE",
      }),
    );
  });

  it("rejects model-created ontology identifiers", () => {
    const compiler = new QueryIrCompiler();
    expect(() =>
      compiler.compile(
        {
          measureIds: ["invented_metric"],
          dimensionPropertyIds: [],
          filters: [],
          resultKind: "aggregate",
          title: "错误计划",
        },
        testOntology,
        [ordersTable()],
      ),
    ).toThrow("不存在的指标");
  });

  it("repairs a property measure reference only through a unique governed metric", () => {
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["p_order_amount"],
        dimensionPropertyIds: [],
        filters: [],
        resultKind: "aggregate",
        title: "成交金额",
      },
      testOntology,
      [ordersTable()],
    );

    expect(compiled.ir.measureIds).toEqual(["m_gmv"]);
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "指标",
        value: "成交金额",
        entityId: "m_gmv",
        source: expect.stringContaining("Montane误传属性ID"),
      }),
    );
  });

  it("explains when a non-measure property is used as a metric", () => {
    const compiler = new QueryIrCompiler();
    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_customer",
          measureIds: ["p_customer_level"],
          dimensionPropertyIds: [],
          filters: [],
          resultKind: "aggregate",
          title: "错误指标",
        },
        testOntology,
        [ordersTable()],
      ),
    ).toThrow("是属性，不是指标");
  });

  it("compiles an indexed value on a related object as a correlated EXISTS", () => {
    const ontology = structuredClone(testOntology);
    ontology.objects[2]!.properties.push({
      id: "p_store_name",
      name: "store_name",
      label: "组织名称",
      description: "组织单元名称",
      dataType: "VARCHAR",
      sourceColumn: "store_name",
      sensitive: false,
      meaning: "NAME",
      unique: false,
      valueSearchable: true,
      visibility: "ANALYTICAL",
      synonyms: ["组织单元"],
      defaultDisplay: true,
      exportable: true,
      bindingPriority: 80,
    });
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: [],
        filters: [{
          kind: "BOUND_VALUE",
          valueBindingId: "value_binding_online",
          objectId: "o_store",
          propertyId: "p_store_name",
          operator: "EQ",
          value: "线上渠道",
          businessValue: "线上渠道",
          evidenceTier: "EXACT_VALUE",
          objectPriority: 90,
          propertyPriority: 80,
        }],
        resultKind: "aggregate",
        title: "线上渠道销售额",
      },
      ontology,
      [ordersTable(), storeTable()],
    );

    expect(compiled.sql).toContain("WHERE EXISTS (");
    expect(compiled.sql).toContain(
      "t0.`store_id` = vf0.`store_id`",
    );
    expect(compiled.sql).toContain("vf0.`store_name` = ?");
    expect(compiled.sql).not.toContain("t0.`store_id` = ?");
    expect(compiled.parameters).toEqual(["线上渠道"]);
    expect(compiled.ir.filters[0]).toMatchObject({
      kind: "BOUND_VALUE",
      strategy: "EXISTS",
      relationIds: ["r_order_store"],
    });
  });
});

function ordersTable(): PhysicalTable {
  return {
    id: "t_orders",
    catalog: "internal",
    database: "retail",
    name: "fact_orders",
    type: "TABLE",
    status: "MODELED",
    columns: [],
    fingerprint: "fact_orders:v3",
    scannedAt: "2026-07-26T00:00:00.000Z",
  };
}

function storeTable(): PhysicalTable {
  return {
    id: "t_stores",
    catalog: "internal",
    database: "retail",
    name: "dim_stores",
    type: "TABLE",
    status: "MODELED",
    columns: [],
    fingerprint: "dim_stores:v3",
    scannedAt: "2026-07-26T00:00:00.000Z",
  };
}
