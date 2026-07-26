import type {
  Metric,
  OntologyObject,
  OntologyRelation,
  OntologySnapshot,
} from "../shared/types.js";

export interface SemanticMatch {
  kind: "object" | "property" | "metric";
  id: string;
  objectId?: string;
  propertyId?: string;
  label: string;
  score: number;
  matchedBy: string;
}

export class SemanticIndex {
  private readonly terms = new Map<string, SemanticMatch[]>();
  private readonly adjacency = new Map<string, Array<{ objectId: string; relationId: string }>>();

  constructor(readonly snapshot: OntologySnapshot) {
    snapshot.objects.forEach((object) => this.indexObject(object));
    snapshot.metrics.forEach((metric) => this.indexMetric(metric));
    snapshot.relations.forEach((relation) => this.indexRelation(relation));
  }

  search(query: string, limit = 8): SemanticMatch[] {
    const normalized = normalize(query);
    const tokens = new Set([normalized, ...tokenize(normalized), ...chineseNgrams(normalized)]);
    const scores = new Map<string, SemanticMatch>();

    for (const token of tokens) {
      for (const match of this.terms.get(token) ?? []) {
        const key = `${match.kind}:${match.id}`;
        const existing = scores.get(key);
        const exactBoost = token === normalized ? 0.4 : 0;
        const next = { ...match, score: Math.min(1, match.score + exactBoost) };
        if (!existing || next.score > existing.score) {
          scores.set(key, next);
        }
      }
    }

    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  findRelationPath(sourceObjectId: string, targetObjectId: string): OntologyRelation[] {
    if (sourceObjectId === targetObjectId) return [];
    const queue: Array<{ objectId: string; path: string[] }> = [
      { objectId: sourceObjectId, path: [] },
    ];
    const visited = new Set([sourceObjectId]);

    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of this.adjacency.get(current.objectId) ?? []) {
        if (visited.has(edge.objectId)) continue;
        const nextPath = [...current.path, edge.relationId];
        if (edge.objectId === targetObjectId) {
          return nextPath
            .map((id) => this.snapshot.relations.find((relation) => relation.id === id))
            .filter((relation): relation is OntologyRelation => Boolean(relation));
        }
        visited.add(edge.objectId);
        queue.push({ objectId: edge.objectId, path: nextPath });
      }
    }
    return [];
  }

  private indexObject(object: OntologyObject): void {
    this.addTerms("object", object.id, object.label, [
      object.name,
      object.label,
      ...object.synonyms,
    ]);
    object.properties
      .filter((property) => property.visibility === "ANALYTICAL")
      .forEach((property) =>
        this.addTerms(
          "property",
          property.id,
          property.label,
          [property.name, property.label, ...property.synonyms],
          object.id,
          property.id,
        ),
      );
  }

  private indexMetric(metric: Metric): void {
    this.addTerms("metric", metric.id, metric.label, [
      metric.name,
      metric.label,
      ...metric.synonyms,
    ]);
  }

  private addTerms(
    kind: SemanticMatch["kind"],
    id: string,
    label: string,
    terms: string[],
    objectId?: string,
    propertyId?: string,
  ): void {
    for (const [index, rawTerm] of terms.entries()) {
      const term = normalize(rawTerm);
      if (!term) continue;
      const match: SemanticMatch = {
        kind,
        id,
        objectId,
        propertyId,
        label,
        score: index < 2 ? 0.96 : 0.84,
        matchedBy: rawTerm,
      };
      for (const token of new Set([term, ...tokenize(term), ...chineseNgrams(term)])) {
        const matches = this.terms.get(token) ?? [];
        matches.push(match);
        this.terms.set(token, matches);
      }
    }
  }

  private indexRelation(relation: OntologyRelation): void {
    if (!relation.enabled) return;
    const source = this.adjacency.get(relation.sourceObjectId) ?? [];
    source.push({ objectId: relation.targetObjectId, relationId: relation.id });
    this.adjacency.set(relation.sourceObjectId, source);

    const target = this.adjacency.get(relation.targetObjectId) ?? [];
    target.push({ objectId: relation.sourceObjectId, relationId: relation.id });
    this.adjacency.set(relation.targetObjectId, target);
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return value.split(/[\s,，。；;、/_-]+/).filter(Boolean);
}

function chineseNgrams(value: string): string[] {
  const chinese = value.replace(/[^\p{Script=Han}]/gu, "");
  const grams: string[] = [];
  for (const size of [2, 3]) {
    for (let index = 0; index <= chinese.length - size; index += 1) {
      grams.push(chinese.slice(index, index + size));
    }
  }
  return grams;
}
