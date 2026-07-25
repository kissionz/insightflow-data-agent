import { describe, expect, it } from "vitest";
import {
  createDraftFromPublished,
  metricExpression,
  publishDraft,
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
    const draft = createDraftFromPublished(testOntology);
    const published = publishDraft(draft);

    expect(published.status).toBe("PUBLISHED");
    expect(published.objects.every((object) => object.status === "PUBLISHED")).toBe(true);
    expect(published.metrics.every((metric) => metric.status === "PUBLISHED")).toBe(true);
    expect(published.relations.every((relation) => relation.status === "PUBLISHED")).toBe(true);
    expect(draft.status).toBe("DRAFT");
  });

  it("blocks publishing an incomplete object", () => {
    const draft = createDraftFromPublished(testOntology);
    draft.objects[0].grain = "";

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
