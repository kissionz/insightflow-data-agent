import type {
  AnalysisIntent,
  OntologySnapshot,
  ResultArtifact,
  ResultSeries,
  ResultValueFormat,
  TimeGrain,
} from "../shared/types.js";
import type { QueryResult } from "./selectdb.js";

const MAX_VERTICAL_CATEGORIES = 12;
const MAX_HORIZONTAL_CATEGORIES = 20;
const MAX_LINE_SERIES = 3;

const TIME_COLUMN_LABELS: Record<TimeGrain, string> = {
  DAY: "日期",
  WEEK: "周",
  MONTH: "月份",
  QUARTER: "季度",
  YEAR: "年份",
};

interface ColumnPresentation {
  format: ResultValueFormat;
  unit?: string;
}

export function createLiveResult(
  intent: AnalysisIntent,
  query: QueryResult,
  ontology: OntologySnapshot,
): ResultArtifact {
  const rows = query.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "number" ? value : value == null ? "—" : String(value),
      ]),
    ),
  ) as ResultArtifact["rows"];
  const dimensions = query.columns.slice(0, intent.dimensionPropertyIds.length);
  const timeColumn = intent.timeGrain
    ? query.columns[intent.dimensionPropertyIds.length] ??
      TIME_COLUMN_LABELS[intent.timeGrain.unit]
    : undefined;
  const categoryColumns = [...dimensions, ...(timeColumn ? [timeColumn] : [])];
  const numericColumns = query.columns.filter(
    (column) =>
      !categoryColumns.includes(column) &&
      query.rows.some((row) => typeof row[column] === "number"),
  );
  const presentations = buildColumnPresentations(intent, ontology);
  const kpis = rows.length === 1
    ? numericColumns.slice(0, 4).map((column) => ({
        label: column,
        value: formatKpiValue(
          Number(rows[0]?.[column] ?? 0),
          presentations.get(column),
        ),
      }))
    : [];
  const chart = selectChart(
    intent,
    query,
    numericColumns,
    dimensions,
    timeColumn,
    presentations,
  );

  return {
    kind: "analysis",
    mode: "live",
    conclusion: "",
    kpis,
    chart: {
      title: intent.title,
      ...chart,
    },
    columns: query.columns,
    rows,
    rowCount: query.rows.length,
    truncated: query.truncated,
  };
}

function selectChart(
  intent: AnalysisIntent,
  query: QueryResult,
  numericColumns: string[],
  dimensions: string[],
  timeColumn: string | undefined,
  presentations: Map<string, ColumnPresentation>,
): Omit<ResultArtifact["chart"], "title"> {
  if (!query.rows.length) {
    return noChart("查询没有返回可绘制的数据。");
  }
  if (intent.resultKind === "detail") {
    return noChart("明细结果保留原始字段，使用数据表查看。");
  }
  if (intent.periodConditions?.length) {
    return noChart("跨期间条件结果包含集合判断，使用数据表避免遗漏条件语义。");
  }
  if (!numericColumns.length) {
    return noChart("结果中没有可用于图表的数值指标。");
  }
  if (query.rows.length === 1) {
    return noChart("单行聚合已提炼为业务指标。");
  }

  if (timeColumn) {
    if (dimensions.length) {
      return noChart("结果同时包含时间和分类维度，当前使用数据表避免系列混叠。");
    }
    const selectedColumns = compatibleColumns(
      numericColumns,
      presentations,
      MAX_LINE_SERIES,
    );
    const categories = query.rows.map((row) => String(row[timeColumn] ?? "—"));
    return {
      type: "line",
      label: "趋势",
      rationale: `结果按${TIME_COLUMN_LABELS[intent.timeGrain!.unit]}连续排列，使用折线图观察变化。`,
      note:
        selectedColumns.length < numericColumns.length
          ? "不同单位的指标未叠加，完整结果见数据表。"
          : undefined,
      categoryLabel: timeColumn,
      valueFormat: presentations.get(selectedColumns[0]!)?.format ?? "number",
      categories,
      series: buildSeries(query, selectedColumns),
    };
  }

  const categoryColumns = dimensions.length
    ? dimensions
    : query.columns.filter((column) => !numericColumns.includes(column)).slice(0, 1);
  if (!categoryColumns.length) {
    return noChart("结果缺少可靠的分类轴，使用数据表查看。");
  }
  const categories = query.rows.map((row) =>
    categoryColumns.map((column) => String(row[column] ?? "—")).join(" / "),
  );
  const share = intent.windowCalculations?.find(
    (calculation) => calculation.operator === "PERCENT_OF_TOTAL",
  );
  const shareColumn = share && numericColumns.includes(share.label)
    ? share.label
    : undefined;
  const shareValues = shareColumn
    ? query.rows.map((row) => chartNumber(row[shareColumn]))
    : [];
  const expectedShareTotal = share?.scale ?? 100;
  const shareTotal = shareValues.reduce<number>(
    (total, value) => total + (value ?? 0),
    0,
  );
  const safeDonut = Boolean(
    shareColumn &&
      intent.dimensionPropertyIds.length === 1 &&
      intent.limit == null &&
      !query.truncated &&
      query.rows.length >= 2 &&
      query.rows.length <= 6 &&
      shareValues.every((value) => value != null && value >= 0) &&
      Math.abs(shareTotal - expectedShareTotal) <= Math.max(0.01, expectedShareTotal * 0.01),
  );
  if (safeDonut && shareColumn) {
    return {
      type: "donut",
      label: "构成",
      rationale: `完整占比由 ${query.rows.length} 个互斥分类组成，使用环形图展示构成。`,
      categoryLabel: categoryColumns.join(" / "),
      valueFormat: "percent",
      categories,
      series: buildSeries(query, [shareColumn]),
    };
  }

  const rankedEntityIds = new Set([
    ...intent.measureIds,
    ...(intent.derivedMeasures ?? []).map((item) => item.id),
    ...(intent.timeComparisons ?? []).map((item) => item.id),
    ...(intent.windowCalculations ?? []).map((item) => item.id),
  ]);
  const ranked = Boolean(
    intent.groupSelections?.length ||
      intent.sort?.some((sort) => rankedEntityIds.has(sort.entityId)),
  );
  const hasLongLabels = categories.some((category) => category.length > 8);
  const horizontal = ranked || categories.length > 8 || hasLongLabels || Boolean(shareColumn);
  const maxCategories = horizontal
    ? MAX_HORIZONTAL_CATEGORIES
    : MAX_VERTICAL_CATEGORIES;
  const selectedColumns = shareColumn
    ? [shareColumn]
    : compatibleColumns(
        numericColumns,
        presentations,
        MAX_LINE_SERIES,
      );
  const visibleRows = query.rows.slice(0, maxCategories);
  const visibleCategories = categories.slice(0, maxCategories);
  const limited = visibleRows.length < query.rows.length;

  return {
    type: horizontal ? "horizontal-bar" : "bar",
    label: ranked ? "排名" : "对比",
    rationale: horizontal
      ? shareColumn
        ? "占比结果不满足完整环形图条件，改用横向条形图准确比较。"
        : "结果包含排序或较长分类名称，使用横向条形图便于比较。"
      : "分类数量适中，使用柱状图比较指标差异。",
    note: [
      limited ? `图表显示前 ${visibleRows.length} 项，完整结果见数据表。` : "",
      selectedColumns.length < numericColumns.length
        ? "不同单位的指标未叠加。"
        : "",
    ].filter(Boolean).join(" ") || undefined,
    categoryLabel: categoryColumns.join(" / "),
    valueFormat: presentations.get(selectedColumns[0]!)?.format ?? "number",
    categories: visibleCategories,
    series: selectedColumns.map((column) => ({
      name: column,
      data: visibleRows.map((row) => chartNumber(row[column])),
    })),
  };
}

