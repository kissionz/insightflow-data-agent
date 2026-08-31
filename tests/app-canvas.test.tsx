// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisIntent,
  BootstrapPayload,
  CanvasItem,
  ResultArtifact,
  Turn,
} from "../src/shared/types.js";
import { App } from "../src/web/App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("canvas interactions", () => {
  it("persists drag-and-drop component order", async () => {
    const first = canvasItem("canvas_first", "第一个组件", 0);
    const second = canvasItem("canvas_second", "第二个组件", 1);
    const orderRequests: string[][] = [];
    mockBrowserApis(bootstrap({ canvasItems: [first, second] }), async (url, init) => {
      if (url === "/api/canvas-items/order") {
        const itemIds = (JSON.parse(String(init?.body)) as { itemIds: string[] }).itemIds;
        orderRequests.push(itemIds);
        return jsonResponse({
          items: itemIds.map((id, position) => ({
            ...(id === first.id ? first : second),
            position,
          })),
        });
      }
      if (url.endsWith("/query")) {
        return jsonResponse({ message: "测试查询未配置" }, 422);
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "画布" }));
    const source = await screen.findByRole("button", {
      name: "拖动第一个组件调整位置",
    });
    const target = screen.getByRole("heading", { name: "第二个组件" }).closest("article");
    expect(target).not.toBeNull();
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target!, { dataTransfer });
    fireEvent.drop(target!, { dataTransfer });

    await waitFor(() => {
      expect(orderRequests).toEqual([[second.id, first.id]]);
    });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles.slice(0, 2)).toEqual(["第二个组件", "第一个组件"]);
  });

  it("allows a KPI-only result to be added as a metric component", async () => {
    const turn = metricTurn();
    const added = {
      ...canvasItem("canvas_metric", "本月销售额", 0),
      presentation: "metric" as const,
      sourceConversationId: turn.conversationId,
      sourceTurnId: turn.id,
    };
    const addRequests: Array<{ conversationId: string; turnId: string }> = [];
    mockBrowserApis(
      bootstrap({
        conversations: [{
          id: turn.conversationId,
          title: "指标查询",
          createdAt: turn.createdAt,
          updatedAt: turn.createdAt,
          status: "active",
          turns: [turn],
        }],
      }),
      async (url, init) => {
        if (url === "/api/canvas-items") {
          addRequests.push(JSON.parse(String(init?.body)) as {
            conversationId: string;
            turnId: string;
          });
          return jsonResponse(added, 201);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    render(<App />);
    const addButton = await screen.findByRole("button", { name: "添加到画布" });
    fireEvent.click(addButton);

    await waitFor(() => {
      expect(addRequests).toEqual([{
        conversationId: turn.conversationId,
        turnId: turn.id,
      }]);
      expect(screen.getByRole("button", { name: "已添加" })).toBeDisabled();
    });
  });
});

function mockBrowserApis(
  payload: BootstrapPayload,
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/bootstrap") return jsonResponse(payload);
    return handler(url, init);
  }));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bootstrap(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    conversations: [],
    canvasItems: [],
    ontology: {
      schemaVersion: 2,
      version: 0,
      status: "PUBLISHED",
      objects: [],
      relations: [],
      metrics: [],
    },
    tables: [],
    dataSource: { configured: false, passwordStored: false },
    agentConfig: {
      version: 1,
      businessInstructions: "",
      timezone: "Asia/Shanghai",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    valueIndex: {
      ontologyVersion: 0,
      status: "idle",
      indexedProperties: 0,
      indexedValues: 0,
      partialProperties: 0,
      failedProperties: 0,
    },
    runtime: {
      modelConfigured: false,
      analysisReady: false,
      credentialStore: "environment",
    },
    ...overrides,
  };
}

function canvasItem(id: string, title: string, position: number): CanvasItem {
  return {
    id,
    title,
    intent: metricIntent(title),
    presentation: "chart",
    width: "standard",
    position,
    sourceConversationId: "conv_canvas",
    sourceTurnId: `turn_${id}`,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function metricIntent(title: string): AnalysisIntent {
  return {
    rootObjectId: "o_sales",
    measureIds: ["m_sales"],
    dimensionPropertyIds: [],
    filters: [],
    timeRange: { expression: "本月", kind: "CURRENT_MONTH" },
    resultKind: "aggregate",
    title,
  };
}

function metricTurn(): Turn {
  const result: ResultArtifact = {
    kind: "analysis",
    mode: "live",
    conclusion: "本月销售额为 ¥1,280。",
    kpis: [{ label: "销售额", value: "¥1,280" }],
    chart: {
      title: "本月销售额",
      type: "none",
      label: "数据",
      rationale: "单行聚合已提炼为业务指标。",
      categories: [],
      series: [],
    },
    columns: ["销售额"],
    rows: [{ 销售额: 1280 }],
    rowCount: 1,
    truncated: false,
  };
  return {
    id: "turn_metric",
    conversationId: "conv_metric",
    question: "本月销售额",
    status: "completed",
    createdAt: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:00:01.000Z",
    ontologyVersion: 0,
    trace: [],
    responseKind: "analysis",
    resultIntent: metricIntent("本月销售额"),
    result,
  };
}
