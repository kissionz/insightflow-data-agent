import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentReporter,
  ToolCall,
  ToolOutcome,
  ToolStatus,
} from "montane-code";
import { afterEach, describe, expect, it } from "vitest";
import type { Turn } from "../src/shared/types.js";
import { DataAgentHarness } from "../src/server/harness.js";
import { Repository } from "../src/server/repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DataAgentHarness", () => {
  it("runs the demo analysis through AgentLoop, domain tools, and SessionStore", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "insightflow-harness-"));
    roots.push(root);
    const repository = new Repository(path.join(root, ".montane/data-agent/ontology.sqlite"));
    const conversation = repository.getConversation("conv_demo")!;
    const turn: Turn = {
      id: "turn_harness_test",
      conversationId: conversation.id,
      parentTurnId: conversation.turns.at(-1)?.id,
      question: "哪些商品品类增长最快？",
      status: "planning",
      createdAt: new Date().toISOString(),
      ontologyVersion: repository.getOntology().version,
      trace: [],
    };
    const toolStatuses: Array<{ name: string; status: ToolStatus }> = [];
    const reporter: AgentReporter = {
      onTextDelta() {},
      onTextEnd() {},
      onToolStatus(call: ToolCall, status: ToolStatus, _result?: ToolOutcome) {
        toolStatuses.push({ name: call.name, status });
      },
    };
    const harness = new DataAgentHarness(root, repository, async () => {
      throw new Error("demo mode must not access SelectDB");
    });

    const output = await harness.run(conversation, turn, reporter);
    await harness.close();

    expect(output.result.mode).toBe("demo");
    expect(output.result.conclusion).toContain("家居品类本月增长最快");
    expect(toolStatuses).toEqual(
      expect.arrayContaining([
        { name: "OntologySearch", status: "running" },
        { name: "OntologySearch", status: "succeeded" },
        { name: "SelectDBQuery", status: "running" },
        { name: "SelectDBQuery", status: "succeeded" },
      ]),
    );
    expect(repository.getConversation(conversation.id)?.harnessSessionId).toBe(
      output.sessionId,
    );

    const eventPath = path.join(
      root,
      ".montane",
      "sessions",
      output.sessionId,
      "events.jsonl",
    );
    const events = fs.readFileSync(eventPath, "utf8");
    expect(events).toContain('"type":"assistant_tool_calls"');
    expect(events).toContain('"name":"OntologySearch"');
    expect(events).toContain('"name":"SelectDBQuery"');
    expect(events).toContain('"type":"assistant_final"');
    repository.close();
  });
});
