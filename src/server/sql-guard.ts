export interface GuardedSql {
  sql: string;
  injectedLimit: boolean;
}

const FORBIDDEN =
  /\b(insert|update|delete|replace|merge|create|alter|drop|truncate|grant|revoke|call|execute|load|outfile|dumpfile|lock|unlock|set|use)\b/i;

export function guardReadOnlySql(input: string, maxRows = 10_000): GuardedSql {
  const trimmed = input.trim().replace(/;+\s*$/, "");

  if (!trimmed) {
    throw new Error("SQL 不能为空");
  }
  if (trimmed.includes(";")) {
    throw new Error("不允许执行多条 SQL");
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("只允许 SELECT 或 WITH ... SELECT 查询");
  }
  if (FORBIDDEN.test(stripCommentsAndStrings(trimmed))) {
    throw new Error("SQL 包含非只读关键字");
  }

  const limitPattern = /\blimit\s+(\d+)(?:\s*,\s*(\d+))?\s*$/i;
  const matched = trimmed.match(limitPattern);
  if (matched) {
    const first = Number(matched[1]);
    const second = matched[2] ? Number(matched[2]) : null;
    const count = second ?? first;
    if (count <= maxRows) {
      return { sql: trimmed, injectedLimit: false };
    }

    const replacement = second ? `LIMIT ${first}, ${maxRows}` : `LIMIT ${maxRows}`;
    return {
      sql: trimmed.replace(limitPattern, replacement),
      injectedLimit: false,
    };
  }

  return { sql: `${trimmed}\nLIMIT ${maxRows}`, injectedLimit: true };
}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|\\'|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}
