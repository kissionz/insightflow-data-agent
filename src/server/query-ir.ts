import type {
  AnalysisIntent,
  Metric,
  OntologyObject,
  OntologyProperty,
  OntologyRelation,
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
    const measureBindings = intent.measureIds.map((id) =>
      resolveMeasureReference(id, ontology, propertyOwners),
    );
    const measures = measureBindings.map((binding) => binding.metric);
    const dimensions = intent.dimensionPropertyIds.map((id) =>
      requireProperty(propertyOwners, id, "分析维度"),
    );
    const filters = intent.filters.map((filter) => {
      const binding = requireProperty(propertyOwners, filter.propertyId, "筛选条件");
      if (filter.kind === "BOUND_VALUE" && binding.object.id !== filter.objectId) {
        throw new Error(`属性值绑定 ${filter.valueBindingId} 的对象与属性不一致`);
      }
      return { ...filter, binding };
    });
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
      ...filters
        .filter((filter) => filter.kind !== "BOUND_VALUE")
        .map((filter) => filter.binding.object.id),
      ...(timeBinding ? [timeBinding.object.id] : []),
    ]);
    const semanticIndex = new SemanticIndex(ontology);
    const outerRelationIds: string[] = [];
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
        if (!outerRelationIds.includes(relation.id)) outerRelationIds.push(relation.id);
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
      outerRelationIds,
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
    const filterRelationIds = new Map<string, string[]>();
    for (const filter of filters) {
      const existingAlias = aliases.get(filter.binding.object.id);
      if (filter.kind !== "BOUND_VALUE" || existingAlias) {
        whereParts.push(
          compileFilter(
            qualifiedColumn(existingAlias ?? aliases.get(root.id)!, filter.binding.property),
            filter.operator,
            filter.value,
            parameters,
          ),
        );
        if (filter.kind === "BOUND_VALUE") {
          filterRelationIds.set(filter.valueBindingId, []);
        }
        continue;
      }
      const path = semanticIndex.findRelationPath(root.id, filter.binding.object.id);
      if (!path.length) {
        throw new Error(
          `对象 ${root.label} 与属性值所属对象 ${filter.binding.object.label} 之间没有可用关系`,
        );
      }
      validateRelationPath(path);
      whereParts.push(
        compileRelatedValueExists(
          root,
          aliases.get(root.id)!,
          filter.binding.object,
          filter.binding.property,
          filter.operator,
          filter.value,
          path,
          objectById,
          tableById,
          parameters,
        ),
      );
      filterRelationIds.set(filter.valueBindingId, path.map((relation) => relation.id));
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
    const relationIds = [
      ...new Set([
        ...outerRelationIds,
        ...[...filterRelationIds.values()].flat(),
      ]),
    ];
    const ir: QueryIR = {
      version: 1,
      ontologyVersion: ontology.version,
      rootObjectId: root.id,
      measureIds: measures.map((metric) => metric.id),
      dimensionPropertyIds: dimensions.map((binding) => binding.property.id),
      filters: filters.map(({ binding: _binding, ...filter }) =>
        filter.kind === "BOUND_VALUE"
          ? {
              ...filter,
              strategy: aliases.has(filter.objectId) ? "DIRECT" as const : "EXISTS" as const,
              relationIds: filterRelationIds.get(filter.valueBindingId) ?? [],
            }
          : filter,
      ),
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
      ...measureBindings.map(({ metric, source }) => ({
        label: "指标",
        value: metric.label,
        source,
        entityId: metric.id,
      })),
      ...dimensions.map(({ property }) => ({
        label: "维度",
        value: property.label,
        source: "属性ID精确绑定",
        entityId: property.id,
      })),
      ...filters.map(({ binding, businessValue, value, ...filter }) => ({
        label: "筛选条件",
        value: `${binding.property.label} = ${businessValue ?? formatValue(value)}`,
        source:
          filter.kind === "BOUND_VALUE"
            ? `${filter.evidenceTier === "EXACT_VALUE" ? "属性值精确索引" : "属性值前缀索引"} · ${aliases.has(binding.object.id) ? "直接筛选" : "关联对象 EXISTS"} · 优先级 ${filter.objectPriority}/${filter.propertyPriority}`
            : businessValue && businessValue !== formatValue(value)
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

function resolveMeasureReference(
  id: string,
  ontology: OntologySnapshot,
  owners: Array<{ object: OntologyObject; property: OntologyProperty }>,
): { metric: Metric; source: string } {
  const metric = ontology.metrics.find((candidate) => candidate.id === id);
  if (metric) {
    return { metric, source: "指标ID精确绑定" };
  }
  const propertyBinding = owners.find(
    (candidate) => candidate.property.id === id,
  );
  if (!propertyBinding) {
    throw new Error(`查询计划引用了不存在的指标：${id}`);
  }
  const governedMetrics = ontology.metrics.filter(
    (candidate) => candidate.sourcePropertyId === id,
  );
  if (governedMetrics.length === 1) {
    return {
      metric: governedMetrics[0]!,
      source: `Montane误传属性ID，规则引擎按唯一治理映射从“${propertyBinding.property.label}”纠正为指标`,
    };
  }
  const implicitMetric = createImplicitPropertyMetric(propertyBinding);
  if (implicitMetric && governedMetrics.length === 0) {
    return {
      metric: implicitMetric,
      source: `数字属性默认${aggregationLabel(implicitMetric.aggregation)} · IR受控聚合`,
    };
  }
  const availableMetrics = ontology.metrics
    .slice(0, 8)
    .map((candidate) => `${candidate.label}（${candidate.id}）`)
    .join("、");
  if (governedMetrics.length > 1) {
    throw new Error(
      `“${propertyBinding.property.label}”是属性且对应多个指标，不能自动选择。measure_ids 必须使用指标 ID：${governedMetrics.map((candidate) => `${candidate.label}（${candidate.id}）`).join("、")}`,
    );
  }
  if (propertyBinding.property.meaning === "NUMBER") {
    throw new Error(
      `数字属性“${propertyBinding.property.label}”没有可用的默认聚合规则，请在本体中设置 SUM、AVG、MIN 或 MAX，或创建正式指标`,
    );
  }
  throw new Error(
    `“${propertyBinding.property.label}”（${id}）不是可聚合数字属性。measure_ids 只能使用 OntologySearch 返回的 metrics[].id${availableMetrics ? `；当前可用指标：${availableMetrics}` : ""}`,
  );
}

function createImplicitPropertyMetric(
  binding: { object: OntologyObject; property: OntologyProperty },
): Metric | undefined {
  const numeric = binding.property.numericSpec;
  const aggregation = numeric?.defaultAggregation;
  if (
    binding.property.meaning !== "NUMBER" ||
    binding.property.visibility !== "ANALYTICAL" ||
    binding.property.sensitive ||
    !aggregation ||
    aggregation === "NONE"
  ) {
    return undefined;
  }
  return {
    id: binding.property.id,
    name: `implicit_${binding.property.name}`,
    label: binding.property.label,
    description: `${binding.property.label}按属性默认规则${aggregationLabel(aggregation)}`,
    objectId: binding.object.id,
    expression: `${aggregation}(${binding.property.sourceColumn})`,
    definitionMode: "VISUAL",
    sourcePropertyId: binding.property.id,
    timePropertyId: binding.object.defaultTimePropertyId,
    aggregation,
    format:
      numeric.kind === "CURRENCY"
        ? "currency"
        : numeric.kind === "RATIO"
          ? "percent"
          : "number",
    unit: numeric.kind === "CURRENCY" ? numeric.currency : numeric.unit,
    synonyms: binding.property.synonyms,
    status: binding.object.status,
  };
}

function aggregationLabel(aggregation: Metric["aggregation"]): string {
  return {
    SUM: "求和",
    COUNT: "计数",
    COUNT_DISTINCT: "去重计数",
    AVG: "平均",
    MIN: "最小值",
    MAX: "最大值",
    CUSTOM: "自定义计算",
  }[aggregation];
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

function validateRelationPath(path: OntologyRelation[]): void {
  for (const relation of path) {
    if (relation.fanoutRisk === "HIGH" || relation.cardinality === "MANY_TO_MANY") {
      throw new Error(`关系 ${relation.name} 存在高扇出风险，需要先补充聚合规则`);
    }
    if (!relation.sourcePropertyId || !relation.targetPropertyId) {
      throw new Error(`关系 ${relation.name} 缺少可编译的关联属性`);
    }
  }
}

function compileRelatedValueExists(
  root: OntologyObject,
  rootAlias: string,
  anchorObject: OntologyObject,
  anchorProperty: OntologyProperty,
  operator: QueryFilterOperator,
  value: string | string[] | undefined,
  path: OntologyRelation[],
  objects: Map<string, OntologyObject>,
  tables: Map<string, PhysicalTable>,
  parameters: unknown[],
): string {
  const aliases = new Map<string, string>([[root.id, rootAlias]]);
  const innerObjects: OntologyObject[] = [];
  const joins: string[] = [];
  let currentObject = root;
  let correlation = "";

  for (const [index, relation] of path.entries()) {
    const nextObjectId =
      relation.sourceObjectId === currentObject.id
        ? relation.targetObjectId
        : relation.sourceObjectId;
    const nextObject = objects.get(nextObjectId);
    const nextTable = nextObject ? tables.get(nextObject.sourceTableId) : undefined;
    if (!nextObject || !nextTable) {
      throw new Error(`关系 ${relation.name} 引用了不可用的业务对象`);
    }
    const nextAlias = `vf${index}`;
    aliases.set(nextObject.id, nextAlias);
    innerObjects.push(nextObject);
    const source = objects.get(relation.sourceObjectId);
    const target = objects.get(relation.targetObjectId);
    const sourceProperty = source?.properties.find(
      (property) => property.id === relation.sourcePropertyId,
    );
    const targetProperty = target?.properties.find(
      (property) => property.id === relation.targetPropertyId,
    );
    if (!source || !target || !sourceProperty || !targetProperty) {
      throw new Error(`关系 ${relation.name} 缺少可编译的关联属性`);
    }
    const condition = `${qualifiedColumn(aliases.get(source.id)!, sourceProperty)} = ${qualifiedColumn(aliases.get(target.id)!, targetProperty)}`;
    if (index === 0) {
      correlation = condition;
    } else {
      joins.push(`INNER JOIN ${qualifiedTable(nextTable)} AS ${nextAlias} ON ${condition}`);
    }
    currentObject = nextObject;
  }

  if (currentObject.id !== anchorObject.id || !innerObjects.length) {
    throw new Error(`无法为 ${anchorObject.label}.${anchorProperty.label} 生成关联筛选路径`);
  }
  const firstTable = tables.get(innerObjects[0]!.sourceTableId)!;
  const anchorAlias = aliases.get(anchorObject.id)!;
  const predicates = [
    correlation,
    ...innerObjects
      .filter((object) => object.defaultFilter?.trim())
      .map((object) =>
        `(${rewriteGovernedExpression(object.defaultFilter!, aliases, new Map(
          innerObjects.map((item) => [item.id, tables.get(item.sourceTableId)!]),
        ))})`,
      ),
    compileFilter(
      qualifiedColumn(anchorAlias, anchorProperty),
      operator,
      value,
      parameters,
    ),
  ];
  return [
    "EXISTS (",
    `  SELECT 1 FROM ${qualifiedTable(firstTable)} AS ${aliases.get(innerObjects[0]!.id)}`,
    ...joins.map((join) => `  ${join}`),
    `  WHERE ${predicates.join("\n    AND ")}`,
    ")",
  ].join("\n");
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
