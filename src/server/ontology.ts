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
const propertySchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  dataType: z.string().min(1).max(120),
  sourceColumn: z.string().min(1).max(200),
  sensitive: z.boolean(),
  semanticType: z.enum([
    "IDENTIFIER",
    "DIMENSION",
    "ENUM",
    "TIME",
    "GEOGRAPHY",
    "AMOUNT",
    "QUANTITY",
    "BOOLEAN",
  ]),
  identityRole: z.enum(["NONE", "OBJECT_IDENTIFIER", "BUSINESS_KEY"]),
  visibility: z.enum(["ANALYTICAL", "DETAIL_ONLY", "HIDDEN"]),
  synonyms: z.array(z.string().trim().min(1).max(120)).max(50),
  format: z.string().max(120).optional(),
  detailOrder: z.number().int().min(1).max(10_000).optional(),
  defaultDisplay: z.boolean(),
  exportable: z.boolean(),
  nullDisplay: z.string().max(120).optional(),
});

const objectSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(4_000),
  sourceTableId: z.string().min(1),
  status: entityStatusSchema,
  grain: z.string().max(1_000),
  defaultTimePropertyId: z.string().min(1).optional(),
  defaultFilter: z.string().max(4_000).optional(),
  category: z.string().max(120).optional(),
  owner: z.string().max(120).optional(),
  exampleQuestions: z.array(z.string().trim().min(1).max(500)).max(50),
  properties: z.array(propertySchema).max(2_000),
  synonyms: z.array(z.string().trim().min(1).max(120)).max(50),
});

const metricSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(4_000),
  objectId: z.string().min(1),
  expression: z.string().trim().min(1).max(8_000),
  definitionMode: z.enum(["VISUAL", "SQL"]),
  sourcePropertyId: z.string().min(1).optional(),
  filterExpression: z.string().max(4_000).optional(),
  timePropertyId: z.string().min(1).optional(),
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
        const properties: OntologyObject["properties"] = table.columns.map(
          (column, index) => ({
            id: createId("property"),
            name: column.name,
            label: column.comment || column.name,
            description: column.comment || "",
            dataType: column.dataType,
            sourceColumn: column.name,
            sensitive: column.sensitive,
            semanticType: inferSemanticType(column.name, column.dataType),
            identityRole: "NONE",
            visibility: column.sensitive ? "HIDDEN" : "ANALYTICAL",
            synonyms: [],
            detailOrder: index + 1,
            defaultDisplay: true,
            exportable: !column.sensitive,
          }),
        );
        const primaryCandidate = properties.find(
          (property) =>
            property.name === "id" ||
            property.name === `${table.name.replace(/^(dim|fact)_/, "").replace(/s$/, "")}_id`,
        );
        if (primaryCandidate) primaryCandidate.identityRole = "OBJECT_IDENTIFIER";
        return {
          id: createId("object"),
          name: table.name.replace(/^(dim|fact)_/, "").replace(/s$/, ""),
          label: table.description?.replace(/表$/, "") || table.name,
          description: `基于 ${table.database}.${table.name} 生成的本体草稿`,
          sourceTableId: table.id,
          status: "DRAFT",
          grain: "",
          defaultTimePropertyId: properties.find(
            (property) => property.semanticType === "TIME",
          )?.id,
          exampleQuestions: [],
          synonyms: [],
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
  if (input.metrics.some((metric) => metric.objectId !== objectId)) {
    throw new Error("指标必须归属于当前对象");
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
    metrics: [
      ...draft.metrics.filter((metric) => metric.objectId !== objectId),
      ...input.metrics.map((metric) => ({ ...metric, status: "DRAFT" as const })),
    ],
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
    if (!object.grain.trim()) {
      issues.push(error("GRAIN_REQUIRED", "请填写对象粒度", object.id));
    }
    if (
      !object.properties.some(
        (property) => property.identityRole === "OBJECT_IDENTIFIER",
      )
    ) {
      issues.push(
        error(
          "OBJECT_IDENTIFIER_REQUIRED",
          "请至少将一个属性标记为对象标识",
          object.id,
        ),
      );
    }
    if (
      object.defaultTimePropertyId &&
      !propertyIds.has(object.defaultTimePropertyId)
    ) {
      issues.push(error("TIME_PROPERTY_INVALID", "默认时间字段不存在", object.id));
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
    }
  }

  for (const metric of snapshot.metrics) {
    const object = snapshot.objects.find((item) => item.id === metric.objectId);
    if (!object) {
      issues.push(error("METRIC_OBJECT_MISSING", "指标所属对象不存在", undefined, metric.id));
      continue;
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
  }

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

function inferSemanticType(
  name: string,
  dataType: string,
): OntologyObject["properties"][number]["semanticType"] {
  const normalized = name.toLowerCase();
  if (/(^id$|_id$|code$|number$)/.test(normalized)) return "IDENTIFIER";
  if (/(date|time|_at$)/.test(normalized) || /(date|time)/i.test(dataType)) return "TIME";
  if (/(amount|price|fee|cost|revenue)/.test(normalized)) return "AMOUNT";
  if (/(count|quantity|qty|num)/.test(normalized)) return "QUANTITY";
  if (/^(is_|has_)/.test(normalized) || /bool/i.test(dataType)) return "BOOLEAN";
  return "DIMENSION";
}

function containsUnsafeExpression(value?: string): boolean {
  if (!value?.trim()) return false;
  return /;|--|\/\*|\b(insert|update|delete|drop|alter|truncate|grant|revoke|call)\b/i.test(
    value,
  );
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
