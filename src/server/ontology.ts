import { z } from "zod";
import type {
  Metric,
  OntologyObject,
  OntologyRelation,
  OntologySnapshot,
  OntologyValidationIssue,
  OntologyValidationResult,
  PhysicalTable,
} from "../shared/types.js";
import { createId } from "./id.js";

const entityStatusSchema = z.enum(["DRAFT", "VERIFIED", "PUBLISHED", "DEPRECATED"]);
const propertyMeaningSchema = z.enum([
  "ID",
  "CODE",
  "NAME",
  "ENTITY_REFERENCE",
  "CATEGORY",
  "TIME",
  "NUMBER",
  "BOOLEAN",
  "GEOGRAPHY",
  "TEXT",
]);
const propertySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  dataType: z.string().min(1).max(120),
  sourceColumn: z.string().min(1).max(200),
  sensitive: z.boolean(),
  meaning: propertyMeaningSchema,
  unique: z.boolean(),
  valueSearchable: z.boolean(),
  numericSpec: z
    .object({
      kind: z.enum(["GENERAL", "CURRENCY", "RATIO"]),
      unit: z.string().max(50).optional(),
      currency: z.string().max(12).optional(),
      defaultAggregation: z.enum(["SUM", "AVG", "MIN", "MAX", "NONE"]),
      aggregationBehavior: z.enum([
        "ADDITIVE",
        "SEMI_ADDITIVE",
        "NON_ADDITIVE",
      ]),
    })
    .optional(),
  visibility: z.enum(["ANALYTICAL", "DETAIL_ONLY", "HIDDEN"]),
  synonyms: z.array(z.string().trim().min(1).max(120)).max(50),
  format: z.string().max(120).optional(),
  detailOrder: z.number().int().min(1).max(10_000).optional(),
  defaultDisplay: z.boolean(),
  exportable: z.boolean(),
  nullDisplay: z.string().max(120).optional(),
  bindingPriority: z.number().int().min(0).max(100),
});

const objectSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(4_000),
  sourceTableId: z.string().min(1),
  status: entityStatusSchema,
  objectType: z.enum([
    "ENTITY",
    "EVENT",
    "SNAPSHOT",
    "AGGREGATE",
    "RELATIONSHIP",
  ]),
  grainPropertyIds: z.array(z.string().min(1)).max(200),
  grain: z.string().max(1_000),
  identityReviewRequired: z.boolean().optional(),
  defaultTimePropertyId: z.string().min(1).optional(),
  defaultFilter: z.string().max(4_000).optional(),
  category: z.string().max(120).optional(),
  owner: z.string().max(120).optional(),
  exampleQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
  properties: z.array(propertySchema).max(2_000),
  synonyms: z.array(z.string().trim().min(1).max(120)).max(50),
  bindingPriority: z.number().int().min(0).max(100),
});

const metricSchema = z.object({
  id: z.string().min(1),
  metricType: z.enum(["BASE", "DERIVED"]).optional(),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(4_000),
  objectId: z.string().min(1),
  expression: z.string().max(8_000),
  definitionMode: z.enum(["VISUAL", "SQL"]),
  sourcePropertyId: z.string().min(1).optional(),
  filterExpression: z.string().max(4_000).optional(),
  timePropertyId: z.string().min(1).optional(),
  leftMetricId: z.string().min(1).optional(),
  rightMetricId: z.string().min(1).optional(),
  calculationOperator: z
    .enum(["ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "RATIO"])
    .optional(),
  scale: z.number().positive().max(1_000_000).optional(),
  aggregation: z.enum([
    "SUM",
    "COUNT",
    "COUNT_DISTINCT",
    "AVG",
    "MIN",
    "MAX",
    "CUSTOM",
  ]),
  format: z.enum(["currency", "number", "percent"]),
  unit: z.string().max(50).optional(),
  synonyms: z.array(z.string().trim().min(1).max(120)).max(50),
  status: entityStatusSchema,
});

export const metricEditSchema = z.object({
  metric: metricSchema,
});

const relationSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  sourceObjectId: z.string().min(1),
  targetObjectId: z.string().min(1),
  type: z.enum([
    "REFERENCE",
    "COMPOSITION",
    "ASSOCIATION",
    "HIERARCHY",
    "EVENT_PARTICIPATION",
    "IDENTITY",
    "DERIVED",
  ]),
  cardinality: z.enum([
    "ONE_TO_ONE",
    "ONE_TO_MANY",
    "MANY_TO_ONE",
    "MANY_TO_MANY",
  ]),
  joinExpression: z.string().trim().min(1).max(4_000),
  sourcePropertyId: z.string().min(1).optional(),
  targetPropertyId: z.string().min(1).optional(),
  direction: z.enum(["BIDIRECTIONAL", "SOURCE_TO_TARGET", "TARGET_TO_SOURCE"]),
  required: z.boolean(),
  enabled: z.boolean(),
  fanoutRisk: z.enum(["NONE", "LOW", "HIGH"]),
  status: entityStatusSchema,
});