function noChart(rationale: string): Omit<ResultArtifact["chart"], "title"> {
  return {
    type: "none",
    label: "数据",
    rationale,
    categories: [],
    series: [],
  };
}

function buildSeries(query: QueryResult, columns: string[]): ResultSeries[] {
  return columns.map((column) => ({
    name: column,
    data: query.rows.map((row) => chartNumber(row[column])),
  }));
}

function chartNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compatibleColumns(
  columns: string[],
  presentations: Map<string, ColumnPresentation>,
  limit: number,
): string[] {
  const firstFormat = presentations.get(columns[0]!)?.format ?? "number";
  return columns
    .filter((column) => (presentations.get(column)?.format ?? "number") === firstFormat)
    .slice(0, limit);
}

function buildColumnPresentations(
  intent: AnalysisIntent,
  ontology: OntologySnapshot,
): Map<string, ColumnPresentation> {
  const result = new Map<string, ColumnPresentation>();
  const metrics = new Map(ontology.metrics.map((metric) => [metric.id, metric]));
  const presentationById = new Map<string, ColumnPresentation>();
  for (const metricId of intent.measureIds) {
    const metric = metrics.get(metricId);
    if (!metric) continue;
    const presentation = { format: metric.format, unit: metric.unit };
    presentationById.set(metricId, presentation);
    result.set(metric.label, presentation);
  }
  for (const calculation of intent.derivedMeasures ?? []) {
    const presentation: ColumnPresentation = {
      format:
        (calculation.operator === "RATIO" || calculation.operator === "DIVIDE") &&
          calculation.scale === 100
          ? "percent"
          : "number",
    };
    presentationById.set(calculation.id, presentation);
    result.set(calculation.label, presentation);
  }
  for (const comparison of intent.timeComparisons ?? []) {
    const presentation = comparison.output === "GROWTH_RATE"
      ? { format: "percent" as const }
      : presentationById.get(comparison.measureId) ?? { format: "number" as const };
    presentationById.set(comparison.id, presentation);
    result.set(comparison.label, presentation);
  }
  for (const calculation of intent.windowCalculations ?? []) {
    const presentation = calculation.operator === "PERCENT_OF_TOTAL" ||
        calculation.operator === "PERCENT_OF_PARTITION"
      ? { format: "percent" as const }
      : presentationById.get(calculation.measureId) ?? { format: "number" as const };
    presentationById.set(calculation.id, presentation);
    result.set(calculation.label, presentation);
  }
  return result;
}

function formatKpiValue(
  value: number,
  presentation: ColumnPresentation | undefined,
): string {
  const formatted = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
  }).format(value);
  if (presentation?.unit) return `${formatted} ${presentation.unit}`;
  if (presentation?.format === "currency") return `¥${formatted}`;
  if (presentation?.format === "percent") return `${formatted}%`;
  return formatted;
}
