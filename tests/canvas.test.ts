import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasItem,
  OntologySnapshot,
  PhysicalTable,
} from "../src/shared/types.js";
import {
  CanvasQueryService,
  MAX_CONCURRENT_CANVAS_QUERIES,
} from "../src/server/canvas.js";
import { QueryIrCompiler } from "../src/server/query-ir.js";
import { Repository } from "../src/server/repository.js";
import { testOntology } from "./fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CanvasQueryService", () => {
  it("recompiles relative time against the current clock for every query", async () => {
    const repository = createRepository();
    const execute = vi.fn(async () => ({
      columns: ["日期", "成交金额"],
      rows: [{ 日期: "2026-08-28", 成交金额: 1280 }],
      durationMs: 12,
      truncated: false,
    }));
    let clock = new Date("2026-08-28T04:00:00.000Z");
    const service = new CanvasQueryService(
      repository,
      execute,
      new QueryIrCompiler(() => clock),
    );

    const response = await service.query(canvasItem("canvas_current_month"));
    clock = new Date("2026-09-02T04:00:00.000Z");
    const nextResponse = await service.query(canvasItem("canvas_current_month"));

    expect(response.resolvedTimeRange).toMatchObject({
      expression: "本月",
      start: "2026-08-01 00:00:00",
      endExclusive: "2026-08-29 00:00:00",
      mode: "TO_DATE",
    });
    expect(nextResponse.resolvedTimeRange).toMatchObject({
      start: "2026-09-01 00:00:00",
      endExclusive: "2026-09-03 00:00:00",
    });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("LIMIT 200"),
      200,
      ["2026-08-01 00:00:00", "2026-08-29 00:00:00"],
      180_000,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("LIMIT 200"),
      200,
      ["2026-09-01 00:00:00", "2026-09-03 00:00:00"],
      180_000,
    );
    expect(response.result.chart.title).toBe("本月成交金额");
    repository.close();
  });

  it("runs no more than five canvas queries at once", async () => {
    const repository = createRepository();
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        columns: ["日期", "成交金额"],
        rows: [{ 日期: "2026-08-28", 成交金额: 1280 }],
        durationMs: 10,
        truncated: false,
      };
    });
    const service = new CanvasQueryService(
      repository,
      execute,
      new QueryIrCompiler(() => new Date("2026-08-28T04:00:00.000Z")),
    );

    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        service.query(canvasItem(`canvas_${index}`)),
      ),
    );

    expect(peak).toBe(MAX_CONCURRENT_CANVAS_QUERIES);
    expect(execute).toHaveBeenCalledTimes(9);
    repository.close();
  });
});

function createRepository(): Repository {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-canvas-"));
  roots.push(root);
  const repository = new Repository(path.join(root, "ontology.sqlite"));
  repository.saveOntology(timeEnabledOntology());
  repository.upsertScannedTables([ordersTable()]);
  repository.updateTableStatuses(["t_orders"], "MODELED");
  return repository;
}

function timeEnabledOntology(): OntologySnapshot {
  const ontology = structuredClone(testOntology);
  const order = ontology.objects[0]!;
  order.defaultTimePropertyId = "p_paid_at";
  order.properties.push({
    id: "p_paid_at",
    name: "paid_at",
    label: "支付时间",
    description: "支付完成时间",
    dataType: "DATETIME",
    sourceColumn: "paid_at",
    sensitive: false,
    meaning: "TIME",
    unique: false,
    valueSearchable: false,
    visibility: "ANALYTICAL",
    synonyms: [],
    defaultDisplay: true,
    exportable: true,
    bindingPriority: 50,
  });
  ontology.metrics[0]!.timePropertyId = "p_paid_at";
  return ontology;
}

function ordersTable(): PhysicalTable {
  return {
    id: "t_orders",
    catalog: "internal",
    database: "retail",
    name: "fact_orders",
    type: "TABLE",
    status: "MODELED",
    columns: [],
    fingerprint: "fact_orders:v3",
    scannedAt: "2026-08-28T00:00:00.000Z",
  };
}

function canvasItem(id: string): CanvasItem {
  return {
    id,
    title: "本月成交金额",
    intent: {
      rootObjectId: "o_order",
      measureIds: ["m_gmv"],
      dimensionPropertyIds: [],
      filters: [],
      timeRange: { expression: "本月", kind: "CURRENT_MONTH" },
      timeGrain: { unit: "DAY" },
      resultKind: "aggregate",
      title: "本月成交金额",
    },
    width: "standard",
    position: 0,
    sourceConversationId: "conv_1",
    sourceTurnId: `turn_${id}`,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}
