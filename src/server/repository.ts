import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Conversation,
  OntologySnapshot,
  PhysicalTable,
  SafeDataSourceConfig,
  Turn,
} from "../shared/types.js";

interface JsonRow {
  payload: string;
}

export class Repository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
    this.initialize();
    this.removeLegacyDemoFixtures();
  }

  getConversations(): Conversation[] {
    return this.db
      .prepare("SELECT payload FROM conversations ORDER BY updated_at DESC")
      .all()
      .map((row) => JSON.parse((row as unknown as JsonRow).payload) as Conversation);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT payload FROM conversations WHERE id = ?")
      .get(id) as unknown as JsonRow | undefined;
    return row ? (JSON.parse(row.payload) as Conversation) : null;
  }

  saveConversation(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, updated_at, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at,
           payload = excluded.payload`,
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.updatedAt,
        JSON.stringify(conversation),
      );
  }

  saveTurn(turn: Turn): Conversation {
    const conversation = this.getConversation(turn.conversationId);
    if (!conversation) throw new Error("会话不存在");
    const index = conversation.turns.findIndex((item) => item.id === turn.id);
    if (index >= 0) conversation.turns[index] = turn;
    else conversation.turns.push(turn);
    conversation.updatedAt = new Date().toISOString();
    this.saveConversation(conversation);
    return conversation;
  }

  getOntology(): OntologySnapshot {
    const row = this.db
      .prepare("SELECT payload FROM ontology_versions ORDER BY version DESC LIMIT 1")
      .get() as unknown as JsonRow;
    return JSON.parse(row.payload) as OntologySnapshot;
  }

  saveOntology(snapshot: OntologySnapshot): void {
    this.db
      .prepare(
        `INSERT INTO ontology_versions (version, status, created_at, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET status = excluded.status, payload = excluded.payload`,
      )
      .run(snapshot.version, snapshot.status, new Date().toISOString(), JSON.stringify(snapshot));
  }

  getTables(): PhysicalTable[] {
    return this.db
      .prepare("SELECT payload FROM physical_tables ORDER BY name")
      .all()
      .map((row) => JSON.parse((row as unknown as JsonRow).payload) as PhysicalTable);
  }

  upsertScannedTables(scanned: PhysicalTable[]): PhysicalTable[] {
    const existing = new Map(this.getTables().map((table) => [`${table.database}.${table.name}`, table]));
    const seen = new Set<string>();

    for (const table of scanned) {
      const key = `${table.database}.${table.name}`;
      seen.add(key);
      const previous = existing.get(key);
      const status: PhysicalTable["status"] = previous
        ? previous.fingerprint === table.fingerprint
          ? previous.status
          : previous.status === "MODELED"
            ? "CHANGED"
            : "UNMODELED"
        : "UNMODELED";
      this.saveTable({ ...table, id: previous?.id ?? table.id, status });
    }

    for (const [key, table] of existing) {
      if (!seen.has(key)) this.saveTable({ ...table, status: "REMOVED" });
    }
    return this.getTables();
  }

  updateTableStatuses(ids: string[], status: PhysicalTable["status"]): PhysicalTable[] {
    for (const table of this.getTables()) {
      if (ids.includes(table.id)) this.saveTable({ ...table, status });
    }
    return this.getTables();
  }

  getDataSource(): SafeDataSourceConfig {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'data_source'")
      .get() as { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as SafeDataSourceConfig)
      : { configured: false, passwordStored: false };
  }

  saveDataSource(config: SafeDataSourceConfig): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('data_source', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(config));
  }

  close(): void {
    this.db.close();
  }

  private saveTable(table: PhysicalTable): void {
    this.db
      .prepare(
        `INSERT INTO physical_tables (id, database_name, name, status, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           database_name = excluded.database_name,
           name = excluded.name,
           status = excluded.status,
           payload = excluded.payload`,
      )
      .run(table.id, table.database, table.name, table.status, JSON.stringify(table));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS physical_tables (
        id TEXT PRIMARY KEY,
        database_name TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(database_name, name)
      );
      CREATE TABLE IF NOT EXISTS ontology_versions (
        version INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  private initialize(): void {
    const ontologyCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM ontology_versions").get() as {
        count: number;
      }
    ).count;
    if (ontologyCount === 0) this.saveOntology(emptyOntology());
  }

  private removeLegacyDemoFixtures(): void {
    const demoObjectIds = new Set(["o_order", "o_customer", "o_product", "o_store"]);
    const ontology = this.getOntology();
    const isUntouchedDemoOntology =
      ontology.version === 4 &&
      ontology.objects.length === demoObjectIds.size &&
      ontology.objects.every((object) => demoObjectIds.has(object.id)) &&
      ontology.publishedAt === "2026-07-25T02:18:00.000Z";
    if (isUntouchedDemoOntology) {
      this.db.prepare("DELETE FROM ontology_versions").run();
      this.saveOntology(emptyOntology());
    }

    const demoTableIds = new Set([
      "t_orders",
      "t_customers",
      "t_products",
      "t_stores",
      "t_order_items",
      "t_campaigns",
      "t_refunds",
    ]);
    const tables = this.getTables();
    const isUntouchedDemoCatalog =
      tables.length === demoTableIds.size &&
      tables.every(
        (table) =>
          demoTableIds.has(table.id) &&
          table.scannedAt === "2026-07-25T02:18:00.000Z" &&
          table.fingerprint === `${table.name}:v1`,
      );
    if (isUntouchedDemoCatalog) {
      this.db.prepare("DELETE FROM physical_tables").run();
    }

    const demoConversation = this.getConversation("conv_demo");
    if (demoConversation) {
      const userTurns = demoConversation.turns.filter((turn) => turn.id !== "turn_demo");
      if (userTurns.length === 0) {
        this.db.prepare("DELETE FROM conversations WHERE id = ?").run("conv_demo");
      } else if (userTurns.length !== demoConversation.turns.length) {
        this.saveConversation({
          ...demoConversation,
          title: "新分析",
          turns: userTurns,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
}

function emptyOntology(): OntologySnapshot {
  return {
    version: 0,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
    objects: [],
    relations: [],
    metrics: [],
  };
}
