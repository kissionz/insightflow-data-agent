import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type {
  Conversation,
  DataSourceInput,
  OntologyObject,
  OntologySnapshot,
  PropertyValueIndexProperty,
  SafeDataSourceConfig,
} from "../shared/types.js";
import { DataAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import { DataAgentHarness } from "./harness.js";
import { createId } from "./id.js";
import { credentialStoreKind, KeychainStore } from "./keychain.js";
import {
  addTablesToDraft,
  applyObjectEdit,
  createDraftFromPublished,
  objectEditSchema,
  publishDraft,
  removeObjectFromDraft,
  validateOntology,
} from "./ontology.js";
import { Repository } from "./repository.js";
import { SelectDbClient } from "./selectdb.js";
import { PropertyValueIndexer } from "./value-indexer.js";

const config = loadConfig();
const repository = new Repository(config.databasePath);
const events = new EventHub();
const keychain = new KeychainStore(config.workspaceRoot, config.stateRoot);
const selectDb = new SelectDbClient();
const executeLiveQuery = async (
  sql: string,
  maxRows: number,
  parameters: unknown[] = [],
  timeoutMs = 180_000,
) => {
    const source = repository.getDataSource();
    const password = await keychain.getPassword();
    if (!source.configured || !password) throw new Error("SelectDB 凭证不可用");
    await selectDb.configure(source, password);
    return selectDb.query(sql, timeoutMs, maxRows, parameters);
};
const harness = new DataAgentHarness(
  config.workspaceRoot,
  repository,
  executeLiveQuery,
);
const valueIndexer = new PropertyValueIndexer(repository, executeLiveQuery);
const agent = new DataAgent(repository, events, harness);
const app = Fastify({ logger: true });

const dataSourceSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive().max(65535),
  username: z.string().min(1),
  password: z.string().optional(),
  catalog: z.string().default("internal"),
  database: z.string().min(1),
  tls: z.boolean().default(false),
});
const agentConfigSchema = z.object({
  businessInstructions: z.string().max(12_000),
  timezone: z.enum([
    "Asia/Shanghai",
    "UTC",
    "Asia/Hong_Kong",
    "Asia/Singapore",
  ]),
});

app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

app.get("/api/bootstrap", async () => {
  const dataSource = repository.getDataSource();
  const montaneRuntime = await harness.runtimeStatus();
  return {
    conversations: repository.getConversations(),
    ontology: repository.getPublishedOntology(),
    ontologyDraft: repository.getDraftOntology() ?? undefined,
    tables: repository.getTables(),
    dataSource,
    agentConfig: repository.getAgentConfig(),
    valueIndex: repository.getPropertyValueIndexStatus(),
    runtime: {
      modelConfigured: montaneRuntime.configured,
      analysisReady: Boolean(
        dataSource.configured && montaneRuntime.configured,
      ),
      provider: montaneRuntime.provider,
      model: montaneRuntime.model,
      modelError: montaneRuntime.error,
      credentialStore: credentialStoreKind(),
    },
  };
});

app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
  const conversation = repository.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ message: "会话不存在" });
  return conversation;
});

app.put<{ Body: unknown }>("/api/agent-config", async (request, reply) => {
  const parsed = agentConfigSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      message: parsed.error.issues[0]?.message || "Agent 配置不完整",
    });
  }
  return { config: repository.saveAgentConfig(parsed.data) };
});

app.post("/api/value-index/rebuild", async (_request, reply) => {
  if (!repository.getDataSource().configured) {
    return reply.code(409).send({ message: "请先配置 SelectDB" });
  }
  return { status: valueIndexer.start() };
});

app.get("/api/value-index/status", async () => ({
  status: repository.getPropertyValueIndexStatus(),
}));

app.get("/api/value-index/properties", async () => {
  const ontology = repository.getPublishedOntology();
  const owners = new Map(
    ontology.objects.flatMap((object) =>
      object.properties.map((property) => [
        property.id,
        { object, property },
      ] as const),
    ),
  );
  const properties = repository
    .getIndexedPropertyStatuses(ontology.version)
    .flatMap((status): PropertyValueIndexProperty[] => {
      const owner = owners.get(status.propertyId);
      return owner
        ? [{
            ontologyVersion: status.ontologyVersion,
            objectId: owner.object.id,
            objectLabel: owner.object.label,
            propertyId: owner.property.id,
            propertyLabel: owner.property.label,
            sourceColumn: owner.property.sourceColumn,
            semanticMeaning: owner.property.meaning,
            status: status.status,
            distinctValues: status.distinctValues,
            coveredRows: status.coveredRows,
            updatedAt: status.updatedAt,
            error: status.error,
            topValues: status.topValues,
          }]
        : [];
    })
    .sort(
      (left, right) =>
        left.objectLabel.localeCompare(right.objectLabel, "zh-CN") ||
        left.propertyLabel.localeCompare(right.propertyLabel, "zh-CN"),
    );
  return { properties };
});

