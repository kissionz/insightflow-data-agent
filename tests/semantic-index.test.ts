import { describe, expect, it } from "vitest";
import { SemanticIndex } from "../src/server/semantic-index.js";
import { testOntology } from "./fixtures.js";

describe("SemanticIndex", () => {
  const index = new SemanticIndex(testOntology);

  it("matches Chinese synonyms to published metrics", () => {
    const matches = index.search("本月销售额怎么样");
    expect(matches.some((match) => match.id === "m_gmv")).toBe(true);
  });

  it("returns the exact property and owning object for a property label", () => {
    const matches = index.search("按会员等级分析");
    expect(
      matches.some(
        (match) =>
          match.kind === "property" &&
          match.id === "p_customer_level" &&
          match.objectId === "o_customer",
      ),
    ).toBe(true);
  });

  it("finds a relation path between objects", () => {
    const path = index.findRelationPath("o_customer", "o_store");
    expect(path.map((relation) => relation.id)).toEqual([
      "r_order_customer",
      "r_order_store",
    ]);
  });

  it("does not index detail-only or hidden properties", () => {
    const ontology = structuredClone(testOntology);
    ontology.objects[0].properties[1] = {
      ...ontology.objects[0].properties[1],
      name: "detail_secret_code",
      label: "仅展示编码",
      synonyms: ["内部展示码"],
      visibility: "DETAIL_ONLY",
    };
    const isolated = new SemanticIndex(ontology);

    expect(
      isolated.search("内部展示码").some((match) => match.id === "p_order_amount"),
    ).toBe(false);
  });

  it("keeps exact-label evidence above a higher-priority synonym", () => {
    const ontology = structuredClone(testOntology);
    ontology.objects[1]!.bindingPriority = 1;
    ontology.objects[0]!.bindingPriority = 100;
    ontology.objects[0]!.synonyms.push("客户");
    const isolated = new SemanticIndex(ontology);

    const matches = isolated.search("客户", 8, ["object"]);
    expect(matches[0]).toMatchObject({
      id: "o_customer",
      evidenceTier: "EXACT_LABEL",
    });
  });

  it("uses object priority to arbitrate equal evidence tiers", () => {
    const ontology = structuredClone(testOntology);
    ontology.objects[1]!.bindingPriority = 10;
    ontology.objects[2]!.bindingPriority = 90;
    ontology.objects[2]!.label = "客户";
    const isolated = new SemanticIndex(ontology);

    const matches = isolated.search("客户", 8, ["object"]);
    expect(matches.slice(0, 2).map((match) => match.id)).toEqual([
      "o_store",
      "o_customer",
    ]);
  });
});
