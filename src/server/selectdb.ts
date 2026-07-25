import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { DataSourceInput, PhysicalTable, SafeDataSourceConfig } from "../shared/types.js";
import { createId } from "./id.js";
import { guardReadOnlySql } from "./sql-guard.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  durationMs: number;
  truncated: boolean;
}

export class SelectDbClient {
  private pool: Pool | null = null;

  async configure(config: SafeDataSourceConfig, password: string): Promise<void> {
    await this.close();
    this.pool = mysql.createPool({
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

  async query(sql: string, timeoutMs = 180_000, maxRows = 10_000): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error("SelectDB 尚未连接");
    }

    const guarded = guardReadOnlySql(sql, maxRows);
    const startedAt = performance.now();
    const [rows, fields] = await this.pool.query({
      sql: guarded.sql,
      timeout: timeoutMs,
      rowsAsArray: false,
    });
    const records = rows as RowDataPacket[];

    return {
      columns: fields.map((field) => field.name),
      rows: records.map((row) => ({ ...row })),
      durationMs: Math.round(performance.now() - startedAt),
      truncated: records.length >= maxRows,
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

function isSensitiveColumn(name: string): boolean {
  return /(^|_)(phone|mobile|email|address|id_card|identity|password|secret|token)(_|$)/i.test(
    name,
  );
}
