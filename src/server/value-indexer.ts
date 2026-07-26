import type {
  OntologySnapshot,
  PropertyValueIndexStatus,
} from "../shared/types.js";
import { Repository } from "./repository.js";
import type { QueryResult } from "./selectdb.js";

const MAX_VALUES_PER_PROPERTY = 5_000;
const INDEX_BATCH_SIZE = 3;

export class PropertyValueIndexer {
  private running: Promise<PropertyValueIndexStatus> | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly executeQuery: (
      sql: string,
      maxRows: number,
      parameters?: unknown[],
      timeoutMs?: number,
    ) => Promise<QueryResult>,
  ) {}

  start(
    ontology = this.repository.getPublishedOntology(),
  ): PropertyValueIndexStatus {
    if (this.running) return this.repository.getPropertyValueIndexStatus();
    const initial: PropertyValueIndexStatus = {
      ontologyVersion: ontology.version,
      status: "building",
      indexedProperties: 0,
      indexedValues: 0,
      partialProperties: 0,
      failedProperties: 0,
      updatedAt: new Date().toISOString(),
    };
    this.repository.savePropertyValueIndexStatus(initial);
    this.running = this.rebuild(ontology).finally(() => {
      this.running = null;
    });
    return initial;
  }

  async wait(): Promise<PropertyValueIndexStatus> {
    return this.running ?? this.repository.getPropertyValueIndexStatus();
  }

  private async rebuild(
    ontology: OntologySnapshot,
  ): Promise<PropertyValueIndexStatus> {
    const tables = new Map(
      this.repository.getTables().map((table) => [table.id, table]),
    );
    const candidates = ontology.objects.flatMap((object) =>
      object.properties
        .filter(
          (property) =>
            property.visibility === "ANALYTICAL" &&
            property.valueSearchable &&
            !property.sensitive,
        )
        .flatMap((property) => {
          const table = tables.get(object.sourceTableId);
          return table ? [{ object, property, table }] : [];
        }),
    );
    const status: PropertyValueIndexStatus = {
      ontologyVersion: ontology.version,
      status: "building",
      indexedProperties: 0,
      indexedValues: 0,
      partialProperties: 0,
      failedProperties: 0,
      updatedAt: new Date().toISOString(),
    };
    this.repository.clearIndexedPropertyStatuses(ontology.version);

    for (let offset = 0; offset < candidates.length; offset += INDEX_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INDEX_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async ({ object, property, table }) => {
          const column = quoteIdentifier(property.sourceColumn);
          const tableName = `${quoteIdentifier(table.database)}.${quoteIdentifier(table.name)}`;
          const sql = `SELECT CAST(${column} AS STRING) AS indexed_value, COUNT(*) AS value_frequency
FROM ${tableName}
WHERE ${column} IS NOT NULL
GROUP BY ${column}
ORDER BY value_frequency DESC
LIMIT ${MAX_VALUES_PER_PROPERTY + 1}`;
          const result = await this.executeQuery(
            sql,
            MAX_VALUES_PER_PROPERTY + 1,
            [],
            60_000,
          );
          const partial = result.rows.length > MAX_VALUES_PER_PROPERTY;
          const values = result.rows
            .slice(0, MAX_VALUES_PER_PROPERTY)
            .map((row) => ({
              displayValue: String(row.indexed_value ?? ""),
              frequency: Math.max(1, Number(row.value_frequency ?? 1)),
            }))
            .filter((value) => value.displayValue.trim());
          this.repository.replaceIndexedPropertyValues(
            ontology.version,
            object.id,
            property.id,
            values,
          );
          return {
            objectId: object.id,
            propertyId: property.id,
            valueCount: values.length,
            coveredRows: values.reduce(
              (total, value) => total + value.frequency,
              0,
            ),
            partial,
          };
        }),
      );
      for (const [index, result] of results.entries()) {
        const candidate = batch[index]!;
        const updatedAt = new Date().toISOString();
        if (result.status === "fulfilled") {
          status.indexedProperties += 1;
          status.indexedValues += result.value.valueCount;
          if (result.value.partial) status.partialProperties += 1;
          this.repository.saveIndexedPropertyStatus({
            ontologyVersion: ontology.version,
            objectId: result.value.objectId,
            propertyId: result.value.propertyId,
            status: result.value.partial
              ? "partial"
              : result.value.valueCount
                ? "ready"
                : "empty",
            distinctValues: result.value.valueCount,
            coveredRows: result.value.coveredRows,
            updatedAt,
          });
        } else {
          status.failedProperties += 1;
          const error =
            result.reason instanceof Error
              ? result.reason.message
              : "部分属性值索引构建失败";
          status.error = error;
          this.repository.saveIndexedPropertyStatus({
            ontologyVersion: ontology.version,
            objectId: candidate.object.id,
            propertyId: candidate.property.id,
            status: "failed",
            distinctValues: 0,
            coveredRows: 0,
            error,
            updatedAt,
          });
        }
      }
      status.updatedAt = new Date().toISOString();
      this.repository.savePropertyValueIndexStatus(status);
    }

    status.status =
      status.failedProperties > 0 || status.partialProperties > 0
        ? "partial"
        : "ready";
    status.updatedAt = new Date().toISOString();
    this.repository.savePropertyValueIndexStatus(status);
    return status;
  }
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}