app.post<{ Body: { title?: string } }>("/api/conversations", async (request) => {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: createId("conv"),
    title: request.body?.title?.trim() || "新分析",
    createdAt: now,
    updatedAt: now,
    status: "active",
    turns: [],
  };
  repository.saveConversation(conversation);
  return conversation;
});

app.post<{ Params: { id: string }; Body: { question: string } }>(
  "/api/conversations/:id/turns",
  async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ message: "请输入分析问题" });
    try {
      return reply.code(202).send(agent.createTurn(request.params.id, question));
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : "无法创建分析任务",
      });
    }
  },
);

app.get<{ Querystring: { conversationId: string } }>("/api/events", async (request, reply) => {
  const conversationId = request.query.conversationId;
  if (!conversationId) return reply.code(400).send({ message: "缺少 conversationId" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  reply.raw.write(": connected\n\n");
  const unsubscribe = events.subscribe(conversationId, reply.raw);
  request.raw.on("close", unsubscribe);
});

app.post<{ Body: DataSourceInput }>("/api/data-source/test", async (request, reply) => {
  const parsed = dataSourceSchema.safeParse(request.body);
  if (!parsed.success || !parsed.data.password) {
    return reply.code(400).send({ message: "请填写完整连接信息与密码" });
  }
  try {
    return { ok: true, ...(await selectDb.test(parsed.data)) };
  } catch (error) {
    return reply.code(422).send({
      ok: false,
      message: error instanceof Error ? error.message : "连接测试失败",
    });
  }
});

app.put<{ Body: DataSourceInput }>("/api/data-source", async (request, reply) => {
  const parsed = dataSourceSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ message: "连接配置不完整" });
  const input = parsed.data;
  const existing = repository.getDataSource();
  const password = input.password || (await keychain.getPassword());
  if (!password) return reply.code(400).send({ message: "首次保存必须填写密码" });

  try {
    const tested = input.password
      ? await selectDb.test({ ...input, password })
      : { version: "使用已保存凭证" };
    if (input.password) await keychain.setPassword(input.password);
    const safe: SafeDataSourceConfig = {
      configured: true,
      host: input.host,
      port: input.port,
      username: input.username,
      catalog: input.catalog,
      database: input.database,
      tls: input.tls,
      passwordStored: Boolean(input.password) || existing.passwordStored,
      lastTestedAt: new Date().toISOString(),
      lastTestOk: true,
    };
    repository.saveDataSource(safe);
    await selectDb.configure(safe, password);
    return { config: safe, version: tested.version };
  } catch (error) {
    request.log.error({ err: error }, "Failed to persist SelectDB configuration");
    return reply.code(422).send({
      message: error instanceof Error ? error.message : "保存连接失败",
    });
  }
});

app.post("/api/schema/scan", async (_request, reply) => {
  const source = repository.getDataSource();
  const password = await keychain.getPassword();
  if (!source.configured || !source.database) {
    return reply.code(409).send({ message: "请先在数据管理中完成 SelectDB 配置" });
  }
  if (!password) {
    return reply.code(409).send({
      message:
        "SelectDB 连接参数已保存，但无法读取密码。请重新打开连接配置并保存密码后再扫描。",
    });
  }
  try {
    await selectDb.configure(source, password);
    return { tables: repository.upsertScannedTables(await selectDb.scanSchema(source.database)) };
  } catch (error) {
    return reply.code(422).send({
      message: error instanceof Error ? error.message : "Schema 扫描失败",
    });
  }
});

