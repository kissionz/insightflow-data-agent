import type {
  AnalysisIntent,
  Metric,
  OntologyObject,
  OntologyProperty,
  OntologySnapshot,
  PhysicalTable,
  QueryFilterOperator,
  QueryIR,
} from "../shared/types.js";
import { SemanticIndex } from "./semantic-index.js";

export interface CompiledQuery {
  ir: QueryIR;
  sql: string;
  parameters: unknown[];
  bindings: Array<{
    label: string;
    value: string;
    source: string;
    entityId?: string;
  }>;
  planSummary: string;
}

export class QueryIrCompiler {
  constructor(private readonly now: () => Date = () => new Date()) {}

  compile(
    intent: AnalysisIntent,
    ontology: OntologySnapshot,
    tables: PhysicalTable[],
    timezone = "Asia/Shanghai",
  ): CompiledQuery {
    const objectById = new Map(ontology.objects.map((object) => [object.id, object]));
    const metricById = new Map(ontology.metrics.map((metric) => [metric.id, metric]));
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const propertyOwners = ontology.objects.flatMap((object) =>
      object.properties.map((property) => ({ object, property })),
    );
    const measures = intent.measureIds.map((id) => {
      const metric = metricById.get(id);
      if (!metric) throw new Error(`查询计划引用了不存在的指标：${id}`);
      return metric;
    });
    const dimensions = intent.dimensionPropertyIds.map((id) =>
      requireProperty(propertyOwners, id, "分析维度"),
    );
    const filters = intent.filters.map((filter) => ({
      ...filter,
      binding: requireProperty(propertyOwners, filter.propertyId, "筛选条件"),
    }));
    const inferredRootId =
      intent.rootObjectId ??
      measures[0]?.objectId ??
      dimensions[0]?.object.id ??
      filters[0]?.binding.object.id;
    if (!inferredRootId) throw new Error("查询计划缺少主业务对象");
    const root = objectById.get(inferredRootId);
    if (!root) throw new Error(`主业务对象不存在：${inferredRootId}`);
    const rootTable = tableById.get(root.sourceTableId);
    if (!rootTable) throw new Error(`业务对象 ${root.label} 的来源表不可用`);

    const timeBinding = intent.timeRange
      ? resolveTimeBinding(intent, root, measures, propertyOwners)
      : undefined;
    const requiredObjectIds = new Set([
      root.id,
      ...measures.map((metric) => metric.objectId),
      ...dimensions.map((binding) => binding.object.id),
      ...filters.map((filter) => filter.binding.object.id),
      ...(timeBinding ? [timeBinding.object.id] : []),
    ]);
    const semanticIndex = new SemanticIndex(ontology);
    const relationIds: string[] = [];
    const orderedObjects: OntologyObject[] = [root];
    for (const objectId of requiredObjectIds) {
      if (objectId === root.id) continue;
      const path = semanticIndex.findRelationPath(root.id, objectId);
      if (!path.length) {
        throw new Error(
          `对象 ${root.label} 与 ${objectById.get(objectId)?.label ?? objectId} 之间没有可用关系`,
        );
      }
      let currentId = root.id;
      for (const relation of path) {
        if (relation.fanoutRisk === "HIGH" || relation.cardinality === "MANY_TO_MANY") {
          throw new Error(`关系 ${relation.name} 存在高扇出风险，需要先补充聚合规则`);
        }
        if (!relationIds.includes(relation.id)) relationIds.push(relation.id);
        const nextId =
          relation.sourceObjectId === currentId
            ? relation.targetObjectId
            : relation.sourceObjectId;
        const nextObject = objectById.get(nextId);
        if (!nextObject) throw new Error(`关系 ${relation.name} 引用了不存在的对象`);
        if (!orderedObjects.some((object) => object.id === nextId)) {
          orderedObjects.push(nextObject);
        }
        currentId = nextId;
      }
    }

    const aliases = new Map(
      orderedObjects.map((object, index) => [object.id, `t${index}`]),
    );
    const tablesByObject = new Map(
      orderedObjects.map((object) => {
        const table = tableById.get(object.sourceTableId);
        if (!table) throw new Error(`业务对象 ${object.label} 的来源表不可用`);
        return [object.id, table] as const;
      }),
    );
    const selectParts: string[] = [];
    const groupParts: string[] = [];
    for (const binding of dimensions) {
      const expression = qualifiedColumn(
        aliases.get(binding.object.id)!,
        binding.property,
      );
      selectParts.push(`${expression} AS ${quoteIdentifier(binding.property.label)}`);
      groupParts.push(expression);
    }
    for (const metric of measures) {
      const object = objectById.get(metric.objectId);
      if (!object) throw new Error(`指标 ${metric.label} 的所属对象不存在`);
      selectParts.push(
        `${compileMetric(metric, object, aliases, tablesByObject)} AS ${quoteIdentifier(metric.label)}`,
      );
    }
    if (!selectParts.length) {
      if (intent.resultKind !== "detail") throw new Error("聚合查询至少需要一个指标");
      for (const property of root.properties.filter(
        (candidate) =>
          candidate.visibility === "ANALYTICAL" && !candidate.sensitive,
      ).slice(0, 12)) {
        selectParts.push(
          `${qualifiedColumn(aliases.get(root.id)!, property)} AS ${quoteIdentifier(property.label)}`,
        );
      }
    }

    const from = `${qualifiedTable(rootTable)} AS ${aliases.get(root.id)}`;
    const joins = compileJoins(
      relationIds,
      root.id,
      ontology,
      objectById,
      aliases,
      tablesByObject,
    );
    const parameters: unknown[] = [];
    const whereParts: string[] = [];
    for (const object of orderedObjects) {
      if (object.defaultFilter?.trim()) {
        whereParts.push(
          `(${rewriteGovernedExpression(object.defaultFilter, aliases, tablesByObject)})`,
        );
      }
    }
    for (const filter of filters) {
      whereParts.push(
        compileFilter(
          qualifiedColumn(
            aliases.get(filter.binding.object.id)!,
            filter.binding.property,
          ),
          filter.operator,
          filter.value,
          parameters,
        ),
      );
    }

    let resolvedTime: QueryIR["timeRange"];
    if (intent.timeRange && timeBinding) {
      const range = resolveNaturalTimeRange(
        intent.timeRange.expression,
        this.now(),
        timezone,
      );
      const column = qualifiedColumn(
        aliases.get(timeBinding.object.id)!,
        timeBinding.property,
      );
      whereParts.push(`${column} >= ?`);
      parameters.push(range.start);
      whereParts.push(`${column} < ?`);
      parameters.push(range.endExclusive);
      resolvedTime = {
        propertyId: timeBinding.property.id,
        expression: intent.timeRange.expression,
        ...range,
      };
    }

    const limit = Math.min(
      Math.max(1, Math.trunc(intent.limit ?? (intent.resultKind === "detail" ? 50 : 200))),
      intent.resultKind === "detail" ? 50 : 200,
    );
    const sort = intent.sort ?? [];
    const orderParts = sort.map((item) => {
      const metric = metricById.get(item.entityId);
      if (metric) return `${quoteIdentifier(metric.label)} ${item.direction}`;
      const binding = requireProperty(propertyOwners, item.entityId, "排序字段");
      return `${qualifiedColumn(aliases.get(binding.object.id)!, binding.property)} ${item.direction}`;
    });
    const sql = [
      `SELECT ${selectParts.join(", ")}`,
      `FROM ${from}`,
      ...joins,
      whereParts.length ? `WHERE ${whereParts.join("\n  AND ")}` : "",
      groupParts.length ? `GROUP BY ${groupParts.join(", ")}` : "",
      orderParts.length ? `ORDER BY ${orderParts.join(", ")}` : "",
      `LIMIT ${limit}`,
    ]
      .filter(Boolean)
      .join("\n");
    const grain =
      intent.resultKind === "detail"
        ? effectiveGrainLabel(root)
        : dimensions.length
          ? dimensions.map((binding) => binding.property.label).join("、")
          : "整体汇总";
    const ir: QueryIR = {
      version: 1,
      ontologyVersion: ontology.version,
      rootObjectId: root.id,
      measureIds: measures.map((metric) => metric.id),
      dimensionPropertyIds: dimensions.map((binding) => binding.property.id),
      filters: filters.map(({ binding: _binding, ...filter }) => filter),
      timeRange: resolvedTime,
      relationIds,
      grain,
      resultKind: intent.resultKind,
      sort,
      limit,
    };
    const bindings = [
      {
        label: "业务对象",
        value: root.label,
        source: "本体对象",
        entityId: root.id,
      },
      ...measures.map((metric) => ({
        label: "指标",
        value: metric.label,
        source: "指标ID精确绑定",
        entityId: metric.id,
      })),
      ...dimensions.map(({ property }) => ({
        label: "维度",
        value: property.label,
        source: "属性ID精确绑定",
        entityId: property.id,
      })),
      ...filters.map(({ binding, businessValue, value }) => ({
        label: "筛选条件",
        value: `${binding.property.label} = ${businessValue ?? formatValue(value)}`,
        source:
          businessValue && businessValue !== formatValue(value)
            ? `属性值索引映射为 ${formatValue(value)}`
            : "属性值绑定",
        entityId: binding.property.id,
      })),
      ...(resolvedTime && timeBinding
        ? [{
            label: "时间范围",
            value: `${timeBinding.property.label}：${resolvedTime.start} 至 ${resolvedTime.endExclusive}`,
            source: `自然时间“${resolvedTime.expression}”`,
            entityId: timeBinding.property.id,
          }]
        : []),
    ];
    return {
      ir,
      sql,
      parameters,
      bindings,
      planSummary: `${root.label} · ${grain} · ${measures.length} 个指标 · ${filters.length + (resolvedTime ? 1 : 0)} 个条件`,
    };
  }
}

