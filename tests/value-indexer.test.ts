import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PhysicalTable } from "../src/shared/types.js";
import { Repository } from "../src/server/repository.js";
import { PropertyValueIndexer } from "../src/server/value-indexer.js";
import { testOntology } from "./fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("PropertyValueIndexer", () => {
  it("builds a published local value index for governed properties", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-index-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    repository.saveOntology(testOntology);
    repository.upsertScannedTables([customerTable()]);
    const sqlCalls: string[] = [];
    const indexer = new PropertyValueIndexer(
      repository,
      async (sql) => {
        sqlCalls.push(sql);
        return {
          columns: ["indexed_value", "value_frequency"],
          rows: [
            { indexed_value: "VIP", value_frequency: 42 },
            { indexed_value: "普通会员", value_frequency: 18 },
          ],
          durationMs: 4,
          truncated: false,
        };
      },
    );

    expect(indexer.start(testOntology).status).toBe("building");
    const status = await indexer.wait();
    const matches = repository.findIndexedPropertyValues(
      testOntology.version,
      "vip",
      ["p_customer_level"],
    );
    const properties = repository.getIndexedPropertyStatuses(
      testOntology.version,
    );

    expect(status).toMatchObject({
      status: "ready",
      indexedProperties: 1,
      indexedValues: 2,
      failedProperties: 0,
    });
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]).toContain("GROUP BY `member_level`");
    expect(matches).toEqual([
      expect.objectContaining({
        propertyId: "p_customer_level",
        displayValue: "VIP",
        frequency: 42,
      }),
    ]);
    expect(properties).toEqual([
      expect.objectContaining({
        objectId: "o_customer",
        propertyId: "p_customer_level",
        status: "ready",
        distinctValues: 2,
        coveredRows: 60,
        topValues: [
          { value: "VIP", frequency: 42 },
          { value: "普通会员", frequency: 18 },
        ],
      }),
    ]);
    repository.close();
  });
});

function customerTable(): PhysicalTable {
  return {
    id: "t_customers",
    catalog: "internal",
    database: "retail",
    name: "dim_customers",
    type: "TABLE",
    status: "MODELED",
    columns: [],
    fingerprint: "dim_customers:v2",
    scannedAt: "2026-07-26T00:00:00.000Z",
  };
}