export const objectEditSchema = z.object({
  object: objectSchema,
  metrics: z.array(metricSchema).max(500),
  relations: z.array(relationSchema).max(500),
});

export type ObjectEditInput = z.infer<typeof objectEditSchema>;

export function createDraftFromPublished(
  published: OntologySnapshot,
): OntologySnapshot {
  const draft = structuredClone(published);
  return {
    ...draft,
    version: published.version + 1,
    baseVersion: published.version,
    status: "DRAFT",
    publishedAt: undefined,
    objects: draft.objects.map((object) => ({ ...object, status: "DRAFT" })),
    relations: draft.relations.map((relation) => ({
      ...relation,
      status: "DRAFT",
    })),
    metrics: draft.metrics.map((metric) => ({ ...metric, status: "DRAFT" })),
  };
}

export function addTablesToDraft(
  draft: OntologySnapshot,
  selected: PhysicalTable[],
): OntologySnapshot {
  const next = structuredClone(draft);
  return {
    ...next,
    objects: [
      ...next.objects,
      ...selected.map<OntologyObject>((table) => {
        const objectType = inferObjectType(table.name, table.description);
        const normalizedObjectName = table.name
          .replace(/^(dim|fact|agg)_/, "")
          .replace(/s$/, "");
        const properties: OntologyObject["properties"] = table.columns.map(
          (column, index) => ({
            id: createId("property"),
            name: column.name,
            label: column.comment || column.name,
            description: column.comment || "",
            dataType: column.dataType,
            sourceColumn: column.name,
            sensitive: column.sensitive,
            meaning: inferPropertyMeaning(column.name, column.dataType),
            unique: false,
            valueSearchable:
              !column.sensitive &&
              defaultValueSearchable(inferPropertyMeaning(column.name, column.dataType)),
            numericSpec: inferPropertyMeaning(column.name, column.dataType) === "NUMBER"
              ? inferNumericSpec(column.name)
              : undefined,
            visibility: column.sensitive ? "HIDDEN" : "ANALYTICAL",
            synonyms: [],
            detailOrder: index + 1,
            defaultDisplay: true,
            exportable: !column.sensitive,
            bindingPriority: 50,
          }),
        );
        const primaryCandidate = properties.find(
          (property) =>
            property.name === "id" ||
            property.name === `${normalizedObjectName}_id`,
        );
        if (
          primaryCandidate &&
          (objectType === "ENTITY" || objectType === "EVENT")
        ) {
          primaryCandidate.meaning = "ID";
          primaryCandidate.unique = true;
          primaryCandidate.valueSearchable = false;
        }
        return {
          id: createId("object"),
          name: table.name.replace(/^(dim|fact)_/, "").replace(/s$/, ""),
          label: table.description?.replace(/表$/, "") || table.name,
          description: `基于 ${table.database}.${table.name} 生成的本体草稿`,
          sourceTableId: table.id,
          status: "DRAFT",
          objectType,
          grainPropertyIds: primaryCandidate ? [primaryCandidate.id] : [],
          grain: primaryCandidate
            ? `一行代表一个${table.description?.replace(/表$/, "") || normalizedObjectName}`
            : "",
          defaultTimePropertyId: properties.find(
            (property) => property.meaning === "TIME",
          )?.id,
          exampleQuestions: [],
          synonyms: [],
          bindingPriority: 50,
          properties,
        };
      }),
    ],
  };
}

