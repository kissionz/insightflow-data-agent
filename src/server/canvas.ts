import type {
  CanvasItem,
  CanvasQueryResponse,
  ResultArtifact,
} from "../shared/types.js";
import { QueryIrCompiler } from "./query-ir.js";
import { Repository } from "./repository.js";
import { createLiveResult } from "./result-artifact.js";
import type { QueryResult } from "./selectdb.js";
import { guardReadOnlySql } from "./sql-guard.js";

export const MAX_CONCURRENT_CANVAS_QUERIES = 5;

export function canvasPresentationForResult(
  result: ResultArtifact,
): CanvasItem["presentation"] | null {
  if (result.chart.type !== "none") return "chart";
  if (result.kpis.length) return "metric";
  return null;
}

type ExecuteLiveQuery = (
  sql: string,
  maxRows: number,
  parameters?: unknown[],
  timeoutMs?: number,
) => Promise<QueryResult>;

export class CanvasQueryService {
  private activeQueries = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly repository: Repository,
    private readonly executeLiveQuery: ExecuteLiveQuery,
    private readonly compiler = new QueryIrCompiler(),
  ) {}

  query(item: CanvasItem): Promise<CanvasQueryResponse> {
    return this.withQuerySlot(async () => {
      const ontology = this.repository.getPublishedOntology();
      const tables = this.repository.getTables();
      const timezone = this.repository.getAgentConfig().timezone;
      const compiled = this.compiler.compile(
        item.intent,
        ontology,
        tables,
        timezone,
      );
      const maxRows = item.intent.resultKind === "detail" ? 50 : 200;
      const guarded = guardReadOnlySql(compiled.sql, maxRows);
      const query = await this.executeLiveQuery(
        guarded.sql,
        maxRows,
        compiled.parameters,
        180_000,
      );
      const result = createLiveResult(item.intent, query, ontology);
      result.chart.title = item.title;
      result.verification = {
        calculationSource: compiled.ir.resultContract.calculationSource,
        exhaustive:
          compiled.ir.resultContract.exhaustiveRequested && !query.truncated,
        businessLogicBeforeLimit:
          compiled.ir.resultContract.businessLogicBeforeLimit,
        expectedPeriodCount:
          compiled.ir.resultContract.expectedPeriodCount,
        claimPolicy: "DATABASE_EVIDENCE_ONLY",
      };

      return {
        itemId: item.id,
        result,
        resolvedTimeRange: compiled.ir.timeRange,
        refreshedAt: new Date().toISOString(),
      };
    });
  }

  private async withQuerySlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireQuerySlot();
    try {
      return await operation();
    } finally {
      this.releaseQuerySlot();
    }
  }

  private acquireQuerySlot(): Promise<void> {
    if (this.activeQueries < MAX_CONCURRENT_CANVAS_QUERIES) {
      this.activeQueries += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private releaseQuerySlot(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.activeQueries -= 1;
  }
}
