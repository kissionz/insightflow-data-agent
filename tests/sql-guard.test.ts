import { describe, expect, it } from "vitest";
import { guardReadOnlySql } from "../src/server/sql-guard.js";

describe("guardReadOnlySql", () => {
  it("accepts SELECT and injects the configured limit", () => {
    expect(guardReadOnlySql("SELECT * FROM fact_orders", 200)).toEqual({
      sql: "SELECT * FROM fact_orders\nLIMIT 200",
      injectedLimit: true,
    });
  });

  it("caps an excessive existing limit", () => {
    expect(guardReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x LIMIT 999", 50).sql)
      .toBe("WITH x AS (SELECT 1) SELECT * FROM x LIMIT 50");
  });

  it.each([
    "DELETE FROM fact_orders",
    "SELECT 1; SELECT 2",
    "SELECT * FROM fact_orders INTO OUTFILE '/tmp/result'",
    "UPDATE fact_orders SET amount = 0",
  ])("rejects unsafe SQL: %s", (sql) => {
    expect(() => guardReadOnlySql(sql)).toThrow();
  });

  it("does not treat a keyword inside a string as a mutation", () => {
    expect(guardReadOnlySql("SELECT 'delete' AS action", 10).sql).toContain("LIMIT 10");
  });
});
