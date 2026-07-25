import { describe, expect, it } from "vitest";
import { SemanticIndex } from "../src/server/semantic-index.js";
import { demoOntology } from "../src/server/seed.js";

describe("SemanticIndex", () => {
  const index = new SemanticIndex(demoOntology);

  it("matches Chinese synonyms to published metrics", () => {
    const matches = index.search("本月销售额怎么样");
    expect(matches.some((match) => match.id === "m_gmv")).toBe(true);
  });

  it("matches an object through a property label", () => {
    const matches = index.search("按会员等级分析");
    expect(matches.some((match) => match.id === "o_customer")).toBe(true);
  });

  it("finds a relation path between objects", () => {
    const path = index.findRelationPath("o_customer", "o_store");
    expect(path.map((relation) => relation.id)).toEqual([
      "r_order_customer",
      "r_order_store",
    ]);
  });
});