export function applyObjectEdit(
  draft: OntologySnapshot,
  objectId: string,
  input: ObjectEditInput,
): OntologySnapshot {
  const existing = draft.objects.find((object) => object.id === objectId);
  if (!existing) throw new Error("草稿对象不存在");
  if (input.object.id !== objectId) throw new Error("对象标识与请求路径不一致");
  if (input.object.sourceTableId !== existing.sourceTableId) {
    throw new Error("不能在对象编辑器中修改来源表");
  }
  const existingProperties = new Map(
    existing.properties.map((property) => [property.id, property]),
  );
  if (
    input.object.properties.length !== existing.properties.length ||
    input.object.properties.some((property) => {
      const original = existingProperties.get(property.id);
      return (
        !original ||
        original.sourceColumn !== property.sourceColumn ||
        original.dataType !== property.dataType
      );
    })
  ) {
    throw new Error("属性必须保持与已扫描 Schema 的物理字段一致");
  }
  if (
    input.relations.some(
      (relation) =>
        relation.sourceObjectId !== objectId &&
        relation.targetObjectId !== objectId,
    )
  ) {
    throw new Error("关系必须包含当前对象");
  }

  const otherRelations = draft.relations.filter(
    (relation) =>
      relation.sourceObjectId !== objectId && relation.targetObjectId !== objectId,
  );
  return {
    ...draft,
    objects: draft.objects.map((object) =>
      object.id === objectId
        ? {
            ...input.object,
            status: "DRAFT",
            properties: input.object.properties.map((property) => ({ ...property })),
          }
        : object,
    ),
    metrics: draft.metrics,
    relations: [
      ...otherRelations,
      ...deduplicateById(
        input.relations.map((relation) => ({
          ...relation,
          status: "DRAFT" as const,
          fanoutRisk:
            relation.cardinality === "MANY_TO_MANY"
              ? ("HIGH" as const)
              : relation.cardinality === "ONE_TO_MANY"
                ? ("LOW" as const)
                : ("NONE" as const),
        })),
      ),
    ],
  };
}

export function upsertMetricInDraft(
  draft: OntologySnapshot,
  metric: Metric,
): OntologySnapshot {
  if (!draft.objects.some((object) => object.id === metric.objectId)) {
    throw new Error("指标的分析对象不存在");
  }
  const normalized = {
    ...metric,
    metricType: metric.metricType ?? "BASE",
    status: "DRAFT" as const,
  };
  return {
    ...draft,
    metrics: draft.metrics.some((candidate) => candidate.id === metric.id)
      ? draft.metrics.map((candidate) =>
          candidate.id === metric.id ? normalized : candidate,
        )
      : [...draft.metrics, normalized],
  };
}

export function removeMetricFromDraft(
  draft: OntologySnapshot,
  metricId: string,
): OntologySnapshot {
  const metric = draft.metrics.find((candidate) => candidate.id === metricId);
  if (!metric) throw new Error("指标不存在");
  const dependents = draft.metrics.filter(
    (candidate) =>
      candidate.metricType === "DERIVED" &&
      (candidate.leftMetricId === metricId ||
        candidate.rightMetricId === metricId),
  );
  if (dependents.length) {
    throw new Error(
      `指标 ${metric.label} 正被 ${dependents.map((candidate) => candidate.label).join("、")} 引用，不能删除`,
    );
  }
  return {
    ...draft,
    metrics: draft.metrics.filter((candidate) => candidate.id !== metricId),
  };
}

export function removeObjectFromDraft(
  draft: OntologySnapshot,
  objectId: string,
): { ontology: OntologySnapshot; sourceTableId: string } {
  const next = structuredClone(draft);
  const object = next.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Error("草稿对象不存在");
  return {
    sourceTableId: object.sourceTableId,
    ontology: {
      ...next,
      objects: next.objects.filter((candidate) => candidate.id !== objectId),
      metrics: next.metrics.filter((metric) => metric.objectId !== objectId),
      relations: next.relations.filter(
        (relation) =>
          relation.sourceObjectId !== objectId &&
          relation.targetObjectId !== objectId,
      ),
    },
  };
}

