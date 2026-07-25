import type {
  BootstrapPayload,
  Conversation,
  DataAgentEvent,
  DataSourceInput,
  Metric,
  OntologyObject,
  OntologyRelation,
  OntologySnapshot,
  OntologyValidationResult,
  PhysicalTable,
  SafeDataSourceConfig,
  Turn,
} from "../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body
    ? { "Content-Type": "application/json", ...init.headers }
    : init?.headers;
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const body = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(body.message || `请求失败（${response.status}）`);
  return body;
}

export const api = {
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  conversation: (id: string) => request<Conversation>(`/api/conversations/${id}`),
  createConversation: () =>
    request<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  createTurn: (conversationId: string, question: string) =>
    request<Turn>(`/api/conversations/${conversationId}/turns`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  testDataSource: (input: DataSourceInput) =>
    request<{ ok: boolean; version: string }>("/api/data-source/test", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveDataSource: (input: DataSourceInput) =>
    request<{ config: SafeDataSourceConfig; version: string }>("/api/data-source", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  scanSchema: () =>
    request<{ tables: PhysicalTable[] }>("/api/schema/scan", { method: "POST" }),
  createDrafts: (tableIds: string[]) =>
    request<{ ontology: OntologySnapshot; tables: PhysicalTable[] }>(
      "/api/ontology/drafts",
      { method: "POST", body: JSON.stringify({ tableIds }) },
    ),
  createOntologyDraft: () =>
    request<{ ontology: OntologySnapshot }>("/api/ontology/draft", {
      method: "POST",
    }),
  saveOntologyObject: (
    object: OntologyObject,
    metrics: Metric[],
    relations: OntologyRelation[],
  ) =>
    request<{
      ontology: OntologySnapshot;
      validation: OntologyValidationResult;
    }>(`/api/ontology/draft/objects/${object.id}`, {
      method: "PUT",
      body: JSON.stringify({ object, metrics, relations }),
    }),
  validateOntologyDraft: () =>
    request<OntologyValidationResult>("/api/ontology/draft/validate", {
      method: "POST",
    }),
  discardOntologyDraft: () =>
    request<{ ontology: OntologySnapshot; tables: PhysicalTable[] }>(
      "/api/ontology/draft",
      { method: "DELETE" },
    ),
  publishOntology: () =>
    request<{
      ontology: OntologySnapshot;
      tables: PhysicalTable[];
      validation: OntologyValidationResult;
    }>(
      "/api/ontology/publish",
      { method: "POST" },
    ),
  subscribe: (
    conversationId: string,
    onEvent: (event: DataAgentEvent) => void,
  ): (() => void) => {
    const source = new EventSource(
      `/api/events?conversationId=${encodeURIComponent(conversationId)}`,
    );
    const handler = (message: MessageEvent<string>) =>
      onEvent(JSON.parse(message.data) as DataAgentEvent);
    [
      "turn_created",
      "trace_step_started",
      "trace_step_completed",
      "turn_updated",
      "turn_completed",
      "turn_failed",
    ].forEach((name) => source.addEventListener(name, handler as EventListener));
    return () => source.close();
  },
};