function requireProperty(
  owners: Array<{ object: OntologyObject; property: OntologyProperty }>,
  propertyId: string,
  usage: string,
): { object: OntologyObject; property: OntologyProperty } {
  const binding = owners.find((candidate) => candidate.property.id === propertyId);
  if (!binding) throw new Error(`${usage}引用了不存在的属性：${propertyId}`);
  if (binding.property.visibility !== "ANALYTICAL" || binding.property.sensitive) {
    throw new Error(`${usage}不能使用属性：${binding.property.label}`);
  }
  return binding;
}

function resolveTimeBinding(
  intent: AnalysisIntent,
  root: OntologyObject,
  measures: Metric[],
  owners: Array<{ object: OntologyObject; property: OntologyProperty }>,
): { object: OntologyObject; property: OntologyProperty } {
  const explicitId = intent.timeRange?.propertyId;
  const metricTimeIds = [
    ...new Set(measures.map((metric) => metric.timePropertyId).filter(Boolean)),
  ] as string[];
  const inferredId =
    explicitId ??
    (metricTimeIds.length === 1 ? metricTimeIds[0] : undefined) ??
    root.defaultTimePropertyId;
  if (inferredId) {
    const binding = requireProperty(owners, inferredId, "时间范围");
    if (binding.property.meaning !== "TIME") {
      throw new Error(`属性 ${binding.property.label} 不是时间属性`);
    }
    return binding;
  }
  const candidates = root.properties.filter(
    (property) =>
      property.meaning === "TIME" && property.visibility === "ANALYTICAL",
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? `对象 ${root.label} 有多个时间属性，请明确使用哪个时间口径`
        : `对象 ${root.label} 没有可用时间属性`,
    );
  }
  return { object: root, property: candidates[0] };
}