export function validateOntology(
  snapshot: OntologySnapshot,
  tables: PhysicalTable[],
): OntologyValidationResult {
  const issues: OntologyValidationIssue[] = [];
  const tableIds = new Set(tables.map((table) => table.id));
  const objectIds = new Set(snapshot.objects.map((object) => object.id));
  const objectNames = new Set<string>();

  for (const object of snapshot.objects) {
    if (!object.label.trim() || !object.name.trim()) {
      issues.push(error("OBJECT_NAME_REQUIRED", "对象名称和标识不能为空", object.id));
    }
    if (objectNames.has(object.name.toLowerCase())) {
      issues.push(error("OBJECT_NAME_DUPLICATE", `对象标识 ${object.name} 重复`, object.id));
    }
    objectNames.add(object.name.toLowerCase());
    if (!tableIds.has(object.sourceTableId)) {
      issues.push(error("SOURCE_TABLE_MISSING", "对象来源表已不存在", object.id));
    }
    const propertyIds = new Set(object.properties.map((property) => property.id));
    const idProperties = object.properties.filter(
      (property) => property.meaning === "ID",
    );
    if (object.identityReviewRequired) {
      issues.push(
        error(
          "IDENTITY_REVIEW_REQUIRED",
          `${object.label} 从旧版本迁移出多个对象标识，请重新确认唯一 ID`,
          object.id,
        ),
      );
    }
    if (object.objectType === "ENTITY" && idProperties.length !== 1) {
      issues.push(
        error(
          idProperties.length ? "OBJECT_ID_MULTIPLE" : "OBJECT_ID_REQUIRED",
          idProperties.length
            ? `${object.label} 是业务实体，只能配置一个 ID`
            : `${object.label} 是业务实体，必须配置一个 ID`,
          object.id,
        ),
      );
    }
    if (object.objectType === "EVENT" && idProperties.length > 1) {
      issues.push(
        error(
          "OBJECT_ID_MULTIPLE",
          `${object.label} 最多只能配置一个 ID`,
          object.id,
        ),
      );
    }
    if (
      ["SNAPSHOT", "AGGREGATE", "RELATIONSHIP"].includes(object.objectType) &&
      idProperties.length
    ) {
      issues.push(
        error(
          "OBJECT_ID_NOT_ALLOWED",
          `${object.label} 的对象类型不使用 ID，请通过行级粒度定义一行数据`,
          object.id,
        ),
      );
    }
    const effectiveGrainIds = idProperties.length === 1
      ? [idProperties[0].id]
      : object.grainPropertyIds;
    if (!effectiveGrainIds.length) {
      issues.push(
        error(
          "GRAIN_REQUIRED",
          `${object.label} 没有唯一 ID，请选择“一行数据由哪些字段共同确定”`,
          object.id,
        ),
      );
    }
    for (const grainPropertyId of effectiveGrainIds) {
      const grainProperty = object.properties.find(
        (property) => property.id === grainPropertyId,
      );
      if (!grainProperty) {
        issues.push(
          error(
            "GRAIN_PROPERTY_INVALID",
            `${object.label} 的行级粒度引用了不存在的属性`,
            object.id,
            grainPropertyId,
          ),
        );
      } else if (grainProperty.visibility !== "ANALYTICAL") {
        issues.push(
          error(
            "GRAIN_PROPERTY_NOT_ANALYTICAL",
            `粒度字段 ${grainProperty.label} 必须设为分析可用`,
            object.id,
            grainProperty.id,
          ),
        );
      }
    }
    if (
      object.defaultTimePropertyId &&
      !object.properties.some(
        (property) =>
          property.id === object.defaultTimePropertyId &&
          property.meaning === "TIME",
      )
    ) {
      issues.push(
        error(
          "TIME_PROPERTY_INVALID",
          "默认时间字段不存在或字段含义不是时间",
          object.id,
        ),
      );
    }
    if (containsUnsafeExpression(object.defaultFilter)) {
      issues.push(error("FILTER_UNSAFE", "默认过滤条件包含不允许的 SQL", object.id));
    }
    const propertyNames = new Set<string>();
    for (const property of object.properties) {
      if (propertyNames.has(property.name.toLowerCase())) {
        issues.push(
          error("PROPERTY_NAME_DUPLICATE", `属性标识 ${property.name} 重复`, object.id, property.id),
        );
      }
      propertyNames.add(property.name.toLowerCase());
      if (
        (property.meaning === "ID" ||
          property.meaning === "ENTITY_REFERENCE") &&
        property.visibility !== "ANALYTICAL"
      ) {
        issues.push(
          error(
            "STRUCTURAL_PROPERTY_NOT_ANALYTICAL",
            `${property.label} 用于对象身份或关系，必须设为分析可用`,
            object.id,
            property.id,
          ),
        );
      }
      if (
        property.meaning === "ENTITY_REFERENCE" &&
        !snapshot.relations.some(
          (relation) =>
            relation.sourceObjectId === object.id &&
            relation.sourcePropertyId === property.id,
        )
      ) {
        issues.push(
          error(
            "ENTITY_REFERENCE_RELATION_REQUIRED",
            `${property.label} 是关联实体，请配置它指向的目标对象`,
            object.id,
            property.id,
          ),
        );
      }
      if (property.meaning === "ID" && !property.unique) {
        issues.push(
          error(
            "OBJECT_ID_NOT_UNIQUE",
            `${property.label} 是当前对象 ID，必须标记为唯一`,
            object.id,
            property.id,
          ),
        );
      }
      if (property.meaning === "NUMBER" && !property.numericSpec) {
        issues.push(
          error(
            "NUMBER_RULE_REQUIRED",
            `数字属性 ${property.label} 缺少聚合规则`,
            object.id,
            property.id,
          ),
        );
      }
      if (
        property.meaning === "NUMBER" &&
        property.numericSpec?.defaultAggregation === "SUM" &&
        (property.numericSpec.kind === "RATIO" ||
          property.numericSpec.aggregationBehavior === "NON_ADDITIVE")
      ) {
        issues.push(
          error(
            "NUMBER_DEFAULT_SUM_NOT_ALLOWED",
            `${property.label} 是比例或不可加数字，默认聚合不能设为 SUM`,
            object.id,
            property.id,
          ),
        );
      }
      if (
        property.valueSearchable &&
        (property.sensitive ||
          property.visibility !== "ANALYTICAL" ||
          !isValueSearchableMeaning(property.meaning))
      ) {
        issues.push(
          error(
            "VALUE_SEARCH_NOT_ALLOWED",
            `${property.label} 当前不可启用属性值定位`,
            object.id,
            property.id,
          ),
        );
      }
    }
    if (object.objectType === "RELATIONSHIP") {
      const referenceCount = object.properties.filter(
        (property) => property.meaning === "ENTITY_REFERENCE",
      ).length;
      if (referenceCount < 2) {
        issues.push(
          error(
            "RELATIONSHIP_ENDPOINTS_REQUIRED",
            `${object.label} 是关联记录，至少需要两个关联实体字段`,
            object.id,
          ),
        );
      }
    }
  }

  for (const metric of snapshot.metrics) {
    const object = snapshot.objects.find((item) => item.id === metric.objectId);
    if (!object) {
      issues.push(error("METRIC_OBJECT_MISSING", "指标所属对象不存在", undefined, metric.id));
      continue;
    }
    if (metric.metricType === "DERIVED") {
      const left = snapshot.metrics.find(
        (candidate) => candidate.id === metric.leftMetricId,
      );
      const right = snapshot.metrics.find(
        (candidate) => candidate.id === metric.rightMetricId,
      );
      if (!metric.leftMetricId || !metric.rightMetricId || !metric.calculationOperator) {
        issues.push(
          error(
            "DERIVED_METRIC_DEFINITION_REQUIRED",
            `复合指标 ${metric.label} 缺少左右指标或运算方式`,
            object.id,
            metric.id,
          ),
        );
        continue;
      }
      if (metric.leftMetricId === metric.rightMetricId) {
        issues.push(
          error(
            "DERIVED_METRIC_DUPLICATE_OPERAND",
            `复合指标 ${metric.label} 的左右指标不能相同`,
            object.id,
            metric.id,
          ),
        );
      }
      if (!left || !right) {
        issues.push(
          error(
            "DERIVED_METRIC_REFERENCE_MISSING",
            `复合指标 ${metric.label} 引用了不存在的指标`,
            object.id,
            metric.id,
          ),
        );
        continue;
      }
      if (left.objectId !== object.id || right.objectId !== object.id) {
        issues.push(
          error(
            "DERIVED_METRIC_CROSS_OBJECT",
            `复合指标 ${metric.label} 的依赖指标必须来自同一个事实对象`,
            object.id,
            metric.id,
          ),
        );
      }
      continue;
    }
    if (metric.definitionMode === "SQL" && !metric.expression.trim()) {
      issues.push(
        error(
          "METRIC_EXPRESSION_REQUIRED",
          `指标 ${metric.label} 缺少 SQL 表达式`,
          object.id,
          metric.id,
        ),
      );
    }
    if (containsUnsafeExpression(metric.expression)) {
      issues.push(error("METRIC_SQL_UNSAFE", `指标 ${metric.label} 表达式不安全`, object.id, metric.id));
    }
    const nonAnalyticalReference = findNonAnalyticalReference(
      [metric.expression, metric.filterExpression].filter(Boolean).join(" "),
      object,
    );
    if (nonAnalyticalReference) {
      issues.push(
        error(
          "METRIC_PROPERTY_NOT_ANALYTICAL",
          `指标 ${metric.label} 引用了不可发送给 Montane 的属性 ${nonAnalyticalReference.label}`,
          object.id,
          metric.id,
        ),
      );
    }
    if (
      metric.definitionMode === "VISUAL" &&
      metric.aggregation !== "COUNT" &&
      !metric.sourcePropertyId
    ) {
      issues.push(error("METRIC_SOURCE_REQUIRED", `指标 ${metric.label} 缺少计算字段`, object.id, metric.id));
    }
    if (
      metric.sourcePropertyId &&
      object.properties.find((property) => property.id === metric.sourcePropertyId)
        ?.visibility !== "ANALYTICAL"
    ) {
      issues.push(
        error(
          "METRIC_SOURCE_NOT_ANALYTICAL",
          `指标 ${metric.label} 的计算字段必须设为分析可用`,
          object.id,
          metric.id,
        ),
      );
    }
    const metricProperty = object.properties.find(
      (property) => property.id === metric.sourcePropertyId,
    );
    if (
      metric.definitionMode === "VISUAL" &&
      metric.aggregation !== "COUNT" &&
      metricProperty &&
      metricProperty.meaning !== "NUMBER"
    ) {
      issues.push(
        error(
          "METRIC_SOURCE_NOT_NUMBER",
          `指标 ${metric.label} 的计算字段 ${metricProperty.label} 不是数字`,
          object.id,
          metric.id,
        ),
      );
    }
    if (
      metric.definitionMode === "VISUAL" &&
      metricProperty?.meaning === "NUMBER" &&
      metric.aggregation === "SUM" &&
      (metricProperty.numericSpec?.kind === "RATIO" ||
        metricProperty.numericSpec?.aggregationBehavior === "NON_ADDITIVE")
    ) {
      issues.push(
        error(
          "NUMBER_SUM_NOT_ALLOWED",
          `${metricProperty.label} 不允许直接求和，请调整数字聚合规则或指标公式`,
          object.id,
          metric.id,
        ),
      );
    }
  }
  validateMetricDependencyGraph(snapshot, issues);

  for (const relation of snapshot.relations) {
    const source = snapshot.objects.find((object) => object.id === relation.sourceObjectId);
    const target = snapshot.objects.find((object) => object.id === relation.targetObjectId);
    if (!source || !target || !objectIds.has(source.id) || !objectIds.has(target.id)) {
      issues.push(error("RELATION_OBJECT_MISSING", `关系 ${relation.name} 引用了不存在的对象`, undefined, relation.id));
      continue;
    }
    if (
      !relation.sourcePropertyId ||
      !source.properties.some((property) => property.id === relation.sourcePropertyId) ||
      !relation.targetPropertyId ||
      !target.properties.some((property) => property.id === relation.targetPropertyId)
    ) {
      issues.push(error("RELATION_KEY_REQUIRED", `关系 ${relation.name} 缺少有效关联字段`, source.id, relation.id));
    }
    const sourceProperty = source.properties.find(
      (property) => property.id === relation.sourcePropertyId,
    );
    const targetProperty = target.properties.find(
      (property) => property.id === relation.targetPropertyId,
    );
    if (
      sourceProperty &&
      !["HIERARCHY", "IDENTITY"].includes(relation.type) &&
      sourceProperty.meaning !== "ENTITY_REFERENCE"
    ) {
      issues.push(
        error(
          "RELATION_SOURCE_NOT_REFERENCE",
          `关系 ${relation.name} 的源字段 ${sourceProperty.label} 必须设为关联实体`,
          source.id,
          relation.id,
        ),
      );
    }
    if (targetProperty && targetProperty.meaning !== "ID") {
      issues.push(
        error(
          "RELATION_TARGET_NOT_ID",
          `关系 ${relation.name} 必须关联到目标对象的 ID`,
          target.id,
          relation.id,
        ),
      );
    }
    if (
      (sourceProperty && sourceProperty.visibility !== "ANALYTICAL") ||
      (targetProperty && targetProperty.visibility !== "ANALYTICAL")
    ) {
      issues.push(
        error(
          "RELATION_KEY_NOT_ANALYTICAL",
          `关系 ${relation.name} 的关联字段必须设为分析可用`,
          source.id,
          relation.id,
        ),
      );
    }
    const hiddenJoinProperty =
      findNonAnalyticalReference(relation.joinExpression, source) ??
      findNonAnalyticalReference(relation.joinExpression, target);
    if (hiddenJoinProperty) {
      issues.push(
        error(
          "RELATION_PROPERTY_NOT_ANALYTICAL",
          `关系 ${relation.name} 引用了不可发送给 Montane 的属性 ${hiddenJoinProperty.label}`,
          source.id,
          relation.id,
        ),
      );
    }
    if (containsUnsafeExpression(relation.joinExpression)) {
      issues.push(error("RELATION_SQL_UNSAFE", `关系 ${relation.name} 连接表达式不安全`, source.id, relation.id));
    }
    if (relation.cardinality === "MANY_TO_MANY") {
      issues.push({
        level: "WARNING",
        code: "RELATION_FANOUT",
        message: `关系 ${relation.name} 为多对多，查询时存在指标重复计算风险`,
        objectId: source.id,
        entityId: relation.id,
      });
    }
  }
  return { valid: !issues.some((issue) => issue.level === "ERROR"), issues };
}

