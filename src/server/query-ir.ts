import type {
  AnalysisFilter,
  AnalysisFilterExpression,
  AnalysisIntent,
  DerivedMeasureCalculation,
  HierarchyAnalysisFilter,
  Metric,
  OntologyObject,
  OntologyProperty,
  OntologyRelation,
  OntologySnapshot,
  PhysicalTable,
  QueryFilterOperator,
  QueryIR,
  TimeComparisonCalculation,
  TimeGrain,
  WindowCalculation,
} from "../shared/types.js";
import {
  SemanticIndex,
  type RecursiveHierarchyMatch,
} from "./semantic-index.js";

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

export function preferNameDisplayDimensions(
  intent: AnalysisIntent,
  ontology: OntologySnapshot,
): AnalysisIntent {
  const resolutions = intent.dimensionPropertyIds.map((propertyId) => ({
    requestedPropertyId: propertyId,
    displayPropertyId:
      resolvePreferredDisplayProperty(ontology, propertyId)?.id ?? propertyId,
  }));
  const replacements = new Map(
    resolutions.map((resolution) => [
      resolution.requestedPropertyId,
      resolution.displayPropertyId,
    ]),
  );
  const remap = (propertyId: string) => replacements.get(propertyId) ?? propertyId;
  const dimensionPropertyIds = [
    ...new Set(resolutions.map((resolution) => resolution.displayPropertyId)),
  ];
  return {
    ...intent,
    dimensionPropertyIds,
    windowCalculations: intent.windowCalculations?.map((calculation) => ({
      ...calculation,
      partitionByPropertyIds: calculation.partitionByPropertyIds.map(remap),
      orderBy: calculation.orderBy && calculation.orderBy.entityId !== "__time__"
        ? {
            ...calculation.orderBy,
            entityId: remap(calculation.orderBy.entityId),
          }
        : calculation.orderBy,
    })),
    groupSelections: intent.groupSelections?.map((selection) => ({
      ...selection,
      partitionByPropertyIds: selection.partitionByPropertyIds.map(remap),
      orderByEntityId: remap(selection.orderByEntityId),
    })),
    periodConditions: intent.periodConditions?.map((condition) => ({
      ...condition,
      groupByPropertyIds: condition.groupByPropertyIds.map(remap),
    })),
    sort: intent.sort?.map((sort) => ({
      ...sort,
      entityId: remap(sort.entityId),
    })),
  };
}

function resolvePreferredDisplayProperty(
  ontology: OntologySnapshot,
  propertyId: string,
): OntologyProperty | undefined {
  const owners = ontology.objects.flatMap((object) =>
    object.properties.map((property) => ({ object, property })),
  );
  const selected = owners.find((binding) => binding.property.id === propertyId);
  if (!selected || isNameDisplayProperty(selected.property)) {
    return selected?.property;
  }
  const identityLike =
    selected.property.meaning === "ID" ||
    selected.property.meaning === "CODE" ||
    selected.property.meaning === "ENTITY_REFERENCE" ||
    selected.property.unique ||
    selected.object.grainPropertyIds.includes(selected.property.id);
  if (!identityLike) return selected.property;

  const candidateObjectIds = new Set<string>();
  for (const relation of ontology.relations) {
    if (relation.sourcePropertyId === propertyId) {
      candidateObjectIds.add(relation.targetObjectId);
    }
    if (relation.targetPropertyId === propertyId) {
      candidateObjectIds.add(relation.sourceObjectId);
    }
  }
  candidateObjectIds.add(selected.object.id);
  const entityStem = displayEntityStem(selected.property.label);
  const candidates = owners
    .filter(
      (binding) =>
        candidateObjectIds.has(binding.object.id) &&
        binding.property.visibility === "ANALYTICAL" &&
        !binding.property.sensitive &&
        isNameDisplayProperty(binding.property),
    )
    .sort((left, right) =>
      displayNameScore(right.property, entityStem) -
        displayNameScore(left.property, entityStem) ||
      left.property.label.localeCompare(right.property.label, "zh-CN"),
    );
  return candidates[0]?.property ?? selected.property;
}

function isNameDisplayProperty(property: OntologyProperty): boolean {
  return (
    property.meaning === "NAME" ||
    /名称|姓名|名字|(^|_)(?:name|title|label)(?:_|$)/i.test(
      `${property.label} ${property.name}`,
    )
  );
}

function displayEntityStem(label: string): string {
  return label
    .replace(/\s*(?:ID|UID|编码|代码|编号|标识)$/i, "")
    .trim();
}

function displayNameScore(property: OntologyProperty, entityStem: string): number {
  const exactEntityName = entityStem && property.label === `${entityStem}名称`;
  return (
    (exactEntityName ? 500 : 0) +
    (property.meaning === "NAME" ? 200 : 0) +
    (property.defaultDisplay ? 80 : 0) +
    property.bindingPriority -
    (/重点|主名称|别名/.test(property.label) ? 40 : 0)
  );
}

export class QueryIrCompiler {
  constructor(private readonly now: () => Date = () => new Date()) {}

