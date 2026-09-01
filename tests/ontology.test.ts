import { describe, expect, it } from "vitest";
import {
  createDraftFromPublished,
  metricExpression,
  publishDraft,
  removeDimensionHierarchyFromDraft,
  removeMetricFromDraft,
  removeObjectFromDraft,
  upsertMetricInDraft,
  upsertDimensionHierarchyInDraft,
  validateOntology,
} from "../src/server/ontology.js";
import { testOntology } from "./fixtures.js";

describe("ontology lifecycle", () => {
  it("creates an isolated next-version draft", () => {
    const published = structuredClone(testOntology);
    const draft = createDraftFromPublished(published);

    draft.objects[0].label = "草稿订单";
    draft.objects[0].properties[1].visibility = "DETAIL_ONLY";

    expect(draft.version).toBe(published.version + 1);
    expect(draft.baseVersion).toBe(published.version);
    expect(draft.status).toBe("DRAFT");
    expect(published.objects[0].label).toBe("订单");
    expect(published.objects[0].properties[1].visibility).toBe("ANALYTICAL");
  });

  it("publishes every child entity without mutating the draft", () => {
    const source = structuredClone(testOntology);
    source.dimensionHierarchies = [
      {
        id: "hierarchy_product",
        name: "product",
        label: "商品层级",
        levels: [
          { objectId: "o_order", propertyId: "p_store_id" },
          { objectId: "o_order", propertyId: "p_customer_id" },
        ],
        status: "PUBLISHED",
      },
    ];
    const draft = createDraftFromPublished(source);
    const published = publishDraft(draft);

    expect(published.status).toBe("PUBLISHED");
    expect(published.objects.every((object) => object.status === "PUBLISHED")).toBe(true);
    expect(published.metrics.every((metric) => metric.status === "PUBLISHED")).toBe(true);
    expect(published.relations.every((relation) => relation.status === "PUBLISHED")).toBe(true);
    expect(
      published.dimensionHierarchies?.every(
        (hierarchy) => hierarchy.status === "PUBLISHED",
      ),
    ).toBe(true);
    expect(
      draft.dimensionHierarchies?.every(
        (hierarchy) => hierarchy.status === "DRAFT",
      ),
    ).toBe(true);
    expect(draft.status).toBe("DRAFT");
  });

  it("validates dimension hierarchy levels and safe paths", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.dimensionHierarchies = [
      {
        id: "hierarchy_invalid",
        name: "invalid",
        label: "错误层级",
        levels: [
          { objectId: "o_customer", propertyId: "p_customer_level" },
          { objectId: "o_store", propertyId: "p_store_id" },
        ],
        status: "DRAFT",
      },
    ];
    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some(
        (issue) => issue.code === "DIMENSION_HIERARCHY_PATH_UNSAFE",
      ),
    ).toBe(true);
  });

  it("validates recursive adjacency hierarchies and their self relation", () => {
    const draft = createDraftFromPublished(testOntology);
    const customer = draft.objects.find((object) => object.id === "o_customer")!;
    customer.properties.push({
      ...customer.properties[0]!,
      id: "p_customer_parent_id",
      name: "parent_customer_id",
      label: "上级客户ID",
      sourceColumn: "parent_customer_id",
      meaning: "ENTITY_REFERENCE",
      unique: false,
    });
    draft.dimensionHierarchies = [{
      id: "hierarchy_customer_tree",
      name: "customer_tree",
      label: "客户组织树",
      kind: "ADJACENCY_LIST",
      levels: [],
      adjacency: {
        objectId: "o_customer",
        nodeIdPropertyId: "p_customer_id",
        parentIdPropertyId: "p_customer_parent_id",
        labelPropertyId: "p_customer_level",
        maxDepth: 20,
      },
      status: "DRAFT",
    }];
    const tables = draft.objects.map((object) => ({
      id: object.sourceTableId,
      catalog: "internal",
      database: "retail",
      name: object.name,
      type: "TABLE" as const,
      status: "MODELED" as const,
      columns: [],
      fingerprint: "v1",
      scannedAt: new Date().toISOString(),
    }));

    const missingRelation = validateOntology(draft, tables);
    expect(missingRelation.issues.some(
      (issue) => issue.code === "DIMENSION_HIERARCHY_SELF_RELATION_REQUIRED",
    )).toBe(true);

    draft.relations.push({
      id: "r_customer_parent",
      name: "客户父节点",
      sourceObjectId: "o_customer",
      targetObjectId: "o_customer",
      type: "HIERARCHY",
      cardinality: "MANY_TO_ONE",
      joinExpression: "dim_customers.parent_customer_id = dim_customers.customer_id",
      sourcePropertyId: "p_customer_parent_id",
      targetPropertyId: "p_customer_id",
      direction: "SOURCE_TO_TARGET",
      required: false,
      enabled: true,
      fanoutRisk: "NONE",
      status: "DRAFT",
    });
    const valid = validateOntology(draft, tables);
    expect(valid.issues.some((issue) => issue.code.startsWith("DIMENSION_HIERARCHY_")))
      .toBe(false);
  });

  it("normalizes and validates composition semantics", () => {
    const published = structuredClone(testOntology);
    published.relations[0]!.type = "COMPOSITION";
    published.relations[0]!.composition = undefined;
    const draft = createDraftFromPublished(published);

    expect(draft.relations[0]!.composition).toEqual({
      childObjectId: "o_order",
      parentObjectId: "o_customer",
      ownership: "OWNED",
      aggregationPolicy: "PRE_AGGREGATE_CHILD",
    });

    draft.relations[0]!.cardinality = "ONE_TO_MANY";
    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some(
        (issue) => issue.code === "COMPOSITION_CARDINALITY_INVALID",
      ),
    ).toBe(true);
  });

  it("upserts and removes dimension hierarchies inside a draft", () => {
    const draft = createDraftFromPublished(testOntology);
    const updated = upsertDimensionHierarchyInDraft(draft, {
      id: "hierarchy_order",
      name: "order",
      label: "订单分析层级",
      levels: [
        { objectId: "o_order", propertyId: "p_store_id" },
        { objectId: "o_order", propertyId: "p_customer_id" },
      ],
      status: "PUBLISHED",
    });
    expect(updated.dimensionHierarchies).toContainEqual(
      expect.objectContaining({
        id: "hierarchy_order",
        status: "DRAFT",
      }),
    );

    const removed = removeDimensionHierarchyFromDraft(
      updated,
      "hierarchy_order",
    );
    expect(removed.dimensionHierarchies).toEqual([]);
  });

  it("blocks publishing an incomplete object", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.objects[0].grain = "";
    draft.objects[0].grainPropertyIds = [];
    draft.objects[0].properties[0].meaning = "CODE";
    draft.objects[0].properties[0].unique = false;

    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "GRAIN_REQUIRED")).toBe(true);
  });

  it("allows aggregate objects without an ID when structured grain is configured", () => {
    const draft = createDraftFromPublished(testOntology);
    const aggregate = draft.objects[0];
    aggregate.objectType = "AGGREGATE";
    aggregate.properties[0].meaning = "CODE";
    aggregate.properties[0].unique = false;
    aggregate.grainPropertyIds = ["p_store_id"];

    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some((issue) => issue.code === "OBJECT_ID_REQUIRED"),
    ).toBe(false);
    expect(
      result.issues.some((issue) => issue.code === "GRAIN_REQUIRED"),
    ).toBe(false);
  });

  it("rejects more than one ID for the same object", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.objects[1].properties[1].meaning = "ID";
    draft.objects[1].properties[1].unique = true;

    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some((issue) => issue.code === "OBJECT_ID_MULTIPLE"),
    ).toBe(true);
  });

  it("removes an object together with its metrics and relations", () => {
    const draft = createDraftFromPublished(testOntology);
    const removed = removeObjectFromDraft(draft, "o_order");

    expect(removed.sourceTableId).toBe("t_orders");
    expect(
      removed.ontology.objects.some((object) => object.id === "o_order"),
    ).toBe(false);
    expect(
      removed.ontology.metrics.some((metric) => metric.objectId === "o_order"),
    ).toBe(false);
    expect(
      removed.ontology.relations.some(
        (relation) =>
          relation.sourceObjectId === "o_order" ||
          relation.targetObjectId === "o_order",
      ),
    ).toBe(false);
    expect(draft.objects.some((object) => object.id === "o_order")).toBe(true);
  });

  it("rejects metrics and relations that expose detail-only properties", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.objects[0].properties[1].visibility = "DETAIL_ONLY";
    draft.metrics[0].expression = "SUM(pay_amount)";
    draft.relations[0].sourcePropertyId = "p_order_amount";
    draft.relations[0].joinExpression =
      "fact_orders.pay_amount = dim_customers.customer_id";

    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some(
        (issue) => issue.code === "METRIC_PROPERTY_NOT_ANALYTICAL",
      ),
    ).toBe(true);
    expect(
      result.issues.some((issue) => issue.code === "RELATION_KEY_NOT_ANALYTICAL"),
    ).toBe(true);
  });

  it("rejects SUM as the default for a non-additive numeric property", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.objects[0].properties[1].numericSpec = {
      kind: "RATIO",
      unit: "%",
      defaultAggregation: "SUM",
      aggregationBehavior: "NON_ADDITIVE",
    };

    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some(
        (issue) => issue.code === "NUMBER_DEFAULT_SUM_NOT_ALLOWED",
      ),
    ).toBe(true);
  });

  it("stores independent composite metrics and protects their dependencies", () => {
    let draft = createDraftFromPublished(testOntology);
    const costMetric = {
      ...draft.metrics[0]!,
      id: "m_cost",
      metricType: "BASE" as const,
      name: "cost",
      label: "成本额",
    };
    draft = upsertMetricInDraft(draft, costMetric);
    draft = upsertMetricInDraft(draft, {
      ...draft.metrics[0]!,
      id: "m_gross_margin",
      metricType: "DERIVED",
      name: "gross_margin",
      label: "毛利率",
      expression: "(成交金额 - 成本额) / 成交金额",
      aggregation: "CUSTOM",
      sourcePropertyId: undefined,
      leftMetricId: "m_gmv",
      rightMetricId: "m_cost",
      calculationOperator: "SUBTRACT",
    });

    expect(draft.metrics).toHaveLength(3);
    expect(() => removeMetricFromDraft(draft, "m_cost")).toThrow(
      "正被 毛利率 引用",
    );
  });

  it("detects cycles in composite metrics", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.metrics.push(
      {
        ...draft.metrics[0]!,
        id: "m_a",
        metricType: "DERIVED",
        name: "metric_a",
        label: "指标A",
        aggregation: "CUSTOM",
        sourcePropertyId: undefined,
        leftMetricId: "m_b",
        rightMetricId: "m_gmv",
        calculationOperator: "ADD",
      },
      {
        ...draft.metrics[0]!,
        id: "m_b",
        metricType: "DERIVED",
        name: "metric_b",
        label: "指标B",
        aggregation: "CUSTOM",
        sourcePropertyId: undefined,
        leftMetricId: "m_a",
        rightMetricId: "m_gmv",
        calculationOperator: "SUBTRACT",
      },
    );
    const result = validateOntology(
      draft,
      draft.objects.map((object) => ({
        id: object.sourceTableId,
        catalog: "internal",
        database: "retail",
        name: object.name,
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      })),
    );

    expect(
      result.issues.some((issue) => issue.code === "DERIVED_METRIC_CYCLE"),
    ).toBe(true);
  });
});

describe("visual metric expressions", () => {
  it("uses Doris-compatible CASE expressions for filtered aggregation", () => {
    expect(
      metricExpression(
        {
          definitionMode: "VISUAL",
          aggregation: "SUM",
          sourcePropertyId: "p_order_amount",
          filterExpression: "status = 'paid'",
        },
        testOntology.objects[0],
      ),
    ).toBe("SUM(CASE WHEN status = 'paid' THEN `pay_amount` END)");
  });

  it("supports filtered counts without a source property", () => {
    expect(
      metricExpression(
        {
          definitionMode: "VISUAL",
          aggregation: "COUNT",
          filterExpression: "is_valid = 1",
        },
        testOntology.objects[0],
      ),
    ).toBe("COUNT(CASE WHEN is_valid = 1 THEN 1 END)");
  });
});