export function publishDraft(draft: OntologySnapshot): OntologySnapshot {
  const published = structuredClone(draft);
  return {
    ...published,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
    objects: published.objects.map((object) => ({ ...object, status: "PUBLISHED" })),
    relations: published.relations.map((relation) => ({
      ...relation,
      status: "PUBLISHED",
    })),
    metrics: published.metrics.map((metric) => ({ ...metric, status: "PUBLISHED" })),
  };
}

export function metricExpression(
  metric: Pick<Metric, "definitionMode" | "aggregation" | "sourcePropertyId" | "filterExpression">,
  object: OntologyObject,
): string {
  if (metric.definitionMode !== "VISUAL") return "";
  const property = object.properties.find(
    (candidate) => candidate.id === metric.sourcePropertyId,
  );
  const inner =
    metric.aggregation === "COUNT"
      ? "*"
      : property
        ? quoteIdentifier(property.sourceColumn)
        : "";
  const filter = metric.filterExpression?.trim();
  if (filter) {
    if (metric.aggregation === "COUNT") {
      return `COUNT(CASE WHEN ${filter} THEN 1 END)`;
    }
    if (metric.aggregation === "COUNT_DISTINCT") {
      return `COUNT(DISTINCT CASE WHEN ${filter} THEN ${inner} END)`;
    }
    return `${metric.aggregation}(CASE WHEN ${filter} THEN ${inner} END)`;
  }
  const aggregate =
    metric.aggregation === "COUNT_DISTINCT"
      ? `COUNT(DISTINCT ${inner})`
      : `${metric.aggregation}(${inner})`;
  return aggregate;
}