function compileMetric(
  metric: Metric,
  object: OntologyObject,
  aliases: Map<string, string>,
  tables: Map<string, PhysicalTable>,
): string {
  const alias = aliases.get(object.id)!;
  if (metric.definitionMode === "SQL") {
    return rewriteGovernedExpression(metric.expression, aliases, tables);
  }
  if (metric.aggregation === "COUNT") {
    return metric.filterExpression
      ? `COUNT(CASE WHEN ${rewriteGovernedExpression(metric.filterExpression, aliases, tables)} THEN 1 END)`
      : "COUNT(*)";
  }
  const property = object.properties.find(
    (candidate) => candidate.id === metric.sourcePropertyId,
  );
  if (!property) throw new Error(`指标 ${metric.label} 缺少计算属性`);
  const column = qualifiedColumn(alias, property);
  if (metric.filterExpression) {
    const filter = rewriteGovernedExpression(
      metric.filterExpression,
      aliases,
      tables,
    );
    return metric.aggregation === "COUNT_DISTINCT"
      ? `COUNT(DISTINCT CASE WHEN ${filter} THEN ${column} END)`
      : `${metric.aggregation}(CASE WHEN ${filter} THEN ${column} END)`;
  }
  return metric.aggregation === "COUNT_DISTINCT"
    ? `COUNT(DISTINCT ${column})`
    : `${metric.aggregation}(${column})`;
}

function compileJoins(
  relationIds: string[],
  rootObjectId: string,
  ontology: OntologySnapshot,
  objects: Map<string, OntologyObject>,
  aliases: Map<string, string>,
  tables: Map<string, PhysicalTable>,
): string[] {
  const joined = new Set([rootObjectId]);
  const clauses: string[] = [];
  for (const relationId of relationIds) {
    const relation = ontology.relations.find((candidate) => candidate.id === relationId);
    if (!relation) throw new Error(`查询计划引用了不存在的关系：${relationId}`);
    const source = objects.get(relation.sourceObjectId);
    const target = objects.get(relation.targetObjectId);
    const sourceJoined = joined.has(relation.sourceObjectId);
    const targetJoined = joined.has(relation.targetObjectId);
    if (sourceJoined && targetJoined) continue;
    const joinedObjectId = sourceJoined
      ? relation.targetObjectId
      : targetJoined
        ? relation.sourceObjectId
        : "";
    if (!joinedObjectId) {
      throw new Error(`关系 ${relation.name} 无法连接到当前查询路径`);
    }
    const joinedTable = tables.get(joinedObjectId);
    const sourceProperty = source?.properties.find(
      (property) => property.id === relation.sourcePropertyId,
    );
    const targetProperty = target?.properties.find(
      (property) => property.id === relation.targetPropertyId,
    );
    if (!source || !target || !joinedTable || !sourceProperty || !targetProperty) {
      throw new Error(`关系 ${relation.name} 缺少可编译的关联属性`);
    }
    const condition = `${qualifiedColumn(aliases.get(source.id)!, sourceProperty)} = ${qualifiedColumn(aliases.get(target.id)!, targetProperty)}`;
    clauses.push(
      `${relation.required ? "INNER" : "LEFT"} JOIN ${qualifiedTable(joinedTable)} AS ${aliases.get(joinedObjectId)} ON ${condition}`,
    );
    joined.add(joinedObjectId);
  }
  return clauses;
}

