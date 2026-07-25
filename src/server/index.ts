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
  SafeDataSourceConfig,
} from "../shared/types.js";
import { DataAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import { DataAgentHarness } from "./harness.js";
import { createId } from "./id.js";
import { credentialStoreKind, KeychainStore } from "./keychain.js";
import { Repository } from "./repository.js";
import { SelectDbClient } from "./selectdb.js";

const config = loadConfig();
const repository = new Repository(config.databasePath);
const events = new EventHub();
const keychain = new KeychainStore(config.workspaceRoot, config.stateRoot);
const selectDb = new SelectDbClient();
const harness = new DataAgentHarness(
  config.workspaceRoot,
  repository,
  async (sql, maxRows) => {
    const source = repository.getDataSource();
    const password = await keychain.getPassword();
    if (!source.configured || !password) throw new Error("SelectDB 凭证不可用");
    await selectDb.configure(source, password);
    return selectDb.query(sql, 180_000, maxRows);
  },
);
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

app.get("/api/health", async () => ({ ok: true, version: "0.1.0" }));

app.get("/api/bootstrap", async () => {
  const dataSource = repository.getDataSource();
  const modelConfigured = Boolean(
    process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL,
  );
  return {
    conversations: repository.getConversations(),
    ontology: repository.getOntology(),
    tables: repository.getTables(),
    dataSource,
    runtime: {
      modelConfigured,
      analysisReady: Boolean(dataSource.configured && modelConfigured),
      credentialStore: credentialStoreKind(),
    },
  };
});

app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
  const conversation = repository.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ message: "会话不存在" });
  return conversation;
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
    return reply.code(422).send({
      message: error instanceof Error ? error.message : "保存连接失败",
    });
  }
});

app.post("/api/schema/scan", async (_request, reply) => {
  const source = repository.getDataSource();
  const password = await keychain.getPassword();
  if (!source.configured || !source.database || !password) {
    return reply.code(409).send({ message: "请先在数据管理中完成 SelectDB 配置" });
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

  const current = repository.getOntology();
  const draft: OntologySnapshot = {
    ...structuredClone(current),
    version: current.version + 1,
    status: "DRAFT",
    publishedAt: undefined,
    objects: [
      ...current.objects,
      ...selected.map<OntologyObject>((table) => ({
        id: createId("object"),
        name: table.name.replace(/^(dim|fact)_/, "").replace(/s$/, ""),
        label: table.description?.replace(/表$/, "") || table.name,
        description: `基于 ${table.database}.${table.name} 自动生成的本体草稿`,
        sourceTableId: table.id,
        status: "DRAFT",
        synonyms: [],
        properties: table.columns.map((column) => ({
          id: createId("property"),
          name: column.name,
          label: column.comment || column.name,
          dataType: column.dataType,
          sourceColumn: column.name,
          sensitive: column.sensitive,
        })),
      })),
    ],
  };
  repository.saveOntology(draft);
  repository.updateTableStatuses(
    selected.map((table) => table.id),
    "DRAFTING",
  );
  return { ontology: draft, tables: repository.getTables() };
});

app.post("/api/ontology/publish", async (_request, reply) => {
  const current = repository.getOntology();
  if (current.status !== "DRAFT") {
    return reply.code(409).send({ message: "当前没有待发布的本体草稿" });
  }
  const published: OntologySnapshot = {
    ...current,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
    objects: current.objects.map((object) => ({
      ...object,
      status: object.status === "DRAFT" ? "PUBLISHED" : object.status,
    })),
    relations: current.relations.map((relation) => ({
      ...relation,
      status: relation.status === "DRAFT" ? "PUBLISHED" : relation.status,
    })),
    metrics: current.metrics.map((metric) => ({
      ...metric,
      status: metric.status === "DRAFT" ? "PUBLISHED" : metric.status,
    })),
  };
  repository.saveOntology(published);
  const draftingIds = repository
    .getTables()
    .filter((table) => table.status === "DRAFTING")
    .map((table) => table.id);
  repository.updateTableStatuses(draftingIds, "MODELED");
  return { ontology: published, tables: repository.getTables() };
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