function inferPropertyMeaning(
  name: string,
  dataType: string,
): OntologyObject["properties"][number]["meaning"] {
  const normalized = name.toLowerCase();
  if (/(^id$|_id$|code$|number$|_no$)/.test(normalized)) return "CODE";
  if (/(name|title|label|名称|姓名)/.test(normalized)) return "NAME";
  if (/(status|type|category|level|class|状态|类型|等级|分类)/.test(normalized)) {
    return "CATEGORY";
  }
  if (/(date|time|_at$)/.test(normalized) || /(date|time)/i.test(dataType)) return "TIME";
  if (/^(is_|has_)/.test(normalized) || /bool/i.test(dataType)) return "BOOLEAN";
  if (isNumericDataType(dataType)) return "NUMBER";
  if (/(province|city|district|region|country|longitude|latitude|省|市|区|区域)/.test(normalized)) {
    return "GEOGRAPHY";
  }
  return "TEXT";
}

function inferObjectType(name: string, description?: string): OntologyObject["objectType"] {
  const normalized = `${name} ${description ?? ""}`.toLowerCase();
  if (/(snapshot|快照|balance)/.test(normalized)) return "SNAPSHOT";
  if (/(^|_)(agg|summary|stat|report)(_|$)|汇总|统计/.test(normalized)) {
    return "AGGREGATE";
  }
  if (/(^|_)(bridge|mapping|relation|link)(_|$)|关联/.test(normalized)) {
    return "RELATIONSHIP";
  }
  if (/(^|_)(fact|event|order|payment|transaction|detail|log)(_|$)|订单|支付|交易|明细|事件/.test(normalized)) {
    return "EVENT";
  }
  return "ENTITY";
}

