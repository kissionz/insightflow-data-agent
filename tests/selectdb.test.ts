import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import type { SafeDataSourceConfig } from "../src/shared/types.js";
import { SelectDbClient } from "../src/server/selectdb.js";

describe("SelectDbClient", () => {
  it("reuses one pool when parallel queries request the same configuration", async () => {
    let createdPools = 0;
    let closedPools = 0;
    let queries = 0;
    const client = new SelectDbClient(() => {
      createdPools += 1;
      return {
        async query() {
          queries += 1;
          await Promise.resolve();
          return [[{ value: queries }], [{ name: "value" }]];
        },
        async end() {
          closedPools += 1;
        },
      } as unknown as Pool;
    });
    const execute = async () => {
      await client.configure(config(), "secret");
      return client.query("SELECT 1", 60_000, 10);
    };

    const results = await Promise.all([execute(), execute(), execute()]);

    expect(results).toHaveLength(3);
    expect(createdPools).toBe(1);
    expect(closedPools).toBe(0);
    expect(queries).toBe(3);

    await client.close();
    expect(closedPools).toBe(1);
  });

  it("replaces the pool only when connection settings actually change", async () => {
    let createdPools = 0;
    let closedPools = 0;
    const client = new SelectDbClient(() => {
      createdPools += 1;
      return {
        async query() {
          return [[], []];
        },
        async end() {
          closedPools += 1;
        },
      } as unknown as Pool;
    });

    await client.configure(config(), "secret");
    await client.configure(config(), "secret");
    await client.configure({ ...config(), database: "analytics_v2" }, "secret");

    expect(createdPools).toBe(2);
    expect(closedPools).toBe(1);

    await client.close();
    expect(closedPools).toBe(2);
  });
});

function config(): SafeDataSourceConfig {
  return {
    configured: true,
    host: "selectdb.example.com",
    port: 9030,
    username: "analyst",
    catalog: "internal",
    database: "analytics",
    tls: false,
    passwordStored: true,
    lastTestOk: true,
  };
}
