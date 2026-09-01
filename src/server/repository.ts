import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentPromptConfig,
  CanvasItem,
  Conversation,
  NumericPropertySpec,
  OntologyObjectType,
  OntologyProperty,
  OntologySnapshot,
  PhysicalTable,
  PropertyValueIndexStatus,
  SafeDataSourceConfig,
  Turn,
} from "../shared/types.js";

interface JsonRow {
  payload: string;
}

export interface CachedPropertyValue {
  ontologyVersion: number;
  objectId: string;
  propertyId: string;
  normalizedValue: string;
  displayValue: string;
  updatedAt: string;
}

export interface IndexedPropertyValue extends CachedPropertyValue {
  frequency: number;
}

export interface IndexedPropertyStatus {
  ontologyVersion: number;
  objectId: string;
  propertyId: string;
  status: "ready" | "partial" | "empty" | "failed";
  distinctValues: number;
  coveredRows: number;
  updatedAt: string;
  error?: string;
  topValues: Array<{
    value: string;
    frequency: number;
  }>;
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

  getCanvasItems(): CanvasItem[] {
    return this.db
      .prepare(
        "SELECT payload FROM canvas_items ORDER BY position, created_at",
      )
      .all()
      .map((row) => JSON.parse((row as unknown as JsonRow).payload) as CanvasItem);
  }

  getCanvasItem(id: string): CanvasItem | null {
    const row = this.db
      .prepare("SELECT payload FROM canvas_items WHERE id = ?")
      .get(id) as unknown as JsonRow | undefined;
    return row ? (JSON.parse(row.payload) as CanvasItem) : null;
  }

  saveCanvasItem(item: CanvasItem): void {
    this.db
      .prepare(
        `INSERT INTO canvas_items
           (id, source_turn_id, title, position, created_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           position = excluded.position,
           updated_at = excluded.updated_at,
           payload = excluded.payload`,
      )
      .run(
        item.id,
        item.sourceTurnId,
        item.title,
        item.position,
        item.createdAt,
        item.updatedAt,
        JSON.stringify(item),
      );
  }

  deleteCanvasItem(id: string): boolean {
    return this.db.prepare("DELETE FROM canvas_items WHERE id = ?").run(id)
      .changes > 0;
  }

  getOntology(): OntologySnapshot {
    return this.getPublishedOntology();
  }

  getPublishedOntology(): OntologySnapshot {
    const row = this.db
      .prepare(
        "SELECT payload FROM ontology_versions WHERE status = 'PUBLISHED' ORDER BY version DESC LIMIT 1",
      )
      .get() as unknown as JsonRow;
    return normalizeOntology(JSON.parse(row.payload) as OntologySnapshot);
  }

