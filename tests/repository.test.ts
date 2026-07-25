import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PhysicalTable } from "../src/shared/types.js";
import { Repository } from "../src/server/repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Repository schema reconciliation", () => {
  it("keeps modeled tables, identifies changes, and adds only new tables", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    const existing = repository.getTables();
    const modeled = existing.find((table) => table.id === "t_orders")!;
    const unmodeled = existing.find((table) => table.id === "t_refunds")!;

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
    expect(next.find((table) => table.id === "t_customers")?.status).toBe("REMOVED");
    repository.close();
  });

  it("marks a changed modeled table for impact review", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-repo-"));
    roots.push(root);
    const repository = new Repository(path.join(root, "ontology.sqlite"));
    const modeled = repository.getTables().find((table) => table.id === "t_orders")!;

    const next = repository.upsertScannedTables([
      { ...modeled, fingerprint: "fact_orders:v2" },
    ]);

    expect(next.find((table) => table.id === modeled.id)?.status).toBe("CHANGED");
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