function inferNumericSpec(name: string): NonNullable<
  OntologyObject["properties"][number]["numericSpec"]
> {
  const normalized = name.toLowerCase();
  if (/(amount|price|fee|cost|revenue|income|gmv|金额|价格|费用|收入)/.test(normalized)) {
    const nonAdditive = /(price|单价)/.test(normalized);
    return {
      kind: "CURRENCY",
      currency: "CNY",
      defaultAggregation: nonAdditive ? "AVG" : "SUM",
      aggregationBehavior: nonAdditive ? "NON_ADDITIVE" : "ADDITIVE",
    };
  }
  if (/(rate|ratio|percent|pct|率|比例|占比)/.test(normalized)) {
    return {
      kind: "RATIO",
      unit: "%",
      defaultAggregation: "AVG",
      aggregationBehavior: "NON_ADDITIVE",
    };
  }
  const additive = /(count|quantity|qty|num|数量|件数|次数)/.test(normalized);
  return {
    kind: "GENERAL",
    defaultAggregation: additive ? "SUM" : "NONE",
    aggregationBehavior: additive ? "ADDITIVE" : "NON_ADDITIVE",
  };
}

function defaultValueSearchable(
  meaning: OntologyObject["properties"][number]["meaning"],
): boolean {
  return isValueSearchableMeaning(meaning);
}