  getDraftOntology(): OntologySnapshot | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM ontology_versions WHERE status = 'DRAFT' ORDER BY version DESC LIMIT 1",
      )
      .get() as unknown as JsonRow | undefined;
    return row ? normalizeOntology(JSON.parse(row.payload) as OntologySnapshot) : null;
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

  findCachedPropertyValues(
    ontologyVersion: number,
    normalizedValue: string,
    propertyIds: string[],
  ): CachedPropertyValue[] {
    if (!propertyIds.length) return [];
    const placeholders = propertyIds.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT ontology_version, object_id, property_id, normalized_value,
                display_value, updated_at
           FROM property_value_cache
          WHERE ontology_version = ?
            AND normalized_value = ?
            AND property_id IN (${placeholders})
          ORDER BY updated_at DESC`,
      )
      .all(ontologyVersion, normalizedValue, ...propertyIds)
      .map((row) => {
        const value = row as {
          ontology_version: number;
          object_id: string;
          property_id: string;
          normalized_value: string;
          display_value: string;
          updated_at: string;
        };
        return {
          ontologyVersion: value.ontology_version,
          objectId: value.object_id,
          propertyId: value.property_id,
          normalizedValue: value.normalized_value,
          displayValue: value.display_value,
          updatedAt: value.updated_at,
        };
      });
  }

  cachePropertyValue(value: CachedPropertyValue): void {
    this.db
      .prepare(
        `INSERT INTO property_value_cache
           (ontology_version, object_id, property_id, normalized_value, display_value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ontology_version, property_id, normalized_value)
         DO UPDATE SET display_value = excluded.display_value, updated_at = excluded.updated_at`,
      )
      .run(
        value.ontologyVersion,
        value.objectId,
        value.propertyId,
        value.normalizedValue,
        value.displayValue,
        value.updatedAt,
      );
  }

  findIndexedPropertyValues(
    ontologyVersion: number,
    normalizedValue: string,
    propertyIds: string[],
    matchMode: "exact" | "prefix" = "exact",
  ): IndexedPropertyValue[] {
    if (!propertyIds.length) return [];
    const placeholders = propertyIds.map(() => "?").join(", ");
    const comparison =
      matchMode === "prefix"
        ? "normalized_value LIKE ? ESCAPE '\\'"
        : "normalized_value = ?";
    const lookupValue =
      matchMode === "prefix"
        ? `${escapeSqlLike(normalizedValue)}%`
        : normalizedValue;
    return this.db
      .prepare(
        `SELECT ontology_version, object_id, property_id, normalized_value,
                display_value, frequency, updated_at
           FROM property_value_index
          WHERE ontology_version = ?
            AND ${comparison}
            AND property_id IN (${placeholders})
          ORDER BY frequency DESC, display_value
          LIMIT 20`,
      )
      .all(ontologyVersion, lookupValue, ...propertyIds)
      .map((row) => {
        const value = row as {
          ontology_version: number;
          object_id: string;
          property_id: string;
          normalized_value: string;
          display_value: string;
          frequency: number;
          updated_at: string;
        };
        return {
          ontologyVersion: value.ontology_version,
          objectId: value.object_id,
          propertyId: value.property_id,
          normalizedValue: value.normalized_value,
          displayValue: value.display_value,
          frequency: value.frequency,
          updatedAt: value.updated_at,
        };
      });
  }

  replaceIndexedPropertyValues(
    ontologyVersion: number,
    objectId: string,
    propertyId: string,
    values: Array<{ displayValue: string; frequency: number }>,
  ): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM property_value_index
            WHERE ontology_version = ? AND property_id = ?`,
        )
        .run(ontologyVersion, propertyId);
      const statement = this.db.prepare(
        `INSERT INTO property_value_index
           (ontology_version, object_id, property_id, normalized_value,
            display_value, frequency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ontology_version, property_id, normalized_value)
         DO UPDATE SET
           display_value = excluded.display_value,
           frequency = MAX(property_value_index.frequency, excluded.frequency),
           updated_at = excluded.updated_at`,
      );
      for (const value of values) {
        const normalizedValue = normalizePropertyValue(value.displayValue);
        if (!normalizedValue) continue;
        statement.run(
          ontologyVersion,
          objectId,
          propertyId,
          normalizedValue,
          value.displayValue,
          value.frequency,
          now,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearIndexedPropertyStatuses(ontologyVersion: number): void {
    this.db
      .prepare(
        "DELETE FROM property_value_index_properties WHERE ontology_version = ?",
      )
      .run(ontologyVersion);
  }

  saveIndexedPropertyStatus(
    status: Omit<IndexedPropertyStatus, "topValues">,
  ): void {
    this.db
      .prepare(
        `INSERT INTO property_value_index_properties
           (ontology_version, object_id, property_id, status, distinct_values,
            covered_rows, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ontology_version, property_id)
         DO UPDATE SET
           object_id = excluded.object_id,
           status = excluded.status,
           distinct_values = excluded.distinct_values,
           covered_rows = excluded.covered_rows,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        status.ontologyVersion,
        status.objectId,
        status.propertyId,
        status.status,
        status.distinctValues,
        status.coveredRows,
        status.error ?? null,
        status.updatedAt,
      );
  }

  getIndexedPropertyStatuses(
    ontologyVersion: number,
  ): IndexedPropertyStatus[] {
    const statusRows = this.db
      .prepare(
        `SELECT ontology_version, object_id, property_id, status,
                distinct_values, covered_rows, error, updated_at
           FROM property_value_index_properties
          WHERE ontology_version = ?
          ORDER BY object_id, property_id`,
      )
      .all(ontologyVersion) as Array<{
        ontology_version: number;
        object_id: string;
        property_id: string;
        status: IndexedPropertyStatus["status"];
        distinct_values: number;
        covered_rows: number;
        error: string | null;
        updated_at: string;
      }>;
    const knownPropertyIds = new Set(
      statusRows.map((row) => row.property_id),
    );
    const legacyRows = this.db
      .prepare(
        `SELECT ontology_version, object_id, property_id,
                COUNT(*) AS distinct_values,
                COALESCE(SUM(frequency), 0) AS covered_rows,
                MAX(updated_at) AS updated_at
           FROM property_value_index
          WHERE ontology_version = ?
          GROUP BY ontology_version, object_id, property_id
          ORDER BY object_id, property_id`,
      )
      .all(ontologyVersion) as Array<{
        ontology_version: number;
        object_id: string;
        property_id: string;
        distinct_values: number;
        covered_rows: number;
        updated_at: string;
      }>;
    const rows = [
      ...statusRows,
      ...legacyRows
        .filter((row) => !knownPropertyIds.has(row.property_id))
        .map((row) => ({
          ...row,
          status: "ready" as const,
          error: null,
        })),
    ];
    const topValues = this.db.prepare(
      `SELECT display_value, frequency
         FROM property_value_index
        WHERE ontology_version = ? AND property_id = ?
        ORDER BY frequency DESC, display_value
        LIMIT 8`,
    );
    return rows.map((row) => ({
      ontologyVersion: row.ontology_version,
      objectId: row.object_id,
      propertyId: row.property_id,
      status: row.status,
      distinctValues: row.distinct_values,
      coveredRows: row.covered_rows,
      updatedAt: row.updated_at,
      error: row.error ?? undefined,
      topValues: (
        topValues.all(ontologyVersion, row.property_id) as Array<{
          display_value: string;
          frequency: number;
        }>
      ).map((value) => ({
        value: value.display_value,
        frequency: value.frequency,
      })),
    }));
  }

  getAgentConfig(): AgentPromptConfig {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'agent_config'")
      .get() as { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as AgentPromptConfig)
      : defaultAgentConfig();
  }

  saveAgentConfig(
    input: Pick<AgentPromptConfig, "businessInstructions" | "timezone">,
  ): AgentPromptConfig {
    const previous = this.getAgentConfig();
    const config: AgentPromptConfig = {
      version: previous.version + 1,
      businessInstructions: input.businessInstructions.trim(),
      timezone: input.timezone,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('agent_config', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(config));
    return config;
  }

  getPropertyValueIndexStatus(): PropertyValueIndexStatus {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'property_value_index_status'")
      .get() as { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as PropertyValueIndexStatus)
      : {
          ontologyVersion: this.getPublishedOntology().version,
          status: "idle",
          indexedProperties: 0,
          indexedValues: 0,
          partialProperties: 0,
          failedProperties: 0,
        };
  }

  savePropertyValueIndexStatus(status: PropertyValueIndexStatus): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value)
         VALUES ('property_value_index_status', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(status));
  }

  deleteDraftOntology(): void {
    this.db.prepare("DELETE FROM ontology_versions WHERE status = 'DRAFT'").run();
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
      CREATE TABLE IF NOT EXISTS canvas_items (
        id TEXT PRIMARY KEY,
        source_turn_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_items_position
        ON canvas_items (position, created_at);
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
      CREATE TABLE IF NOT EXISTS property_value_cache (
        ontology_version INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ontology_version, property_id, normalized_value)
      );
      CREATE INDEX IF NOT EXISTS property_value_cache_lookup
        ON property_value_cache (ontology_version, normalized_value);
      CREATE TABLE IF NOT EXISTS property_value_index (
        ontology_version INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        display_value TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ontology_version, property_id, normalized_value)
      );
      CREATE INDEX IF NOT EXISTS property_value_index_lookup
        ON property_value_index (ontology_version, normalized_value);
      CREATE TABLE IF NOT EXISTS property_value_index_properties (
        ontology_version INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        property_id TEXT NOT NULL,
        status TEXT NOT NULL,
        distinct_values INTEGER NOT NULL DEFAULT 0,
        covered_rows INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ontology_version, property_id)
      );
      CREATE INDEX IF NOT EXISTS property_value_index_properties_version
        ON property_value_index_properties (ontology_version, status);
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
    const ontology = this.getPublishedOntology();
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

function defaultAgentConfig(): AgentPromptConfig {
  return {
    version: 1,
    businessInstructions: "",
    timezone: "Asia/Shanghai",
    updatedAt: new Date().toISOString(),
  };
}

function normalizePropertyValue(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

function escapeSqlLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function emptyOntology(): OntologySnapshot {
  return {
    schemaVersion: 2,
    version: 0,
    status: "PUBLISHED",
    publishedAt: new Date().toISOString(),
    objects: [],
    relations: [],
    metrics: [],
    dimensionHierarchies: [],
  };
}

type LegacySemanticType =
  | "IDENTIFIER"
  | "DIMENSION"
  | "ENUM"
  | "TIME"
  | "GEOGRAPHY"
  | "AMOUNT"
  | "QUANTITY"
  | "BOOLEAN";
type LegacyIdentityRole = "NONE" | "OBJECT_IDENTIFIER" | "BUSINESS_KEY";
type LegacyProperty = Partial<OntologyProperty> & {
  id: string;
  name: string;
  label: string;
  dataType: string;
  sourceColumn: string;
  sensitive: boolean;
  semanticType?: LegacySemanticType;
  identityRole?: LegacyIdentityRole;
};
type LegacySnapshot = Omit<OntologySnapshot, "schemaVersion" | "objects"> & {
  schemaVersion?: number;
  objects: Array<
    Omit<OntologySnapshot["objects"][number], "objectType" | "grainPropertyIds" | "properties"> & {
      objectType?: OntologyObjectType;
      grainPropertyIds?: string[];
      primaryKey?: string[];
      properties: LegacyProperty[];
    }
  >;
};

function normalizeOntology(input: OntologySnapshot): OntologySnapshot {
  const snapshot = input as unknown as LegacySnapshot;
  const outgoingRelationPropertyIds = new Set(
    snapshot.relations
      .map((relation) => relation.sourcePropertyId)
      .filter((id): id is string => Boolean(id)),
  );
  const targetRelationPropertyIds = new Set(
    snapshot.relations
      .map((relation) => relation.targetPropertyId)
      .filter((id): id is string => Boolean(id)),
  );
  return {
    ...snapshot,
    schemaVersion: 2,
    baseVersion:
      snapshot.baseVersion ??
      (snapshot.status === "DRAFT" ? Math.max(0, snapshot.version - 1) : undefined),
    objects: snapshot.objects.map((object) => {
      const legacyIdentifierIds = object.properties
        .filter(
          (property) =>
            property.identityRole === "OBJECT_IDENTIFIER" ||
            object.primaryKey?.includes(property.id),
        )
        .map((property) => property.id);
      const requiresIdentityReview = legacyIdentifierIds.length > 1;
      const chosenLegacyIdentifier = chooseLegacyIdentifier(
        object.name,
        object.properties,
        legacyIdentifierIds,
      );
      const objectType = object.objectType ?? inferObjectType(object.name);
      const properties = object.properties.map((legacyProperty, index) => {
        const property = { ...legacyProperty };
        const meaning =
          property.meaning ??
          migratePropertyMeaning(
            property,
            property.id === chosenLegacyIdentifier,
            outgoingRelationPropertyIds.has(property.id),
            targetRelationPropertyIds.has(property.id),
          );
        const normalized: OntologyProperty = {
          id: property.id,
          name: property.name,
          label: property.label,
          description: property.description ?? "",
          dataType: property.dataType,
          sourceColumn: property.sourceColumn,
          sensitive: property.sensitive,
          meaning,
          unique:
            meaning === "ID" ||
            property.unique === true ||
            property.identityRole === "BUSINESS_KEY",
          valueSearchable:
            !property.sensitive &&
            (property.visibility ?? "ANALYTICAL") === "ANALYTICAL" &&
            (property.valueSearchable ?? defaultValueSearchable(meaning)),
          numericSpec:
            meaning === "NUMBER"
              ? property.numericSpec ?? inferNumericSpec(property.name, property.semanticType)
              : undefined,
          visibility: property.visibility ?? "ANALYTICAL",
          synonyms: property.synonyms ?? [],
          format: property.format,
          detailOrder: property.detailOrder ?? index + 1,
          defaultDisplay: property.defaultDisplay ?? true,
          exportable: property.exportable ?? true,
          nullDisplay: property.nullDisplay,
          bindingPriority: property.bindingPriority ?? 50,
        };
        return normalized;
      });
      const idProperty = properties.find((property) => property.meaning === "ID");
      const { primaryKey: _legacyPrimaryKey, properties: _legacyProperties, ...currentObject } =
        object;
      return {
        ...currentObject,
        objectType,
        identityReviewRequired:
          object.identityReviewRequired ??
          (requiresIdentityReview ? true : undefined),
        grain: object.grain ?? "",
        grainPropertyIds:
          object.grainPropertyIds?.filter((id) =>
            properties.some((property) => property.id === id),
          ) ?? (idProperty ? [idProperty.id] : []),
        exampleQuestions: object.exampleQuestions ?? [],
        bindingPriority: object.bindingPriority ?? 50,
        properties,
      };
    }),
    relations: snapshot.relations.map((relation) => ({
      ...relation,
      direction: relation.direction ?? "BIDIRECTIONAL",
      composition:
        relation.type === "COMPOSITION"
          ? relation.composition ?? {
              childObjectId: relation.sourceObjectId,
              parentObjectId: relation.targetObjectId,
              ownership: "OWNED",
              aggregationPolicy: "PRE_AGGREGATE_CHILD",
            }
          : undefined,
      required: relation.required ?? false,
      enabled: relation.enabled ?? true,
    })),
    metrics: snapshot.metrics.map((metric) => ({
      ...metric,
      metricType: metric.metricType ?? "BASE",
      definitionMode: metric.definitionMode ?? "SQL",
    })),
    dimensionHierarchies: (snapshot.dimensionHierarchies ?? []).map(
      (hierarchy) => ({
        ...hierarchy,
        kind: hierarchy.kind ?? "FIXED_LEVELS",
        levels: hierarchy.levels ?? [],
      }),
    ),
  };
}

function chooseLegacyIdentifier(
  objectName: string,
  properties: LegacyProperty[],
  ids: string[],
): string | undefined {
  if (ids.length <= 1) return ids[0];
  const normalizedObject = objectName.replace(/^(dim|fact|agg)_/, "").replace(/s$/, "");
  return (
    properties.find(
      (property) =>
        ids.includes(property.id) &&
        (property.name === "id" || property.name === `${normalizedObject}_id`),
    )?.id ?? ids[0]
  );
}

function migratePropertyMeaning(
  property: LegacyProperty,
  isObjectId: boolean,
  isRelationSource: boolean,
  isRelationTarget: boolean,
): OntologyProperty["meaning"] {
  if (isObjectId || (isRelationTarget && property.identityRole === "OBJECT_IDENTIFIER")) {
    return "ID";
  }
  if (isRelationSource) return "ENTITY_REFERENCE";
  if (property.identityRole === "BUSINESS_KEY") return "CODE";
  const normalized = property.name.toLowerCase();
  switch (property.semanticType) {
    case "ENUM":
      return "CATEGORY";
    case "TIME":
      return "TIME";
    case "GEOGRAPHY":
      return "GEOGRAPHY";
    case "AMOUNT":
    case "QUANTITY":
      return "NUMBER";
    case "BOOLEAN":
      return "BOOLEAN";
    case "IDENTIFIER":
      return "CODE";
    default:
      if (/(name|title|label|名称|姓名)/i.test(normalized)) return "NAME";
      if (/(status|type|category|level|class|状态|类型|等级|分类)/i.test(normalized)) {
        return "CATEGORY";
      }
      if (isNumericDataType(property.dataType)) return "NUMBER";
      return "TEXT";
  }
}

function inferObjectType(name: string): OntologyObjectType {
  const normalized = name.toLowerCase();
  if (/(snapshot|快照|balance)/.test(normalized)) return "SNAPSHOT";
  if (/(^|_)(agg|summary|stat|report)(_|$)|汇总|统计/.test(normalized)) {
    return "AGGREGATE";
  }
  if (/(^|_)(bridge|mapping|relation|link)(_|$)|关联/.test(normalized)) {
    return "RELATIONSHIP";
  }
  if (/(^|_)(fact|event|order|payment|transaction|detail|log)(_|$)|订单|支付|交易|明细|事件/.test(normalized)) {
    return "EVENT";
  }
  return "ENTITY";
}

function inferNumericSpec(
  name: string,
  legacyType?: LegacySemanticType,
): NumericPropertySpec {
  const normalized = name.toLowerCase();
  if (
    legacyType === "AMOUNT" ||
    /(amount|price|fee|cost|revenue|income|gmv|金额|价格|费用|收入)/.test(normalized)
  ) {
    return {
      kind: "CURRENCY",
      currency: "CNY",
      defaultAggregation: /(price|单价)/.test(normalized) ? "AVG" : "SUM",
      aggregationBehavior: /(price|单价)/.test(normalized)
        ? "NON_ADDITIVE"
        : "ADDITIVE",
    };
  }
  if (/(rate|ratio|percent|pct|score_rate|率|比例|占比)/.test(normalized)) {
    return {
      kind: "RATIO",
      unit: "%",
      defaultAggregation: "AVG",
      aggregationBehavior: "NON_ADDITIVE",
    };
  }
  return {
    kind: "GENERAL",
    defaultAggregation: legacyType === "QUANTITY" ? "SUM" : "NONE",
    aggregationBehavior:
      legacyType === "QUANTITY" ? "ADDITIVE" : "NON_ADDITIVE",
  };
}

function defaultValueSearchable(meaning: OntologyProperty["meaning"]): boolean {
  return ["CODE", "NAME", "CATEGORY", "BOOLEAN", "GEOGRAPHY"].includes(meaning);
}

function isNumericDataType(dataType: string): boolean {
  return /int|decimal|numeric|float|double|real/i.test(dataType);
}
