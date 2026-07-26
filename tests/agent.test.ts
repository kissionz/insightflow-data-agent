import { describe, expect, it } from "vitest";
import { mergeTraceFacts } from "../src/server/agent.js";

describe("analysis evidence facts", () => {
  it("keeps lexical candidates, value corrections, and final bindings", () => {
    const facts = mergeTraceFacts(
      [{
        label: "候选属性",
        value: "渠道性质",
        source: "词形“渠道” · 匹配分 96%",
        entityId: "property_channel_nature",
      }],
      [
        {
          label: "门店 · 组织单元",
          value: "线上渠道",
          source: "全局发布值索引精确命中 · 纠正了词形候选范围",
          entityId: "property_org_unit",
        },
        {
          label: "候选属性",
          value: "渠道性质",
          source: "词形“渠道” · 匹配分 96%",
          entityId: "property_channel_nature",
        },
      ],
    );

    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.value)).toEqual([
      "渠道性质",
      "线上渠道",
    ]);
  });
});