function isValueSearchableMeaning(
  meaning: OntologyObject["properties"][number]["meaning"],
): boolean {
  return ["CODE", "NAME", "CATEGORY", "BOOLEAN", "GEOGRAPHY"].includes(meaning);
}

function isNumericDataType(dataType: string): boolean {
  return /int|decimal|numeric|float|double|real/i.test(dataType);
}

function containsUnsafeExpression(value?: string): boolean {
  if (!value?.trim()) return false;
  return /;|--|\/\*|\b(insert|update|delete|drop|alter|truncate|grant|revoke|call)\b/i.test(
    value,
  );
}

function validateMetricDependencyGraph(
  snapshot: OntologySnapshot,
  issues: OntologyValidationIssue[],
): void {
  const metricById = new Map(
    snapshot.metrics.map((metric) => [metric.id, metric]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (metric: Metric): void => {
    if (visited.has(metric.id) || metric.metricType !== "DERIVED") return;
    if (visiting.has(metric.id)) {
      issues.push(
        error(
          "DERIVED_METRIC_CYCLE",
          `复合指标 ${metric.label} 存在循环依赖`,
          metric.objectId,
          metric.id,
        ),
      );
      return;
    }
    visiting.add(metric.id);
    for (const dependencyId of [metric.leftMetricId, metric.rightMetricId]) {
      const dependency = dependencyId
        ? metricById.get(dependencyId)
        : undefined;
      if (dependency) visit(dependency);
    }
    visiting.delete(metric.id);
    visited.add(metric.id);
  };
  for (const metric of snapshot.metrics) visit(metric);
}

function findNonAnalyticalReference(
  expression: string,
  object: OntologyObject,
): OntologyObject["properties"][number] | undefined {
  if (!expression.trim()) return undefined;
  return object.properties.find(
    (property) =>
      property.visibility !== "ANALYTICAL" &&
      new RegExp(
        `(?:^|[^A-Za-z0-9_])${escapeRegex(property.sourceColumn)}(?:$|[^A-Za-z0-9_])`,
        "i",
      ).test(expression),
  );
}

function error(
  code: string,
  message: string,
  objectId?: string,
  entityId?: string,
): OntologyValidationIssue {
  return { level: "ERROR", code, message, objectId, entityId };
}

function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
