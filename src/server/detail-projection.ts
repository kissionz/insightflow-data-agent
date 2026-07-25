import type { OntologySnapshot, PhysicalTable } from "../shared/types.js";

export function appendDetailOnlyProperties(
  sql: string,
  ontology: OntologySnapshot,
  tables: PhysicalTable[],
): string {
  if (!/^\s*select\b/i.test(sql) || /\bgroup\s+by\b/i.test(sql)) return sql;
  if (/\b(sum|count|avg|min|max)\s*\(/i.test(sql)) return sql;
  const selectMatch = sql.match(/^\s*select\s+([\s\S]+?)\s+from\s+/i);
  if (!selectMatch || selectMatch[1].trim() === "*") return sql;

  const candidates = ontology.objects
    .map((object) => ({
      object,
      table: tables.find((table) => table.id === object.sourceTableId),
    }))
    .filter(
      (entry): entry is typeof entry & { table: PhysicalTable } =>
        Boolean(entry.table) &&
        new RegExp(`\\b${escapeRegex(entry.table!.name)}\\b`, "i").test(sql),
    );
  if (candidates.length !== 1) return sql;

  const { object, table } = candidates[0];
  const detailProperties = object.properties
    .filter(
      (property) =>
        property.visibility === "DETAIL_ONLY" && property.defaultDisplay,
    )
    .sort((left, right) => (left.detailOrder ?? 0) - (right.detailOrder ?? 0));
  if (!detailProperties.length) return sql;

  const fromMatch = sql.match(
    new RegExp(
      "\\bfrom\\s+(?:`[^`]+`\\.)?`?" +
        escapeRegex(table.name) +
        "`?(?:\\s+(?:as\\s+)?(?!(?:where|join|left|right|inner|outer|limit|order|group)\\b)([A-Za-z_][\\w]*))?",
      "i",
    ),
  );
  const alias = fromMatch?.[1];
  const qualifier = quoteIdentifier(alias || table.name);
  const additions = detailProperties
    .filter(
      (property) =>
        !new RegExp(`\\b${escapeRegex(property.sourceColumn)}\\b`, "i").test(
          selectMatch[1],
        ),
    )
    .map(
      (property) =>
        `${qualifier}.${quoteIdentifier(property.sourceColumn)} AS ${quoteIdentifier(property.label)}`,
    );
  if (!additions.length) return sql;

  const selectEnd = selectMatch.index! + selectMatch[0].length;
  const fromStart = selectEnd - "from ".length;
  return `${sql.slice(0, fromStart).trimEnd()}, ${additions.join(", ")} ${sql.slice(fromStart)}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}