  compile(
    intent: AnalysisIntent,
    ontology: OntologySnapshot,
    tables: PhysicalTable[],
    timezone = "Asia/Shanghai",
  ): CompiledQuery {
    const originalDimensionIds = [...intent.dimensionPropertyIds];
    intent = preferNameDisplayDimensions(intent, ontology);
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
    const displayFallbacks = new Map<string, { object: OntologyObject; property: OntologyProperty }>();
    for (const requestedPropertyId of originalDimensionIds) {
      const requested = requireProperty(propertyOwners, requestedPropertyId, "分析维度");
      const displayPropertyId =
        resolvePreferredDisplayProperty(ontology, requestedPropertyId)?.id ??
        requestedPropertyId;
      if (displayPropertyId !== requestedPropertyId) {
        displayFallbacks.set(displayPropertyId, requested);
      }
    }
    const semanticIndex = new SemanticIndex(ontology);
    const hierarchyFilters = (intent.hierarchyFilters ?? []).map((filter) => {
      const hierarchy = semanticIndex.findRecursiveHierarchy(filter.hierarchyId);
      if (!hierarchy) throw new Error(`递归层级不存在或尚未发布：${filter.hierarchyId}`);
      if (!hierarchy.closure) {
        throw new Error(`递归层级 ${hierarchy.hierarchyLabel} 未配置闭包表，不能执行祖先/后代过滤`);
      }
      if (!filter.anchorValue.trim()) {
        throw new Error(`递归层级 ${hierarchy.hierarchyLabel} 的锚点节点不能为空`);
      }
      return { ...filter, hierarchy };
    });
    const sourceFilters = intent.filterExpression
      ? flattenFilterExpression(intent.filterExpression)
      : intent.filters;
    const filters = sourceFilters.map((filter) => {
      const binding = requireProperty(propertyOwners, filter.propertyId, "筛选条件");
      if (filter.kind === "BOUND_VALUE" && binding.object.id !== filter.objectId) {
        throw new Error(`属性值绑定 ${filter.valueBindingId} 的对象与属性不一致`);
      }
      return { ...filter, binding };
    });
    const aggregateFilters = intent.aggregateFilterExpression
      ? flattenAggregateFilterExpression(intent.aggregateFilterExpression)
      : intent.aggregateFilters ?? [];
    const requestedRootId =
      intent.rootObjectId ??
      measures[0]?.objectId ??
      dimensions[0]?.object.id ??
      filters[0]?.binding.object.id ??
      hierarchyFilters[0]?.hierarchy.objectId;
    const inferredRootId = requestedRootId
      ? resolveCompositionAggregateRoot(
          requestedRootId,
          measures,
          semanticIndex,
          intent.resultKind,
        )
      : undefined;
    if (!inferredRootId) throw new Error("查询计划缺少主业务对象");
    const root = objectById.get(inferredRootId);
    if (!root) throw new Error(`主业务对象不存在：${inferredRootId}`);
    const rootTable = tableById.get(root.sourceTableId);
    if (!rootTable) throw new Error(`业务对象 ${root.label} 的来源表不可用`);

    const needsTimeBinding = Boolean(
      intent.timeRange ||
      intent.timeGrain ||
      intent.timeComparisons?.length ||
      intent.windowCalculations?.some(
        (calculation) => calculation.orderBy?.entityId === "__time__",
      ),
    );
    const timeBinding = needsTimeBinding
      ? resolveTimeBinding(intent, root, measures, propertyOwners)
      : undefined;
    const requiredObjectIds = new Set([
      root.id,
      ...measures.map((metric) => metric.objectId),
      ...dimensions.map((binding) => binding.object.id),
      ...[...displayFallbacks.values()].map((binding) => binding.object.id),
      ...filters
        .filter((filter) => filter.kind !== "BOUND_VALUE")
        .map((filter) => filter.binding.object.id),
      ...hierarchyFilters.map((filter) => filter.hierarchy.objectId),
      ...(timeBinding ? [timeBinding.object.id] : []),
    ]);
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
    validateAggregationSafety(
      root,
      measures,
      dimensions,
      intent.timeGrain?.unit,
      outerRelationIds,
      ontology,
      intent.resultKind,
    );

    const selectParts: string[] = [];
    const groupParts: string[] = [];
    for (const binding of dimensions) {
      const expression = compileDisplayDimensionExpression(
        binding,
        displayFallbacks.get(binding.property.id),
        aliases,
      );
      selectParts.push(`${expression} AS ${quoteIdentifier(binding.property.label)}`);
      groupParts.push(expression);
      const fallback = displayFallbacks.get(binding.property.id);
      if (fallback) {
        groupParts.push(qualifiedColumn(aliases.get(fallback.object.id)!, fallback.property));
      }
    }
    if (intent.timeGrain && timeBinding) {
      const expression = compileTimeBucket(
        qualifiedColumn(aliases.get(timeBinding.object.id)!, timeBinding.property),
        intent.timeGrain.unit,
      );
      selectParts.push(`${expression} AS ${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))}`);
      groupParts.push(expression);
    }
    for (const metric of measures) {
      const object = objectById.get(metric.objectId);
      if (!object) throw new Error(`指标 ${metric.label} 的所属对象不存在`);
      selectParts.push(
        `${compileMetric(metric, object, aliases, tablesByObject, metricById, objectById)} AS ${quoteIdentifier(metric.label)}`,
      );
    }
    const measureByReference = buildMeasureReferenceMap(
      intent.measureIds,
      measureBindings,
    );
    validateCalculations(
      intent,
      measureByReference,
      dimensions,
      timeBinding,
      ontology,
    );
    validateAggregateFilters(
      intent,
      aggregateFilters,
      measureByReference,
    );
    for (const calculation of intent.derivedMeasures ?? []) {
      selectParts.push(
        `${compileDerivedMeasure(
          calculation,
          intent.derivedMeasures ?? [],
          measureByReference,
          metricById,
          objectById,
          aliases,
          tablesByObject,
        )} AS ${quoteIdentifier(calculation.label)}`,
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
    const compiledFilterParts: string[] = [];
    for (const filter of filters) {
      const existingAlias = aliases.get(filter.binding.object.id);
      if (filter.kind !== "BOUND_VALUE" || existingAlias) {
        compiledFilterParts.push(
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
      compiledFilterParts.push(
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
    for (const filter of hierarchyFilters) {
      whereParts.push(
        compileHierarchyFilter(
          filter,
          aliases,
          objectById,
          tableById,
          parameters,
        ),
      );
    }
    if (intent.filterExpression) {
      let filterIndex = 0;
      whereParts.push(
        compileFilterExpression(intent.filterExpression, () => {
          const part = compiledFilterParts[filterIndex];
          filterIndex += 1;
          if (!part) throw new Error("逻辑筛选树与筛选条件数量不一致");
          return part;
        }),
      );
      if (filterIndex !== compiledFilterParts.length) {
        throw new Error("逻辑筛选树未覆盖全部筛选条件");
      }
    } else {
      whereParts.push(...compiledFilterParts);
    }

    let resolvedTime: QueryIR["timeRange"];
    if (intent.timeRange && timeBinding) {
      const range = resolveNaturalTimeRange(
        intent.timeRange,
        this.now(),
        timezone,
      );
      const column = qualifiedColumn(
        aliases.get(timeBinding.object.id)!,
        timeBinding.property,
      );
      const comparisonRanges = intent.timeComparisons?.length
        ? resolveComparisonTimeRanges(
            range,
            intent.timeGrain?.unit,
            intent.timeComparisons,
          )
        : [];
      const queryRanges = [range, ...comparisonRanges];
      whereParts.push(
        queryRanges.length === 1
          ? `${column} >= ?\n  AND ${column} < ?`
          : `(${queryRanges
              .map(
                () =>
                  `(${column} >= ? AND ${column} < ?)`,
              )
              .join("\n    OR ")})`,
      );
      for (const queryRange of queryRanges) {
        parameters.push(queryRange.start, queryRange.endExclusive);
      }
      resolvedTime = {
        propertyId: timeBinding.property.id,
        expression: intent.timeRange.expression,
        ...range,
        comparisonRanges,
      };
    }

    const exhaustiveSetQuery = Boolean(
      intent.groupSelections?.length || intent.periodConditions?.length,
    );
    const limit = exhaustiveSetQuery
      ? 200
      : Math.min(
          Math.max(
            1,
            Math.trunc(
              intent.limit ?? (intent.resultKind === "detail" ? 50 : 200),
            ),
          ),
          intent.resultKind === "detail" ? 50 : 200,
        );
    const sort = intent.sort ?? [];
    const orderParts = sort.map((item) => {
      const metric = metricById.get(item.entityId) ?? measureByReference.get(item.entityId);
      if (metric) return `${quoteIdentifier(metric.label)} ${item.direction}`;
      const calculation = [
        ...(intent.derivedMeasures ?? []),
        ...(intent.timeComparisons ?? []),
        ...(intent.windowCalculations ?? []),
      ].find((candidate) => candidate.id === item.entityId);
      if (calculation) return `${quoteIdentifier(calculation.label)} ${item.direction}`;
      if (item.entityId === "__time__" && intent.timeGrain) {
        return `${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))} ${item.direction}`;
      }
      const binding = requireProperty(propertyOwners, item.entityId, "排序字段");
      return `${qualifiedColumn(aliases.get(binding.object.id)!, binding.property)} ${item.direction}`;
    });
    if (!orderParts.length && intent.timeGrain) {
      orderParts.push(`${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))} ASC`);
    }
    const advancedCalculations = Boolean(
      intent.timeComparisons?.length ||
        intent.windowCalculations?.length ||
        intent.groupSelections?.length ||
        intent.periodConditions?.length ||
        aggregateFilters.length,
    );
    const sql = advancedCalculations
      ? compileLayeredAnalysis({
          intent,
          dimensions,
          displayFallbacks,
          measures,
          measureByReference,
          metricById,
          objectById,
          aliases,
          tablesByObject,
          from,
          joins,
          whereParts,
          parameters,
          timeBinding,
          resolvedTime,
          orderParts,
          limit,
        })
      : [
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
        : dimensions.length || intent.timeGrain
          ? [
              ...dimensions.map((binding) => binding.property.label),
              ...(intent.timeGrain ? [timeGrainLabel(intent.timeGrain.unit)] : []),
            ].join("、")
          : "整体汇总";
    const relationIds = [
      ...new Set([
        ...outerRelationIds,
        ...[...filterRelationIds.values()].flat(),
      ]),
    ];
    const ir: QueryIR = {
      version: 3,
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
      hierarchyFilters: hierarchyFilters.map((filter) => ({
        hierarchyId: filter.hierarchyId,
        anchorValue: filter.anchorValue,
        direction: filter.direction,
        includeSelf: filter.includeSelf ?? true,
        objectId: filter.hierarchy.objectId,
        nodeIdPropertyId: filter.hierarchy.nodeIdPropertyId,
        closureObjectId: filter.hierarchy.closure!.objectId,
      })),
      filterExpression: intent.filterExpression,
      aggregateFilters,
      aggregateFilterExpression: intent.aggregateFilterExpression,
      timeRange: resolvedTime,
      timeGrain:
        intent.timeGrain && timeBinding
          ? {
              unit: intent.timeGrain.unit,
              propertyId: timeBinding.property.id,
            }
          : undefined,
      derivedMeasures: intent.derivedMeasures ?? [],
      timeComparisons: intent.timeComparisons ?? [],
      windowCalculations: (intent.windowCalculations ?? []).map((calculation) =>
        calculation.operator === "PERCENT_OF_TOTAL" ||
        calculation.operator === "PERCENT_OF_PARTITION"
          ? {
              ...calculation,
              scale: calculation.scale ?? 100,
              precision: calculation.precision ?? 2,
              denominatorScope:
                calculation.denominatorScope ??
                "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N",
            }
          : calculation,
      ),
      groupSelections: intent.groupSelections ?? [],
      periodConditions: (intent.periodConditions ?? []).map((condition) => ({
        ...condition,
        expectedPeriodCount:
          condition.expectedPeriodCount ?? resolvedTime?.periodCount,
      })),
      relationIds,
      grain,
      resultKind: intent.resultKind,
      sort,
      limit,
      resultContract: {
        calculationSource: "DORIS_SQL",
        businessLogicBeforeLimit: true,
        completeness: "COMPLETE_IF_NOT_TRUNCATED",
        expectedPeriodCount:
          intent.periodConditions?.length
            ? resolvedTime?.periodCount ??
              intent.periodConditions[0]?.expectedPeriodCount
            : undefined,
        exhaustiveRequested: Boolean(
          intent.groupSelections?.length || intent.periodConditions?.length,
        ),
      },
    };
    const bindings = [
      {
        label: "业务对象",
        value: root.label,
        source:
          requestedRootId && requestedRootId !== root.id
            ? `组合关系安全下沉（原主对象 ${objectById.get(requestedRootId)?.label ?? requestedRootId}）`
            : "本体对象",
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
      ...(intent.timeGrain && timeBinding
        ? [{
            label: "时间粒度",
            value: timeGrainLabel(intent.timeGrain.unit),
            source: `时间属性 ${timeBinding.property.label}`,
            entityId: timeBinding.property.id,
          }]
        : []),
      ...(intent.derivedMeasures ?? []).map((calculation) => ({
        label: "派生计算",
        value: calculation.label,
        source: `IR ${calculation.operator}`,
        entityId: calculation.id,
      })),
      ...(intent.timeComparisons ?? []).map((calculation) => ({
        label: "时间比较",
        value: calculation.label,
        source: `IR ${calculation.comparison}/${calculation.output}`,
        entityId: calculation.id,
      })),
      ...(intent.windowCalculations ?? []).map((calculation) => ({
        label: "窗口计算",
        value: calculation.label,
        source:
          calculation.operator === "PERCENT_OF_TOTAL" ||
          calculation.operator === "PERCENT_OF_PARTITION"
            ? `Doris 窗口函数 · IR ${calculation.operator} · 业务筛选后/Top N 前`
            : `IR ${calculation.operator}`,
        entityId: calculation.id,
      })),
      ...(intent.groupSelections ?? []).map((selection) => ({
        label: "组内选择",
        value: `${selection.label} · ${selection.operator === "TOP_N" ? "每组前" : "每组后"} ${selection.count}`,
        source: `Doris 分区排名 · ${selection.ties === "INCLUDE" ? "包含并列" : "固定行数"}`,
        entityId: selection.id,
      })),
      ...(intent.periodConditions ?? []).map((condition) => ({
        label: "跨期间条件",
        value: `${condition.label} · ${periodQuantifierLabel(condition.quantifier)}`,
        source: `Doris 二次聚合 · 缺失期间${condition.missingPeriodPolicy === "FAIL" ? "不通过" : "忽略"}`,
        entityId: condition.id,
      })),
      ...filters.map(({ binding, businessValue, value, ...filter }) => ({
        label: "筛选条件",
        value: `${binding.property.label} ${filterOperatorLabel(filter.operator)} ${businessValue ?? formatValue(value)}`,
        source:
          filter.kind === "BOUND_VALUE"
            ? `${filter.evidenceTier === "EXACT_VALUE" ? "属性值精确索引" : "属性值前缀索引"} · ${aliases.has(binding.object.id) ? "直接筛选" : "关联对象 EXISTS"} · 优先级 ${filter.objectPriority}/${filter.propertyPriority}`
            : businessValue && businessValue !== formatValue(value)
              ? `属性值索引映射为 ${formatValue(value)}`
            : "属性值绑定",
        entityId: binding.property.id,
      })),
      ...hierarchyFilters.map((filter) => ({
        label: "递归层级筛选",
        value: `${filter.hierarchy.hierarchyLabel} · ${filter.direction === "DESCENDANTS" ? "后代" : "祖先"} · ${filter.anchorValue}`,
        source: `闭包表参数化 EXISTS · ${filter.includeSelf === false ? "不含自身" : "包含自身"}`,
        entityId: filter.hierarchyId,
      })),
      ...aggregateFilters.map((filter) => ({
        label: "聚合后筛选",
        value: `${aggregateFilterEntityLabel(filter.entityId, intent, measureByReference)} ${filterOperatorLabel(filter.operator)} ${formatValue(filter.value)}`,
        source: "IR 聚合结果筛选 · 分层 SQL",
        entityId: filter.entityId,
      })),
      ...(resolvedTime && timeBinding
        ? [{
            label: "时间范围",
            value: `${timeBinding.property.label}：${resolvedTime.start} 至 ${resolvedTime.endExclusive}`,
            source:
              resolvedTime.mode === "TO_DATE"
                ? `自然时间“${resolvedTime.expression}” · 同进度截至当前日期`
                : `自然时间“${resolvedTime.expression}”`,
            entityId: timeBinding.property.id,
          }]
        : []),
      ...(resolvedTime?.comparisonRanges ?? []).map((range) => ({
        label:
          range.comparison === "YEAR_OVER_YEAR" ? "同比基期" : "环比基期",
        value: `${range.start} 至 ${range.endExclusive}`,
        source:
          resolvedTime?.mode === "TO_DATE"
            ? "IR 同进度时间窗口"
            : "IR 完整周期时间窗口",
        entityId: timeBinding?.property.id,
      })),
    ];
    return {
      ir,
      sql,
      parameters,
      bindings,
      planSummary: `${root.label} · ${grain} · ${measures.length} 个基础指标 · ${
        (intent.derivedMeasures?.length ?? 0) +
        (intent.timeComparisons?.length ?? 0) +
        (intent.windowCalculations?.length ?? 0) +
        (intent.groupSelections?.length ?? 0) +
        (intent.periodConditions?.length ?? 0)
      } 个计算 · ${filters.length + hierarchyFilters.length + aggregateFilters.length + (resolvedTime ? 1 : 0)} 个条件`,
    };
  }
}

function flattenFilterExpression(
  expression: AnalysisFilterExpression,
): AnalysisFilter[] {
  if (expression.type === "CONDITION") return [expression.filter];
  if (expression.type === "NOT") return flattenFilterExpression(expression.child);
  return expression.children.flatMap(flattenFilterExpression);
}

function compileFilterExpression(
  expression: AnalysisFilterExpression,
  nextCondition: () => string,
): string {
  if (expression.type === "CONDITION") return `(${nextCondition()})`;
  if (expression.type === "NOT") {
    return `(NOT ${compileFilterExpression(expression.child, nextCondition)})`;
  }
  if (expression.children.length < 2) {
    throw new Error(`${expression.operator} 条件组至少需要两个子条件`);
  }
  return `(${expression.children
    .map((child) => compileFilterExpression(child, nextCondition))
    .join(` ${expression.operator} `)})`;
}

function flattenAggregateFilterExpression(
  expression: NonNullable<AnalysisIntent["aggregateFilterExpression"]>,
): NonNullable<AnalysisIntent["aggregateFilters"]> {
  if (expression.type === "CONDITION") return [expression.filter];
  if (expression.type === "NOT") {
    return flattenAggregateFilterExpression(expression.child);
  }
  return expression.children.flatMap(flattenAggregateFilterExpression);
}

function compileAggregateFilterExpression(
  expression: NonNullable<AnalysisIntent["aggregateFilterExpression"]>,
  nextCondition: () => string,
): string {
  if (expression.type === "CONDITION") return `(${nextCondition()})`;
  if (expression.type === "NOT") {
    return `(NOT ${compileAggregateFilterExpression(expression.child, nextCondition)})`;
  }
  if (expression.children.length < 2) {
    throw new Error(`${expression.operator} 聚合条件组至少需要两个子条件`);
  }
  return `(${expression.children
    .map((child) =>
      compileAggregateFilterExpression(child, nextCondition),
    )
    .join(` ${expression.operator} `)})`;
}

function buildMeasureReferenceMap(
  requestedIds: string[],
  bindings: Array<{ metric: Metric }>,
): Map<string, Metric> {
  const result = new Map<string, Metric>();
  bindings.forEach((binding, index) => {
    result.set(binding.metric.id, binding.metric);
    const requested = requestedIds[index];
    if (requested) result.set(requested, binding.metric);
  });
  return result;
}

function validateCalculations(
  intent: AnalysisIntent,
  measures: Map<string, Metric>,
  dimensions: Array<{ object: OntologyObject; property: OntologyProperty }>,
  timeBinding?: { object: OntologyObject; property: OntologyProperty },
  ontology?: OntologySnapshot,
): void {
  const calculations = [
    ...(intent.derivedMeasures ?? []),
    ...(intent.timeComparisons ?? []),
    ...(intent.windowCalculations ?? []),
    ...(intent.groupSelections ?? []),
    ...(intent.periodConditions ?? []),
  ];
  const ids = new Set<string>();
  for (const calculation of calculations) {
    if (!calculation.id.trim() || !calculation.label.trim()) {
      throw new Error("计算项的 ID 和名称不能为空");
    }
    if (ids.has(calculation.id) || measures.has(calculation.id)) {
      throw new Error(`计算项 ID 重复：${calculation.id}`);
    }
    ids.add(calculation.id);
  }
  for (const calculation of intent.derivedMeasures ?? []) {
    if (
      calculation.scale != null &&
      (!Number.isFinite(calculation.scale) ||
        calculation.scale <= 0 ||
        calculation.scale > 1_000_000)
    ) {
      throw new Error(`派生计算 ${calculation.label} 的缩放系数无效`);
    }
    if (
      (calculation.operator === "DIVIDE" || calculation.operator === "RATIO") &&
      calculation.leftMeasureId === calculation.rightMeasureId
    ) {
      throw new Error(
        `派生计算 ${calculation.label} 不能用同一指标除以自身；总体占比请使用 PERCENT_OF_TOTAL，组内占比请使用 PERCENT_OF_PARTITION`,
      );
    }
  }
  validateDerivedCalculationGraph(intent.derivedMeasures ?? [], measures);
  if (intent.timeComparisons?.length) {
    if (!intent.timeGrain || !timeBinding) {
      throw new Error("同比或环比计算必须指定时间粒度");
    }
    for (const calculation of intent.timeComparisons) {
      requireMeasureReference(measures, calculation.measureId, calculation.label);
    }
  }
  const dimensionIds = new Set(dimensions.map((binding) => binding.property.id));
  for (const calculation of intent.windowCalculations ?? []) {
    requireMeasureReference(measures, calculation.measureId, calculation.label);
    const isShare =
      calculation.operator === "PERCENT_OF_TOTAL" ||
      calculation.operator === "PERCENT_OF_PARTITION";
    for (const propertyId of calculation.partitionByPropertyIds) {
      if (
        propertyId !== "__time__" &&
        !dimensionIds.has(propertyId)
      ) {
        throw new Error(
          `窗口计算 ${calculation.label} 的分区属性必须同时出现在维度中：${propertyId}`,
        );
      }
      if (propertyId === "__time__" && (!intent.timeGrain || !timeBinding)) {
        throw new Error(`窗口计算 ${calculation.label} 按时间分区时必须指定时间粒度`);
      }
    }
    if (calculation.operator === "PERCENT_OF_TOTAL" && calculation.partitionByPropertyIds.length) {
      throw new Error(`总体占比 ${calculation.label} 不能设置分区属性`);
    }
    if (
      calculation.operator === "PERCENT_OF_PARTITION" &&
      !calculation.partitionByPropertyIds.length
    ) {
      throw new Error(`组内占比 ${calculation.label} 至少需要一个分区属性`);
    }
    if (isShare) {
      const scale = calculation.scale ?? 100;
      if (!Number.isFinite(scale) || scale <= 0 || scale > 1_000_000) {
        throw new Error(`占比计算 ${calculation.label} 的缩放系数无效`);
      }
      const precision = calculation.precision ?? 2;
      if (!Number.isInteger(precision) || precision < 0 || precision > 8) {
        throw new Error(`占比计算 ${calculation.label} 的小数位必须在 0 到 8 之间`);
      }
      if (
        calculation.denominatorScope &&
        calculation.denominatorScope !== "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N"
      ) {
        throw new Error(`占比计算 ${calculation.label} 使用了不支持的分母口径`);
      }
    } else {
      if (!calculation.orderBy?.entityId) {
        throw new Error(`窗口计算 ${calculation.label} 必须指定排序字段`);
      }
      const orderId = calculation.orderBy.entityId;
      if (
        orderId !== "__time__" &&
        !dimensionIds.has(orderId) &&
        !measures.has(orderId)
      ) {
        throw new Error(`窗口计算 ${calculation.label} 引用了不可用的排序字段`);
      }
      if (orderId === "__time__" && (!intent.timeGrain || !timeBinding)) {
        throw new Error(`窗口计算 ${calculation.label} 按时间排序时必须指定时间粒度`);
      }
    }
    if (calculation.operator === "MOVING_AVG") {
      const size = calculation.windowSize ?? 3;
      if (!Number.isInteger(size) || size < 2 || size > 365) {
        throw new Error(`移动平均 ${calculation.label} 的窗口必须在 2 到 365 之间`);
      }
    }
  }
  for (const selection of intent.groupSelections ?? []) {
    if (!Number.isInteger(selection.count) || selection.count < 1 || selection.count > 100) {
      throw new Error(`每组排名 ${selection.label} 的数量必须在 1 到 100 之间`);
    }
    if (!selection.partitionByPropertyIds.length) {
      throw new Error(`每组排名 ${selection.label} 至少需要一个分区属性`);
    }
    for (const propertyId of selection.partitionByPropertyIds) {
      if (!dimensionIds.has(propertyId)) {
        throw new Error(
          `每组排名 ${selection.label} 的分区属性必须同时出现在维度中：${propertyId}`,
        );
      }
    }
    for (const detail of dimensions.filter(
      (binding) =>
        !selection.partitionByPropertyIds.includes(binding.property.id),
    )) {
      for (const partitionId of selection.partitionByPropertyIds) {
        const hierarchy = ontology?.dimensionHierarchies?.find((candidate) => {
          const ids = candidate.levels.map((level) => level.propertyId);
          return ids.includes(partitionId) && ids.includes(detail.property.id);
        });
        if (!hierarchy) continue;
        const partitionIndex = hierarchy.levels.findIndex(
          (level) => level.propertyId === partitionId,
        );
        const detailIndex = hierarchy.levels.findIndex(
          (level) => level.propertyId === detail.property.id,
        );
        if (partitionIndex >= detailIndex) {
          throw new Error(
            `每组排名 ${selection.label} 的分区维度必须位于明细维度上级；${hierarchy.label} 的顺序为 ${hierarchy.levels
              .map(
                (level) =>
                  findHierarchyPropertyLabel(ontology!, level.propertyId),
              )
              .join(" → ")}`,
          );
        }
      }
    }
    requireAnalysisResultEntityLabel(
      intent,
      measures,
      selection.orderByEntityId,
      selection.label,
    );
  }
  const aggregateFilters = intent.aggregateFilterExpression
    ? flattenAggregateFilterExpression(intent.aggregateFilterExpression)
    : intent.aggregateFilters ?? [];
  for (const condition of intent.periodConditions ?? []) {
    requireMeasureReference(measures, condition.measureId, condition.label);
    if (!intent.timeGrain || !timeBinding) {
      throw new Error(`期间条件 ${condition.label} 必须指定时间粒度`);
    }
    if (!condition.groupByPropertyIds.length) {
      throw new Error(`期间条件 ${condition.label} 至少需要一个结果分组属性`);
    }
    for (const propertyId of condition.groupByPropertyIds) {
      if (!dimensionIds.has(propertyId)) {
        throw new Error(
          `期间条件 ${condition.label} 的结果分组属性必须同时出现在维度中：${propertyId}`,
        );
      }
    }
    if (!Number.isFinite(condition.value)) {
      throw new Error(`期间条件 ${condition.label} 的阈值必须是有限数字`);
    }
    if (
      condition.expectedPeriodCount != null &&
      (!Number.isInteger(condition.expectedPeriodCount) ||
        condition.expectedPeriodCount < 1 ||
        condition.expectedPeriodCount > 366)
    ) {
      throw new Error(`期间条件 ${condition.label} 的预期期间数无效`);
    }
    if (condition.quantifier === "AT_LEAST_N") {
      if (
        !Number.isInteger(condition.minimumMatches) ||
        (condition.minimumMatches ?? 0) < 1 ||
        (condition.minimumMatches ?? 0) > 366
      ) {
        throw new Error(`期间条件 ${condition.label} 的最低满足期间数无效`);
      }
    }
    if (aggregateFilters.some((filter) => filter.entityId === condition.measureId)) {
      throw new Error(
        `期间条件 ${condition.label} 已负责跨期间判断，不能再用 aggregate_filters 预先删除不达标期间`,
      );
    }
  }
  if (intent.periodConditions?.length && intent.groupSelections?.length) {
    throw new Error("当前版本不能在同一计划中同时使用期间条件和每组排名，请拆分为受控分析步骤");
  }
  if (
    intent.resultKind === "detail" &&
    (intent.timeGrain ||
      intent.derivedMeasures?.length ||
      intent.timeComparisons?.length ||
      intent.windowCalculations?.length ||
      intent.groupSelections?.length ||
      intent.periodConditions?.length)
  ) {
    throw new Error("时间粒度和计算算法只能用于聚合查询");
  }
}

function validateAggregateFilters(
  intent: AnalysisIntent,
  filters: NonNullable<AnalysisIntent["aggregateFilters"]>,
  measures: Map<string, Metric>,
): void {
  if (!filters.length) return;
  if (intent.resultKind !== "aggregate") {
    throw new Error("聚合后筛选只能用于聚合查询");
  }
  const calculationIds = new Set([
    ...(intent.derivedMeasures ?? []).map((item) => item.id),
    ...(intent.timeComparisons ?? []).map((item) => item.id),
    ...(intent.windowCalculations ?? []).map((item) => item.id),
  ]);
  for (const filter of filters) {
    if (!measures.has(filter.entityId) && !calculationIds.has(filter.entityId)) {
      throw new Error(
        `聚合后筛选引用了未提交的指标或计算项：${filter.entityId}`,
      );
    }
    if (!Number.isFinite(filter.value)) {
      throw new Error(
        `聚合后筛选 ${filter.entityId} 的阈值必须是有限数字`,
      );
    }
  }
}

function aggregateFilterEntityLabel(
  entityId: string,
  intent: AnalysisIntent,
  measures: Map<string, Metric>,
): string {
  const metric = measures.get(entityId);
  if (metric) return metric.label;
  const calculation = [
    ...(intent.derivedMeasures ?? []),
    ...(intent.timeComparisons ?? []),
    ...(intent.windowCalculations ?? []),
  ].find((candidate) => candidate.id === entityId);
  if (!calculation) {
    throw new Error(`聚合后筛选引用了不存在的结果字段：${entityId}`);
  }
  return calculation.label;
}

function requireMeasureReference(
  measures: Map<string, Metric>,
  id: string,
  calculationLabel: string,
): Metric {
  const metric = measures.get(id);
  if (!metric) {
    throw new Error(`计算项 ${calculationLabel} 引用了未提交的基础指标：${id}`);
  }
  return metric;
}

function requireAnalysisResultEntityLabel(
  intent: AnalysisIntent,
  measures: Map<string, Metric>,
  id: string,
  usageLabel: string,
): string {
  const metric = measures.get(id);
  if (metric) return metric.label;
  const calculation = [
    ...(intent.derivedMeasures ?? []),
    ...(intent.timeComparisons ?? []),
    ...(intent.windowCalculations ?? []),
  ].find((candidate) => candidate.id === id);
  if (calculation) return calculation.label;
  throw new Error(`计算项 ${usageLabel} 引用了不可用的排序指标或计算项：${id}`);
}

function validateDerivedCalculationGraph(
  calculations: DerivedMeasureCalculation[],
  measures: Map<string, Metric>,
): void {
  const calculationById = new Map(
    calculations.map((calculation) => [calculation.id, calculation]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string, parentLabel: string): void => {
    if (measures.has(id) || visited.has(id)) return;
    const calculation = calculationById.get(id);
    if (!calculation) {
      throw new Error(`派生计算 ${parentLabel} 引用了未提交的指标或计算项：${id}`);
    }
    if (visiting.has(id)) {
      throw new Error(`派生计算存在循环依赖：${calculation.label}`);
    }
    visiting.add(id);
    visit(calculation.leftMeasureId, calculation.label);
    visit(calculation.rightMeasureId, calculation.label);
    visiting.delete(id);
    visited.add(id);
  };
  for (const calculation of calculations) visit(calculation.id, calculation.label);
}

function compileDerivedMeasure(
  calculation: DerivedMeasureCalculation,
  calculations: DerivedMeasureCalculation[],
  measures: Map<string, Metric>,
  allMetrics: Map<string, Metric>,
  objects: Map<string, OntologyObject>,
  aliases: Map<string, string>,
  tables: Map<string, PhysicalTable>,
): string {
  const calculationById = new Map(
    calculations.map((candidate) => [candidate.id, candidate]),
  );
  const cache = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (id: string): string => {
    const cached = cache.get(id);
    if (cached) return cached;
    const metric = measures.get(id);
    if (metric) {
      const object = objects.get(metric.objectId);
      if (!object) throw new Error(`指标 ${metric.label} 的所属对象不存在`);
      const expression = compileMetric(
        metric,
        object,
        aliases,
        tables,
        allMetrics,
        objects,
      );
      cache.set(id, expression);
      return expression;
    }
    const derived = calculationById.get(id);
    if (!derived) {
      throw new Error(`派生计算 ${calculation.label} 引用了不存在的计算项：${id}`);
    }
    if (resolving.has(id)) throw new Error(`派生计算存在循环依赖：${derived.label}`);
    resolving.add(id);
    const expression = compileArithmeticExpression(
      derived.operator,
      resolve(derived.leftMeasureId),
      resolve(derived.rightMeasureId),
      derived.scale,
    );
    resolving.delete(id);
    cache.set(id, expression);
    return expression;
  };
  return resolve(calculation.id);
}

function compileArithmeticExpression(
  operator: DerivedMeasureCalculation["operator"],
  left: string,
  right: string,
  scale = 1,
): string {
  if (operator === "ADD") return `(${left} + ${right})`;
  if (operator === "SUBTRACT") return `(${left} - ${right})`;
  if (operator === "MULTIPLY") return `(${left} * ${right})`;
  if (operator === "DIVIDE" || operator === "RATIO") {
    return `((${left}) / NULLIF((${right}), 0) * ${formatNumericLiteral(scale)})`;
  }
  throw new Error(`不支持的派生计算：${operator}`);
}

function formatNumericLiteral(value: number): string {
  if (!Number.isFinite(value)) throw new Error("计算系数必须是有限数字");
  return String(value);
}

function resolveCompositionAggregateRoot(
  requestedRootId: string,
  measures: Metric[],
  semanticIndex: SemanticIndex,
  resultKind: AnalysisIntent["resultKind"],
): string {
  if (resultKind !== "aggregate" || !measures.length) return requestedRootId;
  const measureObjectIds = new Set(measures.map((measure) => measure.objectId));
  if (measureObjectIds.size !== 1) return requestedRootId;
  const measureObjectId = [...measureObjectIds][0]!;
  if (measureObjectId === requestedRootId) return requestedRootId;
  const path = semanticIndex.findRelationPath(measureObjectId, requestedRootId);
  if (!path.length) return requestedRootId;
  let currentId = measureObjectId;
  for (const relation of path) {
    const semantics = relation.composition;
    if (
      relation.type !== "COMPOSITION" ||
      !semantics ||
      semantics.aggregationPolicy !== "PRE_AGGREGATE_CHILD" ||
      semantics.childObjectId !== currentId
    ) {
      return requestedRootId;
    }
    currentId = semantics.parentObjectId;
  }
  return currentId === requestedRootId ? measureObjectId : requestedRootId;
}

function validateAggregationSafety(
  root: OntologyObject,
  measures: Metric[],
  _dimensions: Array<{ object: OntologyObject; property: OntologyProperty }>,
  timeGrain: TimeGrain | undefined,
  relationIds: string[],
  ontology: OntologySnapshot,
  resultKind: AnalysisIntent["resultKind"],
): void {
  const metricById = new Map(
    ontology.metrics.map((metric) => [metric.id, metric]),
  );
  const expandedMeasures = new Map<string, Metric>();
  const expand = (metric: Metric, visiting = new Set<string>()): void => {
    if (expandedMeasures.has(metric.id)) return;
    if (visiting.has(metric.id)) {
      throw new Error(`复合指标存在循环依赖：${metric.label}`);
    }
    if (metric.metricType !== "DERIVED") {
      expandedMeasures.set(metric.id, metric);
      return;
    }
    const next = new Set(visiting).add(metric.id);
    for (const dependencyId of [metric.leftMetricId, metric.rightMetricId]) {
      const dependency = dependencyId
        ? metricById.get(dependencyId)
        : undefined;
      if (!dependency) throw new Error(`复合指标 ${metric.label} 的依赖指标不存在`);
      expand(dependency, next);
    }
  };
  for (const metric of measures) expand(metric);
  const governedMeasures = [...expandedMeasures.values()];
  const measureObjects = new Set(governedMeasures.map((metric) => metric.objectId));
  if (measureObjects.size > 1) {
    throw new Error("当前 IR 不允许直接混合多个事实对象的指标，请先配置同粒度派生对象");
  }
  for (const metric of governedMeasures) {
    const object = ontology.objects.find((candidate) => candidate.id === metric.objectId);
    const property = object?.properties.find(
      (candidate) => candidate.id === metric.sourcePropertyId,
    );
    const numeric = property?.numericSpec;
    if (!numeric) continue;
    if (
      metric.aggregation === "SUM" &&
      (numeric.kind === "RATIO" ||
        numeric.aggregationBehavior === "NON_ADDITIVE")
    ) {
      throw new Error(`指标 ${metric.label} 的来源属性 ${property!.label} 不允许求和`);
    }
    if (
      metric.aggregation === "SUM" &&
      numeric.aggregationBehavior === "SEMI_ADDITIVE" &&
      timeGrain
    ) {
      throw new Error(
        `指标 ${metric.label} 是半可加指标，不能直接按${timeGrainLabel(timeGrain)}跨时间求和`,
      );
    }
  }
  const joined = new Set([root.id]);
  for (const relationId of relationIds) {
    const relation = ontology.relations.find((candidate) => candidate.id === relationId);
    if (!relation) continue;
    const fromSource =
      joined.has(relation.sourceObjectId) && !joined.has(relation.targetObjectId);
    const fromTarget =
      joined.has(relation.targetObjectId) && !joined.has(relation.sourceObjectId);
    const expands =
      relation.cardinality === "MANY_TO_MANY" ||
      (fromSource && relation.cardinality === "ONE_TO_MANY") ||
      (fromTarget && relation.cardinality === "MANY_TO_ONE");
    if (expands) {
      if (relation.type === "COMPOSITION") {
        const policy = relation.composition?.aggregationPolicy ?? "PRE_AGGREGATE_CHILD";
        if (policy === "EXISTS_ONLY") {
          throw new Error(
            `主子关系 ${relation.name} 仅允许用于 EXISTS 筛选，不能展开子对象`,
          );
        }
        if (resultKind === "detail") {
          joined.add(
            fromSource ? relation.targetObjectId : relation.sourceObjectId,
          );
          continue;
        }
        throw new Error(
          `主子关系 ${relation.name} 会放大 ${root.label} 的聚合行数；请改用子对象指标并按主对象维度汇总`,
        );
      }
      throw new Error(
        `关系 ${relation.name} 会放大 ${root.label} 的行数，IR 已阻止可能的重复聚合`,
      );
    }
    joined.add(
      fromSource ? relation.targetObjectId : relation.sourceObjectId,
    );
  }
}

function compileTimeBucket(column: string, grain: TimeGrain): string {
  return `DATE_TRUNC(${column}, '${grain.toLowerCase()}')`;
}

function timeGrainLabel(grain: TimeGrain): string {
  return {
    DAY: "日期",
    WEEK: "周",
    MONTH: "月份",
    QUARTER: "季度",
    YEAR: "年份",
  }[grain];
}

interface LayeredAnalysisContext {
  intent: AnalysisIntent;
  dimensions: Array<{ object: OntologyObject; property: OntologyProperty }>;
  displayFallbacks: Map<
    string,
    { object: OntologyObject; property: OntologyProperty }
  >;
  measures: Metric[];
  measureByReference: Map<string, Metric>;
  metricById: Map<string, Metric>;
  objectById: Map<string, OntologyObject>;
  aliases: Map<string, string>;
  tablesByObject: Map<string, PhysicalTable>;
  from: string;
  joins: string[];
  whereParts: string[];
  parameters: unknown[];
  timeBinding?: { object: OntologyObject; property: OntologyProperty };
  resolvedTime?: QueryIR["timeRange"];
  orderParts: string[];
  limit: number;
}

function compileLayeredAnalysis(context: LayeredAnalysisContext): string {
  const {
    intent,
    dimensions,
    displayFallbacks,
    measures,
    measureByReference,
    metricById,
    objectById,
    aliases,
    tablesByObject,
    from,
    joins,
    whereParts,
    parameters,
    timeBinding,
    resolvedTime,
    limit,
  } = context;
  const dimensionAliases = new Map<string, string>();
  const dimensionIdentityAliases = new Map<string, string>();
  const measureAliases = new Map<string, string>();
  const baseSelect: string[] = [];
  const baseGroups: string[] = [];
  dimensions.forEach((binding, index) => {
    const alias = `__d${index}`;
    dimensionAliases.set(binding.property.id, alias);
    const fallback = displayFallbacks.get(binding.property.id);
    const expression = compileDisplayDimensionExpression(
      binding,
      fallback,
      aliases,
    );
    baseSelect.push(`${expression} AS ${quoteIdentifier(alias)}`);
    baseGroups.push(expression);
    if (fallback) {
      const identityAlias = `__dk${index}`;
      const identityExpression = qualifiedColumn(
        aliases.get(fallback.object.id)!,
        fallback.property,
      );
      dimensionIdentityAliases.set(binding.property.id, identityAlias);
      baseSelect.push(`${identityExpression} AS ${quoteIdentifier(identityAlias)}`);
      baseGroups.push(identityExpression);
    }
  });
  if (intent.timeGrain && timeBinding) {
    const expression = compileTimeBucket(
      qualifiedColumn(aliases.get(timeBinding.object.id)!, timeBinding.property),
      intent.timeGrain.unit,
    );
    baseSelect.push(`${expression} AS \`__time_bucket\``);
    baseGroups.push(expression);
  }
  measures.forEach((metric, index) => {
    const alias = `__m${index}`;
    measureAliases.set(metric.id, alias);
    const object = objectById.get(metric.objectId);
    if (!object) throw new Error(`指标 ${metric.label} 的所属对象不存在`);
    baseSelect.push(
      `${compileMetric(metric, object, aliases, tablesByObject, metricById, objectById)} AS ${quoteIdentifier(alias)}`,
    );
  });

  const comparisonJoins: string[] = [];
  const comparisonExpressions = new Map<string, string>();
  for (const [index, calculation] of (intent.timeComparisons ?? []).entries()) {
    const previousAlias = `p${index}`;
    const metric = requireMeasureReference(
      measureByReference,
      calculation.measureId,
      calculation.label,
    );
    const metricAlias = measureAliases.get(metric.id)!;
    const dimensionConditions = dimensions.map((binding) => {
      const alias =
        dimensionIdentityAliases.get(binding.property.id) ??
        dimensionAliases.get(binding.property.id)!;
      return `${previousAlias}.${quoteIdentifier(alias)} <=> c.${quoteIdentifier(alias)}`;
    });
    const interval = timeComparisonInterval(
      calculation.comparison,
      intent.timeGrain!.unit,
    );
    comparisonJoins.push(
      [
        `LEFT JOIN \`base\` AS ${previousAlias} ON`,
        ...[
          ...dimensionConditions,
          `${previousAlias}.\`__time_bucket\` = DATE_SUB(c.\`__time_bucket\`, INTERVAL ${interval})`,
        ].map((condition, conditionIndex) =>
          `${conditionIndex ? "  AND " : "  "}${condition}`,
        ),
      ].join("\n"),
    );
    const current = `c.${quoteIdentifier(metricAlias)}`;
    const previous = `${previousAlias}.${quoteIdentifier(metricAlias)}`;
    comparisonExpressions.set(
      calculation.id,
      calculation.output === "PREVIOUS_VALUE"
        ? previous
        : calculation.output === "DIFFERENCE"
          ? `(${current} - ${previous})`
          : `((${current} - ${previous}) / NULLIF(${previous}, 0))`,
    );
  }

  const finalSelect: string[] = [];
  for (const binding of dimensions) {
    finalSelect.push(
      `c.${quoteIdentifier(dimensionAliases.get(binding.property.id)!)} AS ${quoteIdentifier(binding.property.label)}`,
    );
  }
  if (intent.timeGrain) {
    finalSelect.push(
      `c.\`__time_bucket\` AS ${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))}`,
    );
  }
  for (const metric of measures) {
    finalSelect.push(
      `c.${quoteIdentifier(measureAliases.get(metric.id)!)} AS ${quoteIdentifier(metric.label)}`,
    );
  }
  const layeredDerivedExpressions = compileLayeredDerivedExpressions(
    intent.derivedMeasures ?? [],
    measureByReference,
    measureAliases,
  );
  for (const calculation of intent.derivedMeasures ?? []) {
    finalSelect.push(
      `${layeredDerivedExpressions.get(calculation.id)} AS ${quoteIdentifier(calculation.label)}`,
    );
  }
  for (const calculation of intent.timeComparisons ?? []) {
    finalSelect.push(
      `${comparisonExpressions.get(calculation.id)} AS ${quoteIdentifier(calculation.label)}`,
    );
  }
  for (const calculation of intent.windowCalculations ?? []) {
    finalSelect.push(
      `${compileWindowExpression(
        calculation,
        measureByReference,
        measureAliases,
        new Map(
          dimensions.map((binding) => [
            binding.property.id,
            dimensionIdentityAliases.get(binding.property.id) ??
              dimensionAliases.get(binding.property.id)!,
          ]),
        ),
        intent,
      )} AS ${quoteIdentifier(calculation.label)}`,
    );
  }

  const finalWhere: string[] = [];
  if (resolvedTime && intent.timeComparisons?.length) {
    finalWhere.push("c.`__time_bucket` >= ?");
    parameters.push(resolvedTime.start);
    finalWhere.push("c.`__time_bucket` < ?");
    parameters.push(resolvedTime.endExclusive);
  }
  const finalOrder = compileLayeredOrder(
    intent,
    dimensions,
    measureByReference,
  );
  const baseCte = [
    "WITH `base` AS (",
    `  SELECT ${baseSelect.join(", ")}`,
    `  FROM ${from}`,
    ...joins.map((join) => `  ${join}`),
    whereParts.length ? `  WHERE ${whereParts.join("\n    AND ")}` : "",
    baseGroups.length ? `  GROUP BY ${baseGroups.join(", ")}` : "",
    ")",
  ].filter(Boolean);
  const analyzedQuery = [
    `SELECT ${finalSelect.join(", ")}`,
    "FROM `base` AS c",
    ...comparisonJoins,
    finalWhere.length ? `WHERE ${finalWhere.join("\n  AND ")}` : "",
  ].filter(Boolean);
  const aggregateFilters = intent.aggregateFilterExpression
    ? flattenAggregateFilterExpression(intent.aggregateFilterExpression)
    : intent.aggregateFilters ?? [];
  const groupSelections = intent.groupSelections ?? [];
  const periodConditions = intent.periodConditions ?? [];
  if (
    !aggregateFilters.length &&
    !groupSelections.length &&
    !periodConditions.length
  ) {
    return [
      ...baseCte,
      ...analyzedQuery,
      finalOrder.length ? `ORDER BY ${finalOrder.join(", ")}` : "",
      `LIMIT ${limit}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  let aggregateWhere = "";
  if (aggregateFilters.length) {
    const compiledAggregateParts = aggregateFilters.map((filter) => {
      parameters.push(filter.value);
      return compileAggregateFilter(
        `a.${quoteIdentifier(
          aggregateFilterEntityLabel(
            filter.entityId,
            intent,
            measureByReference,
          ),
        )}`,
        filter.operator,
      );
    });
    let conditionIndex = 0;
    aggregateWhere = intent.aggregateFilterExpression
      ? compileAggregateFilterExpression(
          intent.aggregateFilterExpression,
          () => {
            const part = compiledAggregateParts[conditionIndex];
            conditionIndex += 1;
            if (!part) {
              throw new Error("聚合逻辑筛选树与筛选条件数量不一致");
            }
            return part;
          },
        )
      : compiledAggregateParts.join("\n  AND ");
    if (conditionIndex && conditionIndex !== compiledAggregateParts.length) {
      throw new Error("聚合逻辑筛选树未覆盖全部筛选条件");
    }
  }
  if (!groupSelections.length && !periodConditions.length) {
    return [
      ...baseCte.slice(0, -1),
      "),",
      "`analyzed` AS (",
      ...analyzedQuery.map((line) => `  ${line}`),
      ")",
      "SELECT *",
      "FROM `analyzed` AS a",
      `WHERE ${aggregateWhere}`,
      finalOrder.length ? `ORDER BY ${finalOrder.join(", ")}` : "",
      `LIMIT ${limit}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const ctes: string[] = [
    baseCte.join("\n").replace(/^WITH /, ""),
    ["`analyzed` AS (", ...analyzedQuery.map((line) => `  ${line}`), ")"].join(
      "\n",
    ),
  ];
  let currentName = "analyzed";
  if (aggregateWhere) {
    ctes.push(
      [
        "`eligible` AS (",
        "  SELECT *",
        `  FROM ${quoteIdentifier(currentName)} AS a`,
        `  WHERE ${aggregateWhere}`,
        ")",
      ].join("\n"),
    );
    currentName = "eligible";
  }

  if (groupSelections.length) {
    const rankExpressions = groupSelections.map((selection) => {
      const orderLabel = requireAnalysisResultEntityLabel(
        intent,
        measureByReference,
        selection.orderByEntityId,
        selection.label,
      );
      const partitions = selection.partitionByPropertyIds.map((propertyId) => {
        const binding = dimensions.find(
          (candidate) => candidate.property.id === propertyId,
        );
        if (!binding) {
          throw new Error(`每组排名 ${selection.label} 引用了不存在的分区属性`);
        }
        return `g.${quoteIdentifier(binding.property.label)}`;
      });
      const direction = selection.operator === "TOP_N" ? "DESC" : "ASC";
      const rankFunction = selection.ties === "INCLUDE" ? "RANK" : "ROW_NUMBER";
      return `${rankFunction}() OVER (PARTITION BY ${partitions.join(", ")} ORDER BY g.${quoteIdentifier(orderLabel)} ${direction}) AS ${quoteIdentifier(selection.label)}`;
    });
    ctes.push(
      [
        "`ranked` AS (",
        `  SELECT g.*, ${rankExpressions.join(", ")}`,
        `  FROM ${quoteIdentifier(currentName)} AS g`,
        ")",
      ].join("\n"),
    );
    ctes.push(
      [
        "`selected` AS (",
        "  SELECT *",
        "  FROM `ranked` AS r",
        `  WHERE ${groupSelections
          .map(
            (selection) =>
              `r.${quoteIdentifier(selection.label)} <= ${selection.count}`,
          )
          .join("\n    AND ")}`,
        ")",
      ].join("\n"),
    );
    currentName = "selected";
  }

  let outputOrder = finalOrder;
  if (periodConditions.length) {
    const groupIds = periodConditions[0]!.groupByPropertyIds;
    if (
      periodConditions.some(
        (condition) =>
          condition.groupByPropertyIds.join("\u0000") !==
          groupIds.join("\u0000"),
      )
    ) {
      throw new Error("同一查询中的期间条件必须使用相同的结果分组属性");
    }
    const groupBindings = groupIds.map((propertyId) => {
      const binding = dimensions.find(
        (candidate) => candidate.property.id === propertyId,
      );
      if (!binding) throw new Error(`期间条件引用了不存在的分组属性：${propertyId}`);
      return binding;
    });
    const periodLabel = timeGrainLabel(intent.timeGrain!.unit);
    const regroupSelect = [
      ...groupBindings.map(
        (binding) =>
          `p.${quoteIdentifier(binding.property.label)} AS ${quoteIdentifier(binding.property.label)}`,
      ),
      `COUNT(DISTINCT p.${quoteIdentifier(periodLabel)}) AS ${quoteIdentifier("覆盖期间数")}`,
    ];
    for (const condition of periodConditions) {
      const metric = requireMeasureReference(
        measureByReference,
        condition.measureId,
        condition.label,
      );
      parameters.push(condition.value);
      const predicate = compileAggregateFilter(
        `p.${quoteIdentifier(metric.label)}`,
        condition.operator,
      );
      regroupSelect.push(
        `SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) AS ${quoteIdentifier(`${condition.label}满足期间数`)}`,
      );
      regroupSelect.push(
        `MIN(p.${quoteIdentifier(metric.label)}) AS ${quoteIdentifier(`${metric.label}期间最低值`)}`,
      );
    }
    ctes.push(
      [
        "`period_regrouped` AS (",
        `  SELECT ${regroupSelect.join(", ")}`,
        `  FROM ${quoteIdentifier(currentName)} AS p`,
        `  GROUP BY ${groupBindings
          .map((binding) => `p.${quoteIdentifier(binding.property.label)}`)
          .join(", ")}`,
        ")",
      ].join("\n"),
    );
    const periodWhere = periodConditions.flatMap((condition) => {
      const coverage = `r.${quoteIdentifier("覆盖期间数")}`;
      const matches = `r.${quoteIdentifier(`${condition.label}满足期间数`)}`;
      const expected =
        condition.expectedPeriodCount ?? resolvedTime?.periodCount;
      const clauses: string[] = [];
      if (condition.missingPeriodPolicy === "FAIL") {
        if (!expected) {
          throw new Error(
            `期间条件 ${condition.label} 要求缺失期间不通过，但没有可用的预期期间数`,
          );
        }
        clauses.push(`${coverage} = ${expected}`);
      }
      if (condition.quantifier === "EVERY") {
        clauses.push(
          expected && condition.missingPeriodPolicy === "FAIL"
            ? `${matches} = ${expected}`
            : `(${coverage} > 0 AND ${matches} = ${coverage})`,
        );
      } else if (condition.quantifier === "ANY") {
        clauses.push(`${matches} >= 1`);
      } else {
        clauses.push(`${matches} >= ${condition.minimumMatches}`);
      }
      return clauses;
    });
    ctes.push(
      [
        "`period_matched` AS (",
        "  SELECT *",
        "  FROM `period_regrouped` AS r",
        `  WHERE ${periodWhere.join("\n    AND ")}`,
        ")",
      ].join("\n"),
    );
    currentName = "period_matched";
    outputOrder = compilePeriodResultOrder(intent, groupBindings);
  }
  return [
    `WITH ${ctes.join(",\n")}`,
    "SELECT *",
    `FROM ${quoteIdentifier(currentName)} AS result`,
    outputOrder.length ? `ORDER BY ${outputOrder.join(", ")}` : "",
    `LIMIT ${limit}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function compileLayeredDerivedExpressions(
  calculations: DerivedMeasureCalculation[],
  measures: Map<string, Metric>,
  measureAliases: Map<string, string>,
): Map<string, string> {
  const calculationById = new Map(
    calculations.map((calculation) => [calculation.id, calculation]),
  );
  const cache = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (id: string): string => {
    const cached = cache.get(id);
    if (cached) return cached;
    const metric = measures.get(id);
    if (metric) {
      const expression = `c.${quoteIdentifier(measureAliases.get(metric.id)!)}`;
      cache.set(id, expression);
      return expression;
    }
    const calculation = calculationById.get(id);
    if (!calculation) throw new Error(`派生计算引用了不存在的计算项：${id}`);
    if (resolving.has(id)) throw new Error(`派生计算存在循环依赖：${calculation.label}`);
    resolving.add(id);
    const expression = compileArithmeticExpression(
      calculation.operator,
      resolve(calculation.leftMeasureId),
      resolve(calculation.rightMeasureId),
      calculation.scale,
    );
    resolving.delete(id);
    cache.set(id, expression);
    return expression;
  };
  for (const calculation of calculations) resolve(calculation.id);
  return cache;
}

function compileWindowExpression(
  calculation: WindowCalculation,
  measures: Map<string, Metric>,
  measureAliases: Map<string, string>,
  dimensionAliases: Map<string, string>,
  intent: AnalysisIntent,
): string {
  const metric = requireMeasureReference(
    measures,
    calculation.measureId,
    calculation.label,
  );
  const value = `c.${quoteIdentifier(measureAliases.get(metric.id)!)}`;
  const partitions = calculation.partitionByPropertyIds.map((propertyId) =>
    propertyId === "__time__"
      ? "c.`__time_bucket`"
      : `c.${quoteIdentifier(dimensionAliases.get(propertyId)!)}`,
  );
  if (
    calculation.operator === "PERCENT_OF_TOTAL" ||
    calculation.operator === "PERCENT_OF_PARTITION"
  ) {
    const over = partitions.length
      ? `PARTITION BY ${partitions.join(", ")}`
      : "";
    const scale = formatNumericLiteral(calculation.scale ?? 100);
    const precision = calculation.precision ?? 2;
    return `ROUND(((${value}) / NULLIF(SUM(${value}) OVER (${over}), 0) * ${scale}), ${precision})`;
  }
  if (!calculation.orderBy) {
    throw new Error(`窗口计算 ${calculation.label} 缺少排序字段`);
  }
  const orderEntity = calculation.orderBy.entityId;
  const orderMetric = measures.get(orderEntity);
  const orderExpression =
    orderEntity === "__time__"
      ? "c.`__time_bucket`"
      : orderMetric
        ? `c.${quoteIdentifier(measureAliases.get(orderMetric.id)!)}`
        : `c.${quoteIdentifier(dimensionAliases.get(orderEntity)!)}`;
  const overPrefix = [
    partitions.length ? `PARTITION BY ${partitions.join(", ")}` : "",
    `ORDER BY ${orderExpression} ${calculation.orderBy.direction}`,
  ]
    .filter(Boolean)
    .join(" ");
  if (calculation.operator === "RANK") return `RANK() OVER (${overPrefix})`;
  if (calculation.operator === "DENSE_RANK") {
    return `DENSE_RANK() OVER (${overPrefix})`;
  }
  if (calculation.operator === "RUNNING_SUM") {
    return `SUM(${value}) OVER (${overPrefix} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
  }
  const size = calculation.windowSize ?? 3;
  return `AVG(${value}) OVER (${overPrefix} ROWS BETWEEN ${size - 1} PRECEDING AND CURRENT ROW)`;
}

function compileLayeredOrder(
  intent: AnalysisIntent,
  dimensions: Array<{ property: OntologyProperty }>,
  measures: Map<string, Metric>,
): string[] {
  const calculations = [
    ...(intent.derivedMeasures ?? []),
    ...(intent.timeComparisons ?? []),
    ...(intent.windowCalculations ?? []),
  ];
  const parts = (intent.sort ?? []).map((sort) => {
    const metric = measures.get(sort.entityId);
    if (metric) return `${quoteIdentifier(metric.label)} ${sort.direction}`;
    const calculation = calculations.find((candidate) => candidate.id === sort.entityId);
    if (calculation) return `${quoteIdentifier(calculation.label)} ${sort.direction}`;
    if (sort.entityId === "__time__" && intent.timeGrain) {
      return `${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))} ${sort.direction}`;
    }
    const dimension = dimensions.find(
      (binding) => binding.property.id === sort.entityId,
    );
    if (!dimension) throw new Error(`排序字段未包含在结果粒度中：${sort.entityId}`);
    return `${quoteIdentifier(dimension.property.label)} ${sort.direction}`;
  });
  if (!parts.length && intent.timeGrain) {
    parts.push(`${quoteIdentifier(timeGrainLabel(intent.timeGrain.unit))} ASC`);
  }
  return parts;
}

function compilePeriodResultOrder(
  intent: AnalysisIntent,
  groupBindings: Array<{ property: OntologyProperty }>,
): string[] {
  const parts = (intent.sort ?? []).map((sort) => {
    const binding = groupBindings.find(
      (candidate) => candidate.property.id === sort.entityId,
    );
    if (!binding) {
      throw new Error(
        `跨期间结果只能按最终分组属性排序：${sort.entityId}`,
      );
    }
    return `${quoteIdentifier(binding.property.label)} ${sort.direction}`;
  });
  return parts;
}

function periodQuantifierLabel(
  quantifier: NonNullable<AnalysisIntent["periodConditions"]>[number]["quantifier"],
): string {
  return {
    EVERY: "每一期都满足",
    ANY: "任意一期满足",
    AT_LEAST_N: "至少 N 期满足",
  }[quantifier];
}

function timeComparisonInterval(
  comparison: TimeComparisonCalculation["comparison"],
  grain: TimeGrain,
): string {
  if (comparison === "YEAR_OVER_YEAR") return "1 YEAR";
  return {
    DAY: "1 DAY",
    WEEK: "1 WEEK",
    MONTH: "1 MONTH",
    QUARTER: "3 MONTH",
    YEAR: "1 YEAR",
  }[grain];
}

function resolveComparisonTimeRanges(
  range: {
    start: string;
    endExclusive: string;
  },
  grain: TimeGrain | undefined,
  comparisons: TimeComparisonCalculation[],
): NonNullable<NonNullable<QueryIR["timeRange"]>["comparisonRanges"]> {
  if (!grain) throw new Error("时间比较必须指定时间粒度");
  const uniqueComparisons = [
    ...new Set(comparisons.map((calculation) => calculation.comparison)),
  ];
  return uniqueComparisons.map((comparison) => {
    const shift =
      comparison === "YEAR_OVER_YEAR" || grain === "YEAR"
        ? { years: -1 }
        : grain === "QUARTER"
          ? { months: -3 }
          : grain === "MONTH"
            ? { months: -1 }
            : grain === "WEEK"
              ? { days: -7 }
              : { days: -1 };
    return {
      comparison,
      start: shiftDateText(range.start, shift),
      endExclusive: shiftDateText(range.endExclusive, shift),
    };
  });
}

function shiftDateText(
  value: string,
  shift: { years?: number; months?: number; days?: number },
): string {
  const [year, month, day] = value
    .slice(0, 10)
    .split("-")
    .map(Number) as [number, number, number];
  if (shift.days) {
    return dateText(year, month, day + shift.days);
  }
  const targetMonthIndex =
    year * 12 + month - 1 + (shift.years ?? 0) * 12 + (shift.months ?? 0);
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return dateText(targetYear, targetMonth, Math.min(day, lastDay));
}

function resolveMeasureReference(
  id: string,
  ontology: OntologySnapshot,
  owners: Array<{ object: OntologyObject; property: OntologyProperty }>,
): { metric: Metric; source: string } {
  const metric = ontology.metrics.find((candidate) => candidate.id === id);
  if (metric) {
    return {
      metric,
      source:
        metric.metricType === "DERIVED"
          ? `复合指标ID精确绑定 · ${governedMetricFormula(metric, ontology.metrics)} · 依赖 ${collectMetricDependencyLabels(metric, ontology.metrics).join("、")}`
          : "指标ID精确绑定",
    };
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

function collectMetricDependencyLabels(
  metric: Metric,
  metrics: Metric[],
  visited = new Set<string>(),
): string[] {
  if (metric.metricType !== "DERIVED" || visited.has(metric.id)) return [];
  visited.add(metric.id);
  const dependencies = [metric.leftMetricId, metric.rightMetricId]
    .map((id) => metrics.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Metric => Boolean(candidate));
  return [
    ...new Set(
      dependencies.flatMap((dependency) => [
        dependency.label,
        ...collectMetricDependencyLabels(dependency, metrics, visited),
      ]),
    ),
  ];
}

function governedMetricFormula(
  metric: Metric,
  metrics: Metric[],
  resolving = new Set<string>(),
): string {
  if (metric.metricType !== "DERIVED") return metric.label;
  if (resolving.has(metric.id)) return "循环依赖";
  const next = new Set(resolving).add(metric.id);
  const left = metrics.find((candidate) => candidate.id === metric.leftMetricId);
  const right = metrics.find((candidate) => candidate.id === metric.rightMetricId);
  if (!left || !right || !metric.calculationOperator) return "定义不完整";
  const operator = {
    ADD: "+",
    SUBTRACT: "-",
    MULTIPLY: "×",
    DIVIDE: "÷",
    RATIO: "÷",
  }[metric.calculationOperator];
  const leftLabel =
    left.metricType === "DERIVED"
      ? governedMetricFormula(left, metrics, next)
      : left.label;
  const rightLabel =
    right.metricType === "DERIVED"
      ? governedMetricFormula(right, metrics, next)
      : right.label;
  return `( ${leftLabel} ${operator} ${rightLabel} )${
    metric.scale && metric.scale !== 1 ? ` × ${metric.scale}` : ""
  }`;
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
    aggregation === "NONE" ||
    (aggregation === "SUM" &&
      (numeric.kind === "RATIO" ||
        numeric.aggregationBehavior === "NON_ADDITIVE"))
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

function findHierarchyPropertyLabel(
  ontology: OntologySnapshot,
  propertyId: string,
): string {
  return (
    ontology.objects
      .flatMap((object) => object.properties)
      .find((property) => property.id === propertyId)?.label ?? propertyId
  );
}

function resolveTimeBinding(
  intent: AnalysisIntent,
  root: OntologyObject,
  measures: Metric[],
  owners: Array<{ object: OntologyObject; property: OntologyProperty }>,
): { object: OntologyObject; property: OntologyProperty } {
  const explicitId = intent.timeRange?.propertyId ?? intent.timeGrain?.propertyId;
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
  metrics: Map<string, Metric>,
  objects: Map<string, OntologyObject>,
  resolving: Set<string> = new Set(),
): string {
  if (metric.metricType === "DERIVED") {
    if (resolving.has(metric.id)) {
      throw new Error(`复合指标存在循环依赖：${metric.label}`);
    }
    const left = metric.leftMetricId
      ? metrics.get(metric.leftMetricId)
      : undefined;
    const right = metric.rightMetricId
      ? metrics.get(metric.rightMetricId)
      : undefined;
    if (!left || !right || !metric.calculationOperator) {
      throw new Error(`复合指标 ${metric.label} 的定义不完整`);
    }
    if (left.objectId !== metric.objectId || right.objectId !== metric.objectId) {
      throw new Error(`复合指标 ${metric.label} 只能引用同一事实对象的指标`);
    }
    const nextResolving = new Set(resolving).add(metric.id);
    const leftObject = objects.get(left.objectId);
    const rightObject = objects.get(right.objectId);
    if (!leftObject || !rightObject) {
      throw new Error(`复合指标 ${metric.label} 的依赖对象不存在`);
    }
    return compileArithmeticExpression(
      metric.calculationOperator,
      compileMetric(
        left,
        leftObject,
        aliases,
        tables,
        metrics,
        objects,
        nextResolving,
      ),
      compileMetric(
        right,
        rightObject,
        aliases,
        tables,
        metrics,
        objects,
        nextResolving,
      ),
      metric.scale,
    );
  }
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

function compileHierarchyFilter(
  filter: HierarchyAnalysisFilter & { hierarchy: RecursiveHierarchyMatch },
  aliases: Map<string, string>,
  objectById: Map<string, OntologyObject>,
  tableById: Map<string, PhysicalTable>,
  parameters: unknown[],
): string {
  const { hierarchy } = filter;
  const closure = hierarchy.closure;
  if (!closure) {
    throw new Error(`递归层级 ${hierarchy.hierarchyLabel} 未配置闭包表`);
  }
  const nodeObject = objectById.get(hierarchy.objectId);
  const closureObject = objectById.get(closure.objectId);
  const nodeAlias = aliases.get(hierarchy.objectId);
  const nodeProperty = nodeObject?.properties.find(
    (property) => property.id === hierarchy.nodeIdPropertyId,
  );
  const ancestorProperty = closureObject?.properties.find(
    (property) => property.id === closure.ancestorPropertyId,
  );
  const descendantProperty = closureObject?.properties.find(
    (property) => property.id === closure.descendantPropertyId,
  );
  const depthProperty = closureObject?.properties.find(
    (property) => property.id === closure.depthPropertyId,
  );
  const closureTable = closureObject
    ? tableById.get(closureObject.sourceTableId)
    : undefined;
  if (
    !nodeObject ||
    !closureObject ||
    !nodeAlias ||
    !nodeProperty ||
    !ancestorProperty ||
    !descendantProperty ||
    !depthProperty ||
    !closureTable
  ) {
    throw new Error(`递归层级 ${hierarchy.hierarchyLabel} 的闭包表配置不可用`);
  }
  parameters.push(filter.anchorValue);
  const closureAlias = `hc${parameters.length}`;
  const nodeColumn = qualifiedColumn(nodeAlias, nodeProperty);
  const ancestorColumn = qualifiedColumn(closureAlias, ancestorProperty);
  const descendantColumn = qualifiedColumn(closureAlias, descendantProperty);
  const depthColumn = qualifiedColumn(closureAlias, depthProperty);
  const endpointCondition = filter.direction === "DESCENDANTS"
    ? `${descendantColumn} = ${nodeColumn}\n    AND ${ancestorColumn} = ?`
    : `${ancestorColumn} = ${nodeColumn}\n    AND ${descendantColumn} = ?`;
  const minimumDepth = filter.includeSelf === false ? 1 : 0;
  return [
    "EXISTS (",
    `  SELECT 1 FROM ${qualifiedTable(closureTable)} AS ${closureAlias}`,
    `  WHERE ${endpointCondition}`,
    `    AND ${depthColumn} >= ${minimumDepth}`,
    `    AND ${depthColumn} <= ${hierarchy.maxDepth}`,
    ")",
  ].join("\n");
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

function compileAggregateFilter(
  column: string,
  operator: NonNullable<AnalysisIntent["aggregateFilters"]>[number]["operator"],
): string {
  const symbols = {
    EQ: "=",
    NE: "<>",
    GT: ">",
    GTE: ">=",
    LT: "<",
    LTE: "<=",
  } as const;
  return `${column} ${symbols[operator]} ?`;
}

function filterOperatorLabel(operator: QueryFilterOperator): string {
  return {
    EQ: "=",
    NE: "≠",
    GT: ">",
    GTE: "≥",
    LT: "<",
    LTE: "≤",
    IN: "属于",
    CONTAINS: "包含",
    PREFIX: "前缀为",
    IS_NULL: "为空",
    NOT_NULL: "不为空",
  }[operator];
}

function resolveNaturalTimeRange(
  input: NonNullable<AnalysisIntent["timeRange"]>,
  now: Date,
  timezone: string,
): {
  start: string;
  endExclusive: string;
  mode: NonNullable<QueryIR["timeRange"]>["mode"];
  periodCount?: number;
  periodUnit?: TimeGrain;
} {
  const expression = input.expression;
  const text = expression.trim();
  const { year, month, day } = zonedDateParts(now, timezone);
  if (input.kind) {
    switch (input.kind) {
      case "TODAY":
        return {
          start: dateText(year, month, day),
          endExclusive: dateText(year, month, day + 1),
          mode: "TO_DATE",
        };
      case "YESTERDAY":
        return {
          start: dateText(year, month, day - 1),
          endExclusive: dateText(year, month, day),
          mode: "FULL_PERIOD",
        };
      case "CURRENT_WEEK": {
        const weekday = zonedWeekday(now, timezone);
        return {
          start: dateText(year, month, day - weekday),
          endExclusive: dateText(year, month, day + 1),
          mode: "TO_DATE",
        };
      }
      case "PREVIOUS_WEEK": {
        const weekday = zonedWeekday(now, timezone);
        return {
          start: dateText(year, month, day - weekday - 7),
          endExclusive: dateText(year, month, day - weekday),
          mode: "FULL_PERIOD",
        };
      }
      case "CURRENT_MONTH":
        return {
          start: dateText(year, month, 1),
          endExclusive: dateText(year, month, day + 1),
          mode: "TO_DATE",
        };
      case "PREVIOUS_MONTH":
        return {
          start: dateText(year, month - 1, 1),
          endExclusive: dateText(year, month, 1),
          mode: "FULL_PERIOD",
        };
      case "CURRENT_QUARTER": {
        const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
        return {
          start: dateText(year, quarterMonth, 1),
          endExclusive: dateText(year, month, day + 1),
          mode: "TO_DATE",
        };
      }
      case "PREVIOUS_QUARTER": {
        const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
        return {
          start: dateText(year, quarterMonth - 3, 1),
          endExclusive: dateText(year, quarterMonth, 1),
          mode: "FULL_PERIOD",
        };
      }
      case "CURRENT_YEAR":
        return {
          start: dateText(year, 1, 1),
          endExclusive: dateText(year, month, day + 1),
          mode: "TO_DATE",
        };
      case "PREVIOUS_YEAR":
        return {
          start: dateText(year - 1, 1, 1),
          endExclusive: dateText(year, 1, 1),
          mode: "FULL_PERIOD",
        };
      case "ABSOLUTE_YEAR":
        if (!input.year) throw new Error("ABSOLUTE_YEAR 缺少 year");
        return {
          start: dateText(input.year, 1, 1),
          endExclusive: dateText(input.year + 1, 1, 1),
          mode: "FULL_PERIOD",
        };
      case "ABSOLUTE_MONTH":
        if (!input.year || !input.month) {
          throw new Error("ABSOLUTE_MONTH 缺少 year 或 month");
        }
        return {
          start: dateText(input.year, input.month, 1),
          endExclusive: dateText(input.year, input.month + 1, 1),
          mode: "FULL_PERIOD",
        };
      case "ROLLING_PERIODS":
        return resolveRollingPeriods(input.count, input.unit, now, timezone);
      case "LAST_N_COMPLETE_PERIODS":
        if (!input.count || !input.unit) {
          throw new Error("LAST_N_COMPLETE_PERIODS 缺少 count 或 unit");
        }
        return resolveCompletePeriods(input.count, input.unit, now, timezone);
      case "ABSOLUTE_RANGE":
        if (!input.start || !input.endExclusive || input.start >= input.endExclusive) {
          throw new Error("ABSOLUTE_RANGE 缺少有效的 start 或 endExclusive");
        }
        return {
          start: `${input.start} 00:00:00`,
          endExclusive: `${input.endExclusive} 00:00:00`,
          mode: "FULL_PERIOD",
        };
      case "NONE":
      case "CONTEXT_MONTH":
        throw new Error(`时间范围 ${input.kind} 不能进入查询编译阶段`);
    }
  }
  if (input.mode === "LAST_N_COMPLETE_PERIODS") {
    const count = input.count;
    const unit = input.unit;
    if (!Number.isInteger(count) || (count ?? 0) < 1 || (count ?? 0) > 366) {
      throw new Error("完整自然周期数量必须在 1 到 366 之间");
    }
    if (!unit) throw new Error("完整自然周期必须指定 DAY、WEEK、MONTH、QUARTER 或 YEAR");
    return resolveCompletePeriods(count!, unit, now, timezone);
  }
  if (/^(今年|本年)$/.test(text)) {
    return {
      start: dateText(year, 1, 1),
      endExclusive: dateText(year, month, day + 1),
      mode: "TO_DATE",
    };
  }
  if (text === "去年") {
    return {
      start: dateText(year - 1, 1, 1),
      endExclusive: dateText(year, 1, 1),
      mode: "FULL_PERIOD",
    };
  }
  if (/^(本月|这个月)$/.test(text)) {
    return {
      start: dateText(year, month, 1),
      endExclusive: dateText(year, month, day + 1),
      mode: "TO_DATE",
    };
  }
  if (text === "上月") {
    return {
      start: dateText(year, month - 1, 1),
      endExclusive: dateText(year, month, 1),
      mode: "FULL_PERIOD",
    };
  }
  if (/^(本周|这周|本星期)$/.test(text)) {
    const weekday = zonedWeekday(now, timezone);
    return {
      start: dateText(year, month, day - weekday),
      endExclusive: dateText(year, month, day + 1),
      mode: "TO_DATE",
    };
  }
  if (/^(上周|上星期)$/.test(text)) {
    const weekday = zonedWeekday(now, timezone);
    return {
      start: dateText(year, month, day - weekday - 7),
      endExclusive: dateText(year, month, day - weekday),
      mode: "FULL_PERIOD",
    };
  }
  if (/^(本季度|本季)$/.test(text)) {
    const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return {
      start: dateText(year, quarterMonth, 1),
      endExclusive: dateText(year, month, day + 1),
      mode: "TO_DATE",
    };
  }
  if (/^(上季度|上季)$/.test(text)) {
    const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return {
      start: dateText(year, quarterMonth - 3, 1),
      endExclusive: dateText(year, quarterMonth, 1),
      mode: "FULL_PERIOD",
    };
  }
  if (/^(今天|今日)$/.test(text)) {
    return {
      start: dateText(year, month, day),
      endExclusive: dateText(year, month, day + 1),
      mode: "TO_DATE",
    };
  }
  if (text === "昨天") {
    return {
      start: dateText(year, month, day - 1),
      endExclusive: dateText(year, month, day),
      mode: "FULL_PERIOD",
    };
  }
  const explicitYear = text.match(/^(\d{4})年$/);
  if (explicitYear) {
    const parsed = Number(explicitYear[1]);
    return {
      start: dateText(parsed, 1, 1),
      endExclusive: dateText(parsed + 1, 1, 1),
      mode: "FULL_PERIOD",
    };
  }
  const explicitMonth = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (explicitMonth) {
    const parsedYear = Number(explicitMonth[1]);
    const parsedMonth = Number(explicitMonth[2]);
    if (parsedMonth < 1 || parsedMonth > 12) {
      throw new Error(`时间表达式“${expression}”中的月份无效`);
    }
    return {
      start: dateText(parsedYear, parsedMonth, 1),
      endExclusive: dateText(parsedYear, parsedMonth + 1, 1),
      mode: "FULL_PERIOD",
    };
  }
  const anchoredMonth = text.match(/^(今年|本年|去年)(\d{1,2})月(?:份)?$/);
  if (anchoredMonth) {
    const parsedYear = anchoredMonth[1] === "去年" ? year - 1 : year;
    const parsedMonth = Number(anchoredMonth[2]);
    if (parsedMonth < 1 || parsedMonth > 12) {
      throw new Error(`时间表达式“${expression}”中的月份无效`);
    }
    return {
      start: dateText(parsedYear, parsedMonth, 1),
      endExclusive: dateText(parsedYear, parsedMonth + 1, 1),
      mode: "FULL_PERIOD",
    };
  }
  const recentDays = text.match(/^(?:近|最近)(\d{1,3})天$/);
  if (recentDays) {
    const count = Number(recentDays[1]);
    if (count < 1 || count > 366) throw new Error("最近天数必须在 1 到 366 之间");
    return {
      start: dateText(year, month, day - count + 1),
      endExclusive: dateText(year, month, day + 1),
      mode: "ROLLING",
    };
  }
  const recentMonths = text.match(/^(?:近|最近)(\d{1,2})个?月$/);
  if (recentMonths) {
    const count = Number(recentMonths[1]);
    if (count < 1 || count > 60) throw new Error("最近月数必须在 1 到 60 之间");
    return {
      start: dateText(year, month - count + 1, 1),
      endExclusive: dateText(year, month + 1, 1),
      mode: "ROLLING",
    };
  }
  const recentYears = text.match(
    /^(?:近|最近|过去)(\d{1,2}|[一二三四五六七八九十两]+)个?年$/,
  );
  if (recentYears) {
    const count = parseNaturalCount(recentYears[1]!);
    if (count < 1 || count > 20) throw new Error("最近年数必须在 1 到 20 之间");
    return resolveCompletePeriods(count, "YEAR", now, timezone);
  }
  const completePeriods = text.match(
    /^(?:近|最近|过去)(\d{1,3}|[一二三四五六七八九十两]+)个?(完整|自然)(天|周|月|季度|年)$/,
  );
  if (completePeriods) {
    const count = parseNaturalCount(completePeriods[1]!);
    const unit = {
      天: "DAY",
      周: "WEEK",
      月: "MONTH",
      季度: "QUARTER",
      年: "YEAR",
    }[completePeriods[3]!] as TimeGrain;
    return resolveCompletePeriods(count, unit, now, timezone);
  }
  throw new Error(
    `暂不支持时间表达式“${expression}”，请使用今天、昨天、本周、上周、本月、上月、本季度、上季度、今年、去年、近N天、近N个月、近N年、近N个完整周期或明确年月`,
  );
}

function parseNaturalCount(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  const [tensText, onesText] = value.split("十");
  if (value.includes("十")) {
    const tens = tensText ? digits[tensText] ?? 0 : 1;
    const ones = onesText ? digits[onesText] ?? 0 : 0;
    return tens * 10 + ones;
  }
  return digits[value] ?? Number.NaN;
}

function resolveRollingPeriods(
  count: number | undefined,
  unit: TimeGrain | undefined,
  now: Date,
  timezone: string,
): {
  start: string;
  endExclusive: string;
  mode: "ROLLING";
  periodCount: number;
  periodUnit: TimeGrain;
} {
  if (!count || !Number.isInteger(count) || count < 1 || count > 366 || !unit) {
    throw new Error("滚动时间范围必须提供 1 到 366 的 count 和有效 unit");
  }
  const { year, month, day } = zonedDateParts(now, timezone);
  const endExclusive = dateText(year, month, day + 1);
  if (unit === "YEAR") {
    return {
      start: dateText(year - count + 1, 1, 1),
      endExclusive,
      mode: "ROLLING",
      periodCount: count,
      periodUnit: unit,
    };
  }
  if (unit === "QUARTER") {
    const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return {
      start: dateText(year, quarterMonth - (count - 1) * 3, 1),
      endExclusive,
      mode: "ROLLING",
      periodCount: count,
      periodUnit: unit,
    };
  }
  if (unit === "MONTH") {
    return {
      start: dateText(year, month - count + 1, 1),
      endExclusive,
      mode: "ROLLING",
      periodCount: count,
      periodUnit: unit,
    };
  }
  const days = unit === "WEEK" ? count * 7 : count;
  return {
    start: dateText(year, month, day - days + 1),
    endExclusive,
    mode: "ROLLING",
    periodCount: count,
    periodUnit: unit,
  };
}

function resolveCompletePeriods(
  count: number,
  unit: TimeGrain,
  now: Date,
  timezone: string,
): {
  start: string;
  endExclusive: string;
  mode: "COMPLETE_PERIODS";
  periodCount: number;
  periodUnit: TimeGrain;
} {
  const { year, month, day } = zonedDateParts(now, timezone);
  if (!Number.isInteger(count) || count < 1 || count > 366) {
    throw new Error("完整自然周期数量必须在 1 到 366 之间");
  }
  if (unit === "YEAR") {
    return {
      start: dateText(year - count, 1, 1),
      endExclusive: dateText(year, 1, 1),
      mode: "COMPLETE_PERIODS",
      periodCount: count,
      periodUnit: unit,
    };
  }
  if (unit === "QUARTER") {
    const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return {
      start: dateText(year, quarterMonth - count * 3, 1),
      endExclusive: dateText(year, quarterMonth, 1),
      mode: "COMPLETE_PERIODS",
      periodCount: count,
      periodUnit: unit,
    };
  }
  if (unit === "MONTH") {
    return {
      start: dateText(year, month - count, 1),
      endExclusive: dateText(year, month, 1),
      mode: "COMPLETE_PERIODS",
      periodCount: count,
      periodUnit: unit,
    };
  }
  const weekday = zonedWeekday(now, timezone);
  if (unit === "WEEK") {
    return {
      start: dateText(year, month, day - weekday - count * 7),
      endExclusive: dateText(year, month, day - weekday),
      mode: "COMPLETE_PERIODS",
      periodCount: count,
      periodUnit: unit,
    };
  }
  return {
    start: dateText(year, month, day - count),
    endExclusive: dateText(year, month, day),
    mode: "COMPLETE_PERIODS",
    periodCount: count,
    periodUnit: unit,
  };
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

function zonedWeekday(value: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(value);
  const sundayBased = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    weekday,
  );
  return sundayBased <= 0 ? 6 : sundayBased - 1;
}

function qualifiedColumn(alias: string, property: OntologyProperty): string {
  return `${alias}.${quoteIdentifier(property.sourceColumn)}`;
}

function compileDisplayDimensionExpression(
  display: { object: OntologyObject; property: OntologyProperty },
  fallback: { object: OntologyObject; property: OntologyProperty } | undefined,
  aliases: Map<string, string>,
): string {
  const displayColumn = qualifiedColumn(
    aliases.get(display.object.id)!,
    display.property,
  );
  if (!fallback) return displayColumn;
  const fallbackColumn = qualifiedColumn(
    aliases.get(fallback.object.id)!,
    fallback.property,
  );
  return `COALESCE(NULLIF(${displayColumn}, ''), CAST(${fallbackColumn} AS STRING))`;
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

function formatValue(value: string | string[] | number | undefined): string {
  return Array.isArray(value) ? value.join("、") : String(value ?? "未提供");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