app.post<{ Body: { tableIds: string[] } }>("/api/ontology/drafts", async (request, reply) => {
  const ids = request.body?.tableIds ?? [];
  const selected = repository
    .getTables()
    .filter((table) => ids.includes(table.id) && table.status === "UNMODELED");
  if (!selected.length) {
    return reply.code(400).send({ message: "请选择尚未建模的表" });
  }

  const base =
    repository.getDraftOntology() ??
    createDraftFromPublished(repository.getPublishedOntology());
  const draft = addTablesToDraft(base, selected);
  repository.saveOntology(draft);
  repository.updateTableStatuses(
    selected.map((table) => table.id),
    "DRAFTING",
  );
  return { ontology: draft, tables: repository.getTables() };
});

app.post("/api/ontology/draft", async () => {
  const draft =
    repository.getDraftOntology() ??
    createDraftFromPublished(repository.getPublishedOntology());
  repository.saveOntology(draft);
  return { ontology: draft };
});

app.put<{ Params: { id: string }; Body: unknown }>(
  "/api/ontology/draft/objects/:id",
  async (request, reply) => {
    const draft = repository.getDraftOntology();
    if (!draft) {
      return reply.code(409).send({ message: "请先创建编辑草稿" });
    }
    const parsed = objectEditSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message || "对象配置不完整",
      });
    }
    try {
      const updated = applyObjectEdit(draft, request.params.id, parsed.data);
      repository.saveOntology(updated);
      return {
        ontology: updated,
        validation: validateOntology(updated, repository.getTables()),
      };
    } catch (error) {
      return reply.code(422).send({
        message: error instanceof Error ? error.message : "保存对象失败",
      });
    }
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/ontology/draft/objects/:id",
  async (request, reply) => {
    const draft = repository.getDraftOntology();
    if (!draft) {
      return reply.code(409).send({ message: "请先创建编辑草稿" });
    }
    try {
      const removed = removeObjectFromDraft(draft, request.params.id);
      repository.saveOntology(removed.ontology);
      repository.updateTableStatuses([removed.sourceTableId], "UNMODELED");
      return {
        ontology: removed.ontology,
        tables: repository.getTables(),
        validation: validateOntology(
          removed.ontology,
          repository.getTables(),
        ),
      };
    } catch (error) {
      return reply.code(422).send({
        message: error instanceof Error ? error.message : "删除对象失败",
      });
    }
  },
);

app.post("/api/ontology/draft/validate", async (_request, reply) => {
  const draft = repository.getDraftOntology();
  if (!draft) return reply.code(409).send({ message: "当前没有本体草稿" });
  return validateOntology(draft, repository.getTables());
});

app.delete("/api/ontology/draft", async (_request, reply) => {
  const draft = repository.getDraftOntology();
  if (!draft) return reply.code(409).send({ message: "当前没有本体草稿" });
  const published = repository.getPublishedOntology();
  repository.deleteDraftOntology();
  const draftingIds = repository
    .getTables()
    .filter((table) => table.status === "DRAFTING")
    .map((table) => table.id);
  repository.updateTableStatuses(draftingIds, "UNMODELED");
  repository.updateTableStatuses(
    published.objects.map((object) => object.sourceTableId),
    "MODELED",
  );
  return {
    ontology: published,
    tables: repository.getTables(),
  };
});

app.post("/api/ontology/publish", async (_request, reply) => {
  const current = repository.getDraftOntology();
  if (!current) {
    return reply.code(409).send({ message: "当前没有待发布的本体草稿" });
  }
  const validation = validateOntology(current, repository.getTables());
  if (!validation.valid) {
    return reply.code(422).send({
      message: `发布校验失败：${validation.issues.find((issue) => issue.level === "ERROR")?.message}`,
      validation,
    });
  }
  const published = publishDraft(current);
  repository.saveOntology(published);
  repository.updateTableStatuses(
    published.objects.map((object) => object.sourceTableId),
    "MODELED",
  );
  const valueIndex = repository.getDataSource().configured
    ? valueIndexer.start(published)
    : {
        ontologyVersion: published.version,
        status: "idle" as const,
        indexedProperties: 0,
        indexedValues: 0,
        partialProperties: 0,
        failedProperties: 0,
        updatedAt: new Date().toISOString(),
      };
  repository.savePropertyValueIndexStatus(valueIndex);
  return {
    ontology: published,
    tables: repository.getTables(),
    validation,
    valueIndex,
  };
});

const webRoot = path.resolve("dist/web");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      return reply.code(404).send({ message: "API 不存在" });
    }
    return reply.sendFile("index.html");
  });
}

async function shutdown(): Promise<void> {
  await harness.close();
  await selectDb.close();
  repository.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ port: config.port, host: "127.0.0.1" });
