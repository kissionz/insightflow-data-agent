import { describe, expect, it } from "vitest";
import { appendDetailOnlyProperties } from "../src/server/detail-projection.js";
import { testOntology } from "./fixtures.js";

describe("detail-only projection", () => {
  it("appends detail-only properties without exposing hidden properties", () => {
    const ontology = structuredClone(testOntology);
    ontology.objects[0].properties[1].visibility = "DETAIL_ONLY";
    ontology.objects[0].properties[1].defaultDisplay = true;
    ontology.objects[0].properties[2].visibility = "HIDDEN";
    const sql = "SELECT o.order_id FROM fact_orders AS o WHERE o.order_id > 0";

    const projected = appendDetailOnlyProperties(sql, ontology, [
      {
        id: "t_orders",
        catalog: "internal",
        database: "retail",
        name: "fact_orders",
        type: "TABLE",
        status: "MODELED",
        columns: [],
        fingerprint: "v1",
        scannedAt: new Date().toISOString(),
      },
    ]);

    expect(projected).toContain("`o`.`pay_amount` AS `实付金额`");
    expect(projected).not.toContain("store_id");
  });

  it("does not change aggregate SQL", () => {
    const sql = "SELECT SUM(pay_amount) FROM fact_orders";
    expect(appendDetailOnlyProperties(sql, testOntology, [])).toBe(sql);
  });
});