function compileFilter(
  column: string,
  operator: QueryFilterOperator,
  value: string | string[] | undefined,
  parameters: unknown[],
): string {
  if (operator === "IS_NULL") return `${column} IS NULL`;
  if (operator === "NOT_NULL") return `${column} IS NOT NULL`;
  if (operator === "IN") {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    if (!values.length) throw new Error("IN 筛选条件不能为空");
    parameters.push(...values);
    return `${column} IN (${values.map(() => "?").join(", ")})`;
  }
  if (value == null || Array.isArray(value)) {
    throw new Error(`${operator} 筛选条件缺少单值`);
  }
  parameters.push(value);
  const symbols: Partial<Record<QueryFilterOperator, string>> = {
    EQ: "=",
    NE: "<>",
    GT: ">",
    GTE: ">=",
    LT: "<",
    LTE: "<=",
  };
  if (operator === "CONTAINS") return `${column} LIKE CONCAT('%', ?, '%')`;
  if (operator === "PREFIX") return `${column} LIKE CONCAT(?, '%')`;
  const symbol = symbols[operator];
  if (!symbol) throw new Error(`不支持的筛选操作符：${operator}`);
  return `${column} ${symbol} ?`;
}

function resolveNaturalTimeRange(
  expression: string,
  now: Date,
  timezone: string,
): { start: string; endExclusive: string } {
  const text = expression.trim();
  const { year, month, day } = zonedDateParts(now, timezone);
  if (/^(今年|本年)$/.test(text)) {
    return { start: dateText(year, 1, 1), endExclusive: dateText(year + 1, 1, 1) };
  }
  if (text === "去年") {
    return { start: dateText(year - 1, 1, 1), endExclusive: dateText(year, 1, 1) };
  }
  if (/^(本月|这个月)$/.test(text)) {
    return {
      start: dateText(year, month, 1),
      endExclusive: dateText(year, month + 1, 1),
    };
  }
  if (text === "上月") {
    return {
      start: dateText(year, month - 1, 1),
      endExclusive: dateText(year, month, 1),
    };
  }
  if (/^(今天|今日)$/.test(text)) {
    return {
      start: dateText(year, month, day),
      endExclusive: dateText(year, month, day + 1),
    };
  }
  if (text === "昨天") {
    return {
      start: dateText(year, month, day - 1),
      endExclusive: dateText(year, month, day),
    };
  }
  const explicitYear = text.match(/^(\d{4})年$/);
  if (explicitYear) {
    const parsed = Number(explicitYear[1]);
    return { start: dateText(parsed, 1, 1), endExclusive: dateText(parsed + 1, 1, 1) };
  }
  throw new Error(`暂不支持时间表达式“${expression}”，请使用今年、去年、本月、上月或明确年份`);
}

function dateText(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} 00:00:00`;
}

function zonedDateParts(
  value: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const get = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function qualifiedColumn(alias: string, property: OntologyProperty): string {
  return `${alias}.${quoteIdentifier(property.sourceColumn)}`;
}

function qualifiedTable(table: PhysicalTable): string {
  return `${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`;
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function rewriteGovernedExpression(
  expression: string,
  aliases: Map<string, string>,
  tables: Map<string, PhysicalTable>,
): string {
  let result = expression;
  for (const [objectId, table] of tables) {
    const alias = aliases.get(objectId);
    if (!alias) continue;
    result = result.replace(
      new RegExp(`(?:\`${escapeRegex(table.name)}\`|${escapeRegex(table.name)})\\.`, "gi"),
      `${alias}.`,
    );
  }
  return result;
}

function effectiveGrainLabel(object: OntologyObject): string {
  const idProperty = object.properties.find((property) => property.meaning === "ID");
  const ids = idProperty ? [idProperty.id] : object.grainPropertyIds;
  const labels = ids
    .map((id) => object.properties.find((property) => property.id === id)?.label)
    .filter(Boolean);
  return labels.length ? labels.join(" + ") : object.grain || "明细行";
}

function formatValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("、") : value ?? "未提供";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
