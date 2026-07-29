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
      "2026-07-27 00:00:00",
    ]);
    expect(compiled.ir.timeRange).toMatchObject({
      propertyId: "p_paid_at",
      expression: "今年",
      mode: "TO_DATE",
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

  it("uses a numeric property as a governed measure through its default aggregation", () => {
    const ontology = structuredClone(testOntology);
    ontology.metrics = [];
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["p_order_amount"],
        dimensionPropertyIds: [],
        filters: [],
        resultKind: "aggregate",
        title: "销售金额",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "SUM(t0.`pay_amount`) AS `实付金额`",
    );
    expect(compiled.ir.measureIds).toEqual(["p_order_amount"]);
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "指标",
        value: "实付金额",
        entityId: "p_order_amount",
        source: "数字属性默认求和 · IR受控聚合",
      }),
    );
  });

  it("rejects a numeric property without a default aggregation", () => {
    const ontology = structuredClone(testOntology);
    ontology.metrics = [];
    ontology.objects[0]!.properties[1]!.numericSpec!.defaultAggregation = "NONE";
    const compiler = new QueryIrCompiler();

    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["p_order_amount"],
          dimensionPropertyIds: [],
          filters: [],
          resultKind: "aggregate",
          title: "销售金额",
        },
        ontology,
        [ordersTable()],
      ),
    ).toThrow("没有可用的默认聚合规则");
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
    ).toThrow("不是可聚合数字属性");
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

  it("groups a time series by month instead of the raw day value", () => {
    const ontology = ontologyWithTime();
    const compiler = new QueryIrCompiler(() => new Date("2026-07-26T00:00:00Z"));
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: [],
        filters: [],
        timeRange: { expression: "今年" },
        timeGrain: { unit: "MONTH" },
        resultKind: "aggregate",
        title: "今年月度销售额",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "DATE_TRUNC(t0.`paid_at`, 'month') AS `月份`",
    );
    expect(compiled.sql).toContain(
      "GROUP BY DATE_TRUNC(t0.`paid_at`, 'month')",
    );
    expect(compiled.sql).toContain("ORDER BY `月份` ASC");
    expect(compiled.ir).toMatchObject({
      version: 2,
      grain: "月份",
      timeGrain: { unit: "MONTH", propertyId: "p_paid_at" },
    });
  });

  it("compiles year-over-year growth with same-progress YTD ranges", () => {
    const ontology = ontologyWithTime();
    const compiler = new QueryIrCompiler(() => new Date("2026-07-26T00:00:00Z"));
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: [],
        filters: [],
        timeRange: { expression: "今年" },
        timeGrain: { unit: "MONTH" },
        timeComparisons: [{
          id: "calc_yoy",
          label: "销售额同比",
          measureId: "m_gmv",
          comparison: "YEAR_OVER_YEAR",
          output: "GROWTH_RATE",
        }],
        resultKind: "aggregate",
        title: "今年月度销售额同比",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain("WITH `base` AS (");
    expect(compiled.sql).toContain(
      "p0.`__time_bucket` = DATE_SUB(c.`__time_bucket`, INTERVAL 1 YEAR)",
    );
    expect(compiled.sql).toContain(
      "(t0.`paid_at` >= ? AND t0.`paid_at` < ?)",
    );
    expect(compiled.sql).toContain("OR");
    expect(compiled.sql).toContain("AS `销售额同比`");
    expect(compiled.parameters).toEqual([
      "2026-01-01 00:00:00",
      "2026-07-27 00:00:00",
      "2025-01-01 00:00:00",
      "2025-07-27 00:00:00",
      "2026-01-01 00:00:00",
      "2026-07-27 00:00:00",
    ]);
    expect(compiled.ir.timeRange).toEqual({
      propertyId: "p_paid_at",
      expression: "今年",
      start: "2026-01-01 00:00:00",
      endExclusive: "2026-07-27 00:00:00",
      mode: "TO_DATE",
      comparisonRanges: [{
        comparison: "YEAR_OVER_YEAR",
        start: "2025-01-01 00:00:00",
        endExclusive: "2025-07-27 00:00:00",
      }],
    });
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "同比基期",
        value: "2025-01-01 00:00:00 至 2025-07-27 00:00:00",
        source: "IR 同进度时间窗口",
      }),
    );
  });

  it("keeps an explicit completed year on full-period comparison ranges", () => {
    const ontology = ontologyWithTime();
    const compiler = new QueryIrCompiler(() => new Date("2026-07-26T00:00:00Z"));
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: [],
        filters: [],
        timeRange: { expression: "2025年" },
        timeGrain: { unit: "YEAR" },
        timeComparisons: [{
          id: "calc_yoy",
          label: "销售额同比",
          measureId: "m_gmv",
          comparison: "YEAR_OVER_YEAR",
          output: "GROWTH_RATE",
        }],
        resultKind: "aggregate",
        title: "2025年销售额同比",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.ir.timeRange).toMatchObject({
      start: "2025-01-01 00:00:00",
      endExclusive: "2026-01-01 00:00:00",
      mode: "FULL_PERIOD",
      comparisonRanges: [{
        comparison: "YEAR_OVER_YEAR",
        start: "2024-01-01 00:00:00",
        endExclusive: "2025-01-01 00:00:00",
      }],
    });
  });

  it("compiles governed ratios and protects division by zero", () => {
    const ontology = ontologyWithTime();
    ontology.metrics.push({
      ...ontology.metrics[0]!,
      id: "m_refund",
      name: "refund_amount",
      label: "退款金额",
      sourcePropertyId: "p_refund_amount",
      expression: "SUM(fact_orders.refund_amount)",
      synonyms: ["退款额"],
    });
    ontology.objects[0]!.properties.push({
      ...ontology.objects[0]!.properties[1]!,
      id: "p_refund_amount",
      name: "refund_amount",
      label: "退款金额",
      sourceColumn: "refund_amount",
    });
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_refund", "m_gmv"],
        dimensionPropertyIds: [],
        filters: [],
        derivedMeasures: [{
          id: "calc_refund_rate",
          label: "退款率",
          operator: "RATIO",
          leftMeasureId: "m_refund",
          rightMeasureId: "m_gmv",
          scale: 100,
        }],
        resultKind: "aggregate",
        title: "退款率",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain("NULLIF((SUM(t0.`pay_amount`)), 0) * 100");
    expect(compiled.sql).toContain("AS `退款率`");
  });

  it("preserves nested derived calculation dependencies for gross margin", () => {
    const ontology = ontologyWithTime();
    ontology.metrics = [];
    ontology.objects[0]!.properties.push({
      ...ontology.objects[0]!.properties[1]!,
      id: "p_cost_amount",
      name: "cost_amount",
      label: "成本额",
      sourceColumn: "cost_amount",
    });
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["p_order_amount", "p_cost_amount"],
        dimensionPropertyIds: [],
        filters: [],
        derivedMeasures: [
          {
            id: "calc_gross_profit",
            label: "毛利额",
            operator: "SUBTRACT",
            leftMeasureId: "p_order_amount",
            rightMeasureId: "p_cost_amount",
          },
          {
            id: "calc_gross_margin",
            label: "毛利率",
            operator: "RATIO",
            leftMeasureId: "calc_gross_profit",
            rightMeasureId: "p_order_amount",
            scale: 100,
          },
        ],
        resultKind: "aggregate",
        title: "毛利率",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "((SUM(t0.`pay_amount`) - SUM(t0.`cost_amount`))) / NULLIF((SUM(t0.`pay_amount`)), 0) * 100",
    );
    expect(compiled.sql).not.toContain(
      "(SUM(t0.`pay_amount`)) / NULLIF((SUM(t0.`cost_amount`)), 0)",
    );
  });

  it("rejects cycles between temporary derived calculations", () => {
    const ontology = ontologyWithTime();
    const compiler = new QueryIrCompiler();

    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["m_gmv"],
          dimensionPropertyIds: [],
          filters: [],
          derivedMeasures: [
            {
              id: "calc_a",
              label: "计算A",
              operator: "ADD",
              leftMeasureId: "calc_b",
              rightMeasureId: "m_gmv",
            },
            {
              id: "calc_b",
              label: "计算B",
              operator: "SUBTRACT",
              leftMeasureId: "calc_a",
              rightMeasureId: "m_gmv",
            },
          ],
          resultKind: "aggregate",
          title: "循环指标",
        },
        ontology,
        [ordersTable()],
      ),
    ).toThrow("循环依赖");
  });

  it("compiles a persisted composite metric dependency DAG", () => {
    const ontology = ontologyWithTime();
    ontology.objects[0]!.properties.push({
      ...ontology.objects[0]!.properties[1]!,
      id: "p_cost_amount",
      name: "cost_amount",
      label: "成本额",
      sourceColumn: "cost_amount",
    });
    ontology.metrics.push(
      {
        ...ontology.metrics[0]!,
        id: "m_cost",
        metricType: "BASE",
        name: "cost_amount",
        label: "成本额",
        sourcePropertyId: "p_cost_amount",
        expression: "SUM(fact_orders.cost_amount)",
      },
      {
        ...ontology.metrics[0]!,
        id: "m_gross_profit",
        metricType: "DERIVED",
        name: "gross_profit",
        label: "毛利额",
        sourcePropertyId: undefined,
        aggregation: "CUSTOM",
        leftMetricId: "m_gmv",
        rightMetricId: "m_cost",
        calculationOperator: "SUBTRACT",
        scale: 1,
        expression: "(成交金额 - 成本额)",
      },
      {
        ...ontology.metrics[0]!,
        id: "m_gross_margin",
        metricType: "DERIVED",
        name: "gross_margin",
        label: "毛利率",
        sourcePropertyId: undefined,
        aggregation: "CUSTOM",
        leftMetricId: "m_gross_profit",
        rightMetricId: "m_gmv",
        calculationOperator: "RATIO",
        scale: 100,
        format: "percent",
        expression: "(毛利额 / 成交金额) * 100",
      },
    );
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gross_margin"],
        dimensionPropertyIds: [],
        filters: [],
        resultKind: "aggregate",
        title: "毛利率",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "((SUM(t0.`pay_amount`) - SUM(t0.`cost_amount`))) / NULLIF((SUM(t0.`pay_amount`)), 0) * 100",
    );
    expect(compiled.sql).toContain("AS `毛利率`");
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "指标",
        value: "毛利率",
        source: expect.stringContaining("毛利额"),
      }),
    );
  });

  it("compiles nested OR and NOT filter logic with parameters", () => {
    const ontology = ontologyWithTime();
    ontology.objects[0]!.properties.push(
      {
        ...ontology.objects[0]!.properties[0]!,
        id: "p_status",
        name: "status",
        label: "订单状态",
        sourceColumn: "status",
        meaning: "CATEGORY",
        unique: false,
      },
      {
        ...ontology.objects[0]!.properties[0]!,
        id: "p_region",
        name: "region",
        label: "区域",
        sourceColumn: "region",
        meaning: "CATEGORY",
        unique: false,
      },
    );
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: [],
        filters: [],
        filterExpression: {
          type: "GROUP",
          operator: "OR",
          children: [
            {
              type: "CONDITION",
              filter: { propertyId: "p_status", operator: "EQ", value: "PAID" },
            },
            {
              type: "NOT",
              child: {
                type: "CONDITION",
                filter: { propertyId: "p_region", operator: "EQ", value: "华北" },
              },
            },
          ],
        },
        resultKind: "aggregate",
        title: "筛选测试",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "((t0.`status` = ?) OR (NOT (t0.`region` = ?)))",
    );
    expect(compiled.parameters).toEqual(["PAID", "华北"]);
  });

  it("compiles ranking, running sum and moving average windows", () => {
    const ontology = ontologyWithTime();
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: ["p_store_id"],
        filters: [],
        timeGrain: { unit: "MONTH" },
        windowCalculations: [
          {
            id: "calc_rank",
            label: "门店排名",
            measureId: "m_gmv",
            operator: "RANK",
            partitionByPropertyIds: ["__time__"],
            orderBy: { entityId: "m_gmv", direction: "DESC" },
          },
          {
            id: "calc_running",
            label: "累计销售额",
            measureId: "m_gmv",
            operator: "RUNNING_SUM",
            partitionByPropertyIds: ["p_store_id"],
            orderBy: { entityId: "__time__", direction: "ASC" },
          },
          {
            id: "calc_ma3",
            label: "三期移动平均",
            measureId: "m_gmv",
            operator: "MOVING_AVG",
            partitionByPropertyIds: ["p_store_id"],
            orderBy: { entityId: "__time__", direction: "ASC" },
            windowSize: 3,
          },
        ],
        resultKind: "aggregate",
        title: "门店销售趋势",
      },
      ontology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain(
      "RANK() OVER (PARTITION BY c.`__time_bucket` ORDER BY c.`__m0` DESC)",
    );
    expect(compiled.sql).toContain(
      "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
    );
    expect(compiled.sql).toContain(
      "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW",
    );
  });

  it("computes percent of total before sorting and limiting", () => {
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: ["p_store_id"],
        filters: [],
        windowCalculations: [
          {
            id: "calc_total_share",
            label: "销售额占比",
            measureId: "m_gmv",
            operator: "PERCENT_OF_TOTAL",
            partitionByPropertyIds: [],
            scale: 100,
            precision: 2,
            denominatorScope: "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N",
          },
        ],
        sort: [{ entityId: "m_gmv", direction: "DESC" }],
        limit: 5,
        resultKind: "aggregate",
        title: "销售额前五门店占比",
      },
      testOntology,
      [ordersTable()],
    );

    expect(compiled.sql).toContain("WITH `base` AS (");
    expect(compiled.sql).toContain(
      "ROUND(((c.`__m0`) / NULLIF(SUM(c.`__m0`) OVER (), 0) * 100), 2) AS `销售额占比`",
    );
    expect(compiled.sql.indexOf("SUM(c.`__m0`) OVER ()")).toBeLessThan(
      compiled.sql.indexOf("LIMIT 5"),
    );
    expect(compiled.ir.windowCalculations[0]).toMatchObject({
      operator: "PERCENT_OF_TOTAL",
      denominatorScope: "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N",
    });
  });

  it("computes percent within composite partitions", () => {
    const compiler = new QueryIrCompiler();
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv"],
        dimensionPropertyIds: ["p_store_id", "p_customer_level", "p_order_id"],
        filters: [],
        windowCalculations: [
          {
            id: "calc_group_share",
            label: "门店会员等级销售占比",
            measureId: "m_gmv",
            operator: "PERCENT_OF_PARTITION",
            partitionByPropertyIds: ["p_store_id", "p_customer_level"],
            precision: 4,
          },
        ],
        resultKind: "aggregate",
        title: "门店会员等级组内销售占比",
      },
      testOntology,
      [ordersTable(), customerTable()],
    );

    expect(compiled.sql).toContain(
      "SUM(c.`__m0`) OVER (PARTITION BY c.`__d0`, c.`__d1`)",
    );
    expect(compiled.sql).toContain("* 100), 4)");
    expect(compiled.ir.windowCalculations[0]).toMatchObject({
      scale: 100,
      precision: 4,
      denominatorScope: "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N",
    });
  });

  it("rejects ambiguous self division and invalid share partitions", () => {
    const compiler = new QueryIrCompiler();
    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["m_gmv"],
          dimensionPropertyIds: ["p_store_id"],
          filters: [],
          derivedMeasures: [
            {
              id: "calc_wrong_share",
              label: "错误占比",
              operator: "RATIO",
              leftMeasureId: "m_gmv",
              rightMeasureId: "m_gmv",
              scale: 100,
            },
          ],
          resultKind: "aggregate",
          title: "错误占比",
        },
        testOntology,
        [ordersTable()],
      ),
    ).toThrow("不能用同一指标除以自身");

    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["m_gmv"],
          dimensionPropertyIds: ["p_store_id"],
          filters: [],
          windowCalculations: [
            {
              id: "calc_missing_partition",
              label: "组内占比",
              measureId: "m_gmv",
              operator: "PERCENT_OF_PARTITION",
              partitionByPropertyIds: [],
            },
          ],
          resultKind: "aggregate",
          title: "错误组内占比",
        },
        testOntology,
        [ordersTable()],
      ),
    ).toThrow("至少需要一个分区属性");
  });

  it("filters grouped base and composite metrics after aggregation", () => {
    const ontology = ontologyWithTime();
    ontology.objects[0]!.properties.push({
      id: "p_cost_amount",
      name: "cost_amount",
      label: "成本金额",
      description: "订单成本",
      dataType: "DECIMAL",
      sourceColumn: "cost_amount",
      sensitive: false,
      meaning: "NUMBER",
      unique: false,
      valueSearchable: false,
      numericSpec: {
        kind: "CURRENCY",
        currency: "CNY",
        defaultAggregation: "SUM",
        aggregationBehavior: "ADDITIVE",
      },
      visibility: "ANALYTICAL",
      synonyms: [],
      defaultDisplay: true,
      exportable: true,
      bindingPriority: 50,
    });
    ontology.metrics.push(
      {
        id: "m_cost",
        metricType: "BASE",
        name: "cost",
        label: "成本额",
        description: "成本金额合计",
        objectId: "o_order",
        expression: "SUM(fact_orders.cost_amount)",
        definitionMode: "VISUAL",
        sourcePropertyId: "p_cost_amount",
        timePropertyId: "p_paid_at",
        aggregation: "SUM",
        format: "currency",
        synonyms: [],
        status: "PUBLISHED",
      },
      {
        id: "m_profit",
        metricType: "DERIVED",
        name: "profit",
        label: "毛利额",
        description: "成交金额减成本额",
        objectId: "o_order",
        expression: "",
        definitionMode: "VISUAL",
        leftMetricId: "m_gmv",
        rightMetricId: "m_cost",
        calculationOperator: "SUBTRACT",
        aggregation: "CUSTOM",
        format: "currency",
        synonyms: [],
        status: "PUBLISHED",
      },
      {
        id: "m_margin",
        metricType: "DERIVED",
        name: "margin",
        label: "毛利率",
        description: "毛利额除以成交金额",
        objectId: "o_order",
        expression: "",
        definitionMode: "VISUAL",
        leftMetricId: "m_profit",
        rightMetricId: "m_gmv",
        calculationOperator: "RATIO",
        scale: 1,
        aggregation: "CUSTOM",
        format: "percent",
        synonyms: [],
        status: "PUBLISHED",
      },
    );
    const compiler = new QueryIrCompiler(() => new Date(2026, 6, 28));
    const compiled = compiler.compile(
      {
        rootObjectId: "o_order",
        measureIds: ["m_gmv", "m_margin"],
        dimensionPropertyIds: ["p_customer_level"],
        filters: [],
        aggregateFilterExpression: {
          type: "GROUP",
          operator: "AND",
          children: [
            {
              type: "CONDITION",
              filter: {
                entityId: "m_gmv",
                operator: "GT",
                value: 30_000_000,
              },
            },
            {
              type: "CONDITION",
              filter: {
                entityId: "m_margin",
                operator: "GT",
                value: 0.75,
              },
            },
          ],
        },
        timeRange: { expression: "今年" },
        sort: [{ entityId: "m_gmv", direction: "DESC" }],
        resultKind: "aggregate",
        title: "今年高销售额高毛利率客户等级",
      },
      ontology,
      [ordersTable(), customerTable()],
    );

    expect(compiled.sql).toContain("WITH `base` AS (");
    expect(compiled.sql).toContain("`analyzed` AS (");
    expect(compiled.sql).toContain("GROUP BY t1.`member_level`");
    expect(compiled.sql).toContain("FROM `analyzed` AS a");
    expect(compiled.sql).toContain(
      "WHERE ((a.`成交金额` > ?) AND (a.`毛利率` > ?))",
    );
    expect(compiled.sql).not.toContain("t0.`pay_amount` > ?");
    expect(compiled.parameters).toEqual([
      "2026-01-01 00:00:00",
      "2026-07-29 00:00:00",
      30_000_000,
      0.75,
    ]);
    expect(compiled.ir.aggregateFilters).toEqual([
      { entityId: "m_gmv", operator: "GT", value: 30_000_000 },
      { entityId: "m_margin", operator: "GT", value: 0.75 },
    ]);
    expect(compiled.bindings).toContainEqual(
      expect.objectContaining({
        label: "聚合后筛选",
        value: "毛利率 > 0.75",
        entityId: "m_margin",
      }),
    );
  });

  it("rejects aggregate filters that reference unselected metrics", () => {
    const compiler = new QueryIrCompiler();
    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["m_gmv"],
          dimensionPropertyIds: [],
          filters: [],
          aggregateFilters: [
            { entityId: "m_missing", operator: "GT", value: 100 },
          ],
          resultKind: "aggregate",
          title: "错误聚合筛选",
        },
        testOntology,
        [ordersTable()],
      ),
    ).toThrow("聚合后筛选引用了未提交的指标或计算项");
  });

  it("rejects semi-additive sums across a time grain", () => {
    const ontology = ontologyWithTime();
    ontology.objects[0]!.properties[1]!.numericSpec!.aggregationBehavior =
      "SEMI_ADDITIVE";
    const compiler = new QueryIrCompiler();

    expect(() =>
      compiler.compile(
        {
          rootObjectId: "o_order",
          measureIds: ["m_gmv"],
          dimensionPropertyIds: [],
          filters: [],
          timeGrain: { unit: "MONTH" },
          resultKind: "aggregate",
          title: "余额趋势",
        },
        ontology,
        [ordersTable()],
      ),
    ).toThrow("半可加指标");
  });
});

function ontologyWithTime() {
  const ontology = structuredClone(testOntology);
  ontology.objects[0]!.defaultTimePropertyId = "p_paid_at";
  ontology.objects[0]!.properties.push({
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
    bindingPriority: 50,
  });
  ontology.metrics[0]!.timePropertyId = "p_paid_at";
  return ontology;
}

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

function customerTable(): PhysicalTable {
  return {
    id: "t_customers",
    catalog: "internal",
    database: "retail",
    name: "dim_customers",
    type: "TABLE",
    status: "MODELED",
    columns: [],
    fingerprint: "dim_customers:v1",
    scannedAt: "2026-07-28T00:00:00.000Z",
  };
}
