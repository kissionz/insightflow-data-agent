import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OntologySnapshot, PhysicalTable } from "../src/shared/types.js";
import { Repository } from "../src/server/repository.js";
import { testOntology } from "./fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Repository schema reconciliation", () => {
  it("starts with an empty real workspace instead of runtime demo fixtures", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));

    expect(repository.getConversations()).toEqual([]);
    expect(repository.getTables()).toEqual([]);
    expect(repository.getOntology()).toMatchObject({
      version: 0,
      status: "PUBLISHED",
      objects: [],
      relations: [],
      metrics: [],
    });
    repository.close();
  });

  it("caches governed property values by ontology version and property", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    repository.cachePropertyValue({
      ontologyVersion: 3,
      objectId: "o_store",
      propertyId: "p_region",
      normalizedValue: "华东",
      displayValue: "华东",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });

    expect(
      repository.findCachedPropertyValues(3, "华东", ["p_region"]),
    ).toEqual([
      expect.objectContaining({
        objectId: "o_store",
        propertyId: "p_region",
        displayValue: "华东",
      }),
    ]);
    expect(repository.findCachedPropertyValues(2, "华东", ["p_region"])).toEqual(
      [],
    );
    repository.close();
  });

  it("versions workspace business instructions independently from core policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));

    expect(repository.getAgentConfig()).toMatchObject({
      version: 1,
      timezone: "Asia/Shanghai",
      businessInstructions: "",
    });
    const saved = repository.saveAgentConfig({
      timezone: "Asia/Shanghai",
      businessInstructions: "销售额默认采用支付口径。",
    });

    expect(saved.version).toBe(2);
    expect(repository.getAgentConfig()).toEqual(saved);
    repository.close();
  });

  it("keeps modeled tables, identifies changes, and adds only new tables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    const modeled = { ...scannedTable("t_orders", "fact_orders"), status: "MODELED" as const };
    const unmodeled = scannedTable("t_refunds", "fact_refunds");
    repository.upsertScannedTables([modeled, unmodeled, scannedTable("t_customer", "dim_customers")]);
    repository.updateTableStatuses([modeled.id], "MODELED");

    const next = repository.upsertScannedTables([
      { ...modeled },
      { ...unmodeled, fingerprint: "fact_refunds:v2" },
      scannedTable("t_new", "fact_shipments"),
    ]);

    expect(next.find((table) => table.id === modeled.id)?.status).toBe("MODELED");
    expect(next.find((table) => table.id === unmodeled.id)?.status).toBe("UNMODELED");
    expect(next.find((table) => table.name === "fact_shipments")?.status).toBe(
      "UNMODELED",
    );
    expect(next.find((table) => table.id === "t_customer")?.status).toBe("REMOVED");
    repository.close();
  });

  it("marks a changed modeled table for impact review", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    const modeled = scannedTable("t_orders", "fact_orders");
    repository.upsertScannedTables([modeled]);
    repository.updateTableStatuses([modeled.id], "MODELED");

    const next = repository.upsertScannedTables([
      { ...modeled, fingerprint: "fact_orders:v2" },
    ]);

    expect(next.find((table) => table.id === modeled.id)?.status).toBe("CHANGED");
    repository.close();
  });

  it("keeps an editable draft isolated from the published ontology", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    repository.saveOntology(testOntology);
    repository.saveOntology({
      ...structuredClone(testOntology),
      version: 2,
      baseVersion: 1,
      status: "DRAFT",
      publishedAt: undefined,
      objects: testOntology.objects.map((object, index) => ({
        ...structuredClone(object),
        label: index === 0 ? "草稿订单" : object.label,
        status: "DRAFT",
      })),
    });

    expect(repository.getPublishedOntology().version).toBe(1);
    expect(repository.getPublishedOntology().objects[0].label).toBe("订单");
    expect(repository.getDraftOntology()?.version).toBe(2);
    expect(repository.getDraftOntology()?.objects[0].label).toBe("草稿订单");
    repository.close();
  });

  it("migrates legacy object primary keys to the single ID field meaning", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    const legacy = structuredClone(testOntology);
    delete (legacy as Partial<typeof legacy>).schemaVersion;
    legacy.version = 2;
    const legacyObject = legacy.objects[0] as unknown as {
      primaryKey: string[];
      objectType?: string;
      grainPropertyIds?: string[];
      properties: Array<Record<string, unknown>>;
    };
    legacyObject.primaryKey = ["p_order_id"];
    delete legacyObject.objectType;
    delete legacyObject.grainPropertyIds;
    delete (legacyObject as unknown as Record<string, unknown>).bindingPriority;
    for (const property of legacyObject.properties) {
      property.semanticType = property.id === "p_order_amount" ? "AMOUNT" : "IDENTIFIER";
      property.identityRole = "NONE";
      delete property.meaning;
      delete property.unique;
      delete property.valueSearchable;
      delete property.numericSpec;
      delete property.bindingPriority;
    }
    repository.saveOntology(legacy as OntologySnapshot);

    const migrated = repository.getPublishedOntology();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.objects[0].properties[0].meaning).toBe("ID");
    expect(migrated.objects[0].properties[1].meaning).toBe("NUMBER");
    expect(migrated.objects[0].bindingPriority).toBe(50);
    expect(migrated.objects[0].properties[0].bindingPriority).toBe(50);
    repository.close();
  });
});

function scannedTable(id: string, name: string): PhysicalTable {
  return {
    id,
    catalog: "internal",
    database: "retail_analytics",
    name,
    type: "TABLE",
    status: "UNMODELED",
    columns: [],
    fingerprint: `${name}:v1`,
    scannedAt: new Date().toISOString(),
  };
}
