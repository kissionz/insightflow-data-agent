import { describe, expect, it } from "vitest";
import type { AnalysisIntent } from "../src/shared/types.js";
import { createLiveResult } from "../src/server/result-artifact.js";
import type { QueryResult } from "../src/server/selectdb.js";
import { testOntology } from "./fixtures.js";

function analysisIntent(
  overrides: Partial<AnalysisIntent> = {},
): AnalysisIntent {
  return {
    rootObjectId: "o_order",
    measureIds: ["m_gmv"],
    dimensionPropertyIds: [],
    filters: [],
    resultKind: "aggregate",
    title: "分析结果",
    ...overrides,
  };
}

function queryResult(
  columns: string[],
  rows: QueryResult["rows"],
  truncated = false,
): QueryResult {
  return {
    columns,
    rows,
    durationMs: 12,
    truncated,
  };
}

describe("result visualization selection", () => {
  it("turns a single aggregate row into business KPIs without a chart", () => {
    const artifact = createLiveResult(
      analysisIntent({ title: "成交金额" }),
      queryResult(["成交金额"], [{ 成交金额: 12345.67 }]),
      testOntology,
    );

    expect(artifact.kpis).toEqual([
      { label: "成交金额", value: "¥12,345.67" },
    ]);
    expect(artifact.chart.type).toBe("none");
    expect(artifact.chart.rationale).toContain("业务指标");
  });

  it("uses a line chart for an ordered time grain", () => {
    const artifact = createLiveResult(
      analysisIntent({ timeGrain: { unit: "MONTH" } }),
      queryResult(
        ["月份", "成交金额"],
        [
          { 月份: "2026-01-01", 成交金额: 100 },
          { 月份: "2026-02-01", 成交金额: 130 },
        ],
      ),
      testOntology,
    );

    expect(artifact.chart).toMatchObject({
      type: "line",
      label: "趋势",
      categories: ["2026-01-01", "2026-02-01"],
      valueFormat: "currency",
    });
  });

  it("uses a donut only for a complete small share composition", () => {
    const artifact = createLiveResult(
      analysisIntent({
        dimensionPropertyIds: ["p_customer_level"],
        windowCalculations: [{
          id: "calc_share",
          label: "成交金额占比",
          measureId: "m_gmv",
          operator: "PERCENT_OF_TOTAL",
          partitionByPropertyIds: [],
          scale: 100,
        }],
      }),
      queryResult(
        ["会员等级", "成交金额", "成交金额占比"],
        [
          { 会员等级: "金卡", 成交金额: 50, 成交金额占比: 50 },
          { 会员等级: "银卡", 成交金额: 30, 成交金额占比: 30 },
          { 会员等级: "普通", 成交金额: 20, 成交金额占比: 20 },
        ],
      ),
      testOntology,
    );

    expect(artifact.chart).toMatchObject({
      type: "donut",
      label: "构成",
      categories: ["金卡", "银卡", "普通"],
      series: [{ name: "成交金额占比", data: [50, 30, 20] }],
    });
  });

  it("downgrades limited share results to a horizontal bar", () => {
    const artifact = createLiveResult(
      analysisIntent({
        dimensionPropertyIds: ["p_customer_level"],
        limit: 3,
        windowCalculations: [{
          id: "calc_share",
          label: "成交金额占比",
          measureId: "m_gmv",
          operator: "PERCENT_OF_TOTAL",
          partitionByPropertyIds: [],
          scale: 100,
        }],
      }),
      queryResult(
        ["会员等级", "成交金额", "成交金额占比"],
        [
          { 会员等级: "金卡", 成交金额: 50, 成交金额占比: 50 },
          { 会员等级: "银卡", 成交金额: 30, 成交金额占比: 30 },
          { 会员等级: "普通", 成交金额: 20, 成交金额占比: 20 },
        ],
      ),
      testOntology,
    );

    expect(artifact.chart.type).toBe("horizontal-bar");
    expect(artifact.chart.rationale).toContain("不满足完整环形图条件");
    expect(artifact.chart.valueFormat).toBe("percent");
    expect(artifact.chart.series).toEqual([
      { name: "成交金额占比", data: [50, 30, 20] },
    ]);
  });

  it("uses horizontal bars for rankings and vertical bars for short comparisons", () => {
    const result = queryResult(
      ["会员等级", "成交金额"],
      [
        { 会员等级: "金卡", 成交金额: 50 },
        { 会员等级: "银卡", 成交金额: 30 },
        { 会员等级: "普通", 成交金额: 20 },
      ],
    );
    const ranking = createLiveResult(
      analysisIntent({
        dimensionPropertyIds: ["p_customer_level"],
        sort: [{ entityId: "m_gmv", direction: "DESC" }],
      }),
      result,
      testOntology,
    );
    const comparison = createLiveResult(
      analysisIntent({ dimensionPropertyIds: ["p_customer_level"] }),
      result,
      testOntology,
    );

    expect(ranking.chart.type).toBe("horizontal-bar");
    expect(comparison.chart.type).toBe("bar");
  });

  it("keeps detail and mixed time-category results in the table", () => {
    const detail = createLiveResult(
      analysisIntent({ resultKind: "detail" }),
      queryResult(["订单号", "成交金额"], [{ 订单号: "A1", 成交金额: 10 }]),
      testOntology,
    );
    const mixed = createLiveResult(
      analysisIntent({
        dimensionPropertyIds: ["p_customer_level"],
        timeGrain: { unit: "MONTH" },
      }),
      queryResult(
        ["会员等级", "月份", "成交金额"],
        [
          { 会员等级: "金卡", 月份: "2026-01-01", 成交金额: 10 },
          { 会员等级: "银卡", 月份: "2026-01-01", 成交金额: 8 },
        ],
      ),
      testOntology,
    );

    expect(detail.chart.type).toBe("none");
    expect(mixed.chart.type).toBe("none");
  });
});
