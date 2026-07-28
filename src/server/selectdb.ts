import { createHash } from "node:crypto";
import mysql, {
  type Pool,
  type PoolOptions,
  type RowDataPacket,
} from "mysql2/promise";
import type { DataSourceInput, PhysicalTable, SafeDataSourceConfig } from "../shared/types.js";
import { createId } from "./id.js";
import { guardReadOnlySql } from "./sql-guard.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  durationMs: number;
  truncated: boolean;
}

type PoolFactory = (options: PoolOptions) => Pool;

export class SelectDbClient {
  private pool: Pool | null = null;
  private poolFingerprint: string | null = null;
  private configuring: Promise<void> | null = null;

  constructor(
    private readonly createPool: PoolFactory = (options) =>
      mysql.createPool(options),
  ) {}

  async configure(config: SafeDataSourceConfig, password: string): Promise<void> {
    const fingerprint = connectionFingerprint(config, password);
    if (this.pool && this.poolFingerprint === fingerprint) return;

    if (this.configuring) {
      await this.configuring;
      if (this.pool && this.poolFingerprint === fingerprint) return;
    }

    const configuring = this.replacePool(config, password, fingerprint);
    this.configuring = configuring;
    try {
      await configuring;
    } finally {
      if (this.configuring === configuring) this.configuring = null;
    }
  }

  private async replacePool(
    config: SafeDataSourceConfig,
    password: string,
    fingerprint: string,
  ): Promise<void> {
    const nextPool = this.createPool({
      host: config.host,
      port: config.port,
      user: config.username,
      password,
      database: config.database,
      connectionLimit: 4,
      enableKeepAlive: true,
      connectTimeout: 10_000,
      decimalNumbers: true,
      timezone: "Z",
      ssl: config.tls ? {} : undefined,
    });
    const previousPool = this.pool;
    this.pool = nextPool;
    this.poolFingerprint = fingerprint;
    if (previousPool) await previousPool.end();
  }

  async test(config: DataSourceInput): Promise<{ version: string }> {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      connectTimeout: 10_000,
      decimalNumbers: true,
      ssl: config.tls ? {} : undefined,
    });
    try {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version");
      return { version: String(rows[0]?.version ?? "unknown") };
    } finally {
      await connection.end();
    }
  }

  async scanSchema(database: string): Promise<PhysicalTable[]> {
    if (!this.pool) {
      throw new Error("请先配置并连接 SelectDB");
    }

    const [[rows], [columns]] = await Promise.all([
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME`,
        [database],
      ),
      this.pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT,
                ORDINAL_POSITION
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [database],
      ),
    ]);
    const columnsByTable = new Map<string, PhysicalTable["columns"]>();
    for (const column of columns) {
      const tableName = String(column.TABLE_NAME);
      const list = columnsByTable.get(tableName) ?? [];
      list.push({
        name: String(column.COLUMN_NAME),
        dataType: String(column.DATA_TYPE).toUpperCase(),
        nullable: String(column.IS_NULLABLE).toUpperCase() === "YES",
        sensitive: isSensitiveColumn(String(column.COLUMN_NAME)),
        comment: column.COLUMN_COMMENT ? String(column.COLUMN_COMMENT) : undefined,
      });
      columnsByTable.set(tableName, list);
    }

    return rows.map((row) => ({
      id: createId("table"),
      catalog: "internal",
      database,
      name: String(row.TABLE_NAME),
      type: String(row.TABLE_TYPE).toUpperCase() === "VIEW" ? "VIEW" : "TABLE",
      description: row.TABLE_COMMENT ? String(row.TABLE_COMMENT) : undefined,
      status: "UNMODELED",
      columns: columnsByTable.get(String(row.TABLE_NAME)) ?? [],
      fingerprint: JSON.stringify([
        row.TABLE_NAME,
        row.TABLE_TYPE,
        ...(columnsByTable.get(String(row.TABLE_NAME)) ?? []).map((column) => [
          column.name,
          column.dataType,
          column.nullable,
        ]),
      ]),
      scannedAt: new Date().toISOString(),
    }));
  }

  async query(
    sql: string,
    timeoutMs = 180_000,
    maxRows = 10_000,
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error("SelectDB 尚未连接");
    }

    const guarded = guardReadOnlySql(sql, maxRows);
    const startedAt = performance.now();
    const execute = async () => {
      const pool = this.pool;
      if (!pool) throw new Error("SelectDB 尚未连接");
      return pool.query(
        {
          sql: guarded.sql,
          timeout: timeoutMs,
          rowsAsArray: false,
        },
        parameters,
      );
    };
    let response;
    try {
      response = await execute();
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      response = await execute();
    }
    const [rows, fields] = response;
    const records = rows as RowDataPacket[];

    return {
      columns: fields.map((field) => field.name),
      rows: records.map((row) => ({ ...row })),
      durationMs: Math.round(performance.now() - startedAt),
      truncated: records.length >= maxRows,
    };
  }

  async close(): Promise<void> {
    if (this.configuring) await this.configuring;
    const pool = this.pool;
    this.pool = null;
    this.poolFingerprint = null;
    if (pool) await pool.end();
  }
}

function connectionFingerprint(
  config: SafeDataSourceConfig,
  password: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.host,
        config.port,
        config.username,
        password,
        config.database,
        config.tls,
      ]),
    )
    .digest("hex");
}

function isSensitiveColumn(name: string): boolean {
  return /(^|_)(phone|mobile|email|address|id_card|identity|password|secret|token)(_|$)/i.test(
    name,
  );
}

function isRetryableConnectionError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EPIPE",
      "PROTOCOL_CONNECTION_LOST",
      "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
    ].includes(code) ||
    /closed state|connection.*closed|socket.*closed/i.test(message)
  );
}
