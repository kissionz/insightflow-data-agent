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
  evidenceTier: "EXACT_LABEL" | "SYNONYM" | "NGRAM";
  objectPriority: number;
  propertyPriority: number;
}

export interface HierarchyStep {
  hierarchyId: string;
  hierarchyLabel: string;
  fromLevel: number;
  targetLevel: number;
  objectId: string;
  propertyId: string;
}

export interface RecursiveHierarchyMatch {
  hierarchyId: string;
  hierarchyLabel: string;
  objectId: string;
  nodeIdPropertyId: string;
  parentIdPropertyId: string;
  labelPropertyId: string;
  maxDepth: number;
  closure?: NonNullable<
    NonNullable<OntologySnapshot["dimensionHierarchies"]>[number]["adjacency"]
  >["closure"];
}

export class SemanticIndex {
  private readonly terms = new Map<string, SemanticMatch[]>();
  private readonly adjacency = new Map<string, Array<{ objectId: string; relationId: string }>>();

  constructor(readonly snapshot: OntologySnapshot) {
    snapshot.objects.forEach((object) => this.indexObject(object));
    snapshot.metrics.forEach((metric) => this.indexMetric(metric));
    snapshot.relations.forEach((relation) => this.indexRelation(relation));
  }

  search(
    query: string,
    limit = 8,
    allowedKinds?: SemanticMatch["kind"][],
  ): SemanticMatch[] {
    const normalized = normalize(query);
    const tokens = new Set([normalized, ...tokenize(normalized), ...chineseNgrams(normalized)]);
    const scores = new Map<string, SemanticMatch>();

    for (const token of tokens) {
      for (const match of this.terms.get(token) ?? []) {
        if (allowedKinds && !allowedKinds.includes(match.kind)) continue;
        const key = `${match.kind}:${match.id}`;
        const existing = scores.get(key);
        const exactBoost = token === normalized ? 0.4 : 0;
        const exactTerm = normalize(match.matchedBy) === normalized;
        const next = {
          ...match,
          evidenceTier: exactTerm ? match.evidenceTier : "NGRAM" as const,
          score: Math.min(1, match.score + exactBoost),
        };
        if (!existing || compareSemanticMatches(next, existing) < 0) {
          scores.set(key, next);
        }
      }
    }

    return [...scores.values()].sort(compareSemanticMatches).slice(0, limit);
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

  findHierarchySteps(
    propertyId: string,
    operation: "ROLL_UP" | "DRILL_DOWN",
  ): HierarchyStep[] {
    const offset = operation === "ROLL_UP" ? -1 : 1;
    return (this.snapshot.dimensionHierarchies ?? []).flatMap((hierarchy) => {
      if ((hierarchy.kind ?? "FIXED_LEVELS") !== "FIXED_LEVELS") return [];
      const fromLevel = hierarchy.levels.findIndex(
        (level) => level.propertyId === propertyId,
      );
      const targetLevel = fromLevel + offset;
      const target = hierarchy.levels[targetLevel];
      return fromLevel >= 0 && target
        ? [
            {
              hierarchyId: hierarchy.id,
              hierarchyLabel: hierarchy.label,
              fromLevel,
              targetLevel,
              objectId: target.objectId,
              propertyId: target.propertyId,
            },
          ]
        : [];
    });
  }

  findRecursiveHierarchy(hierarchyId: string): RecursiveHierarchyMatch | undefined {
    const hierarchy = (this.snapshot.dimensionHierarchies ?? []).find(
      (candidate) =>
        candidate.id === hierarchyId &&
        candidate.kind === "ADJACENCY_LIST" &&
        candidate.adjacency,
    );
    if (!hierarchy?.adjacency) return undefined;
    return {
      hierarchyId: hierarchy.id,
      hierarchyLabel: hierarchy.label,
      ...hierarchy.adjacency,
    };
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
    ], metric.objectId);
  }

  private addTerms(
    kind: SemanticMatch["kind"],
    id: string,
    label: string,
    terms: string[],
    objectId?: string,
    propertyId?: string,
  ): void {
    const object = objectId
      ? this.snapshot.objects.find((candidate) => candidate.id === objectId)
      : kind === "object"
        ? this.snapshot.objects.find((candidate) => candidate.id === id)
        : kind === "metric"
          ? this.snapshot.objects.find(
              (candidate) =>
                candidate.id ===
                this.snapshot.metrics.find((metric) => metric.id === id)?.objectId,
            )
          : undefined;
    const property = propertyId
      ? object?.properties.find((candidate) => candidate.id === propertyId)
      : undefined;
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
        evidenceTier: index < 2 ? "EXACT_LABEL" : "SYNONYM",
        objectPriority: object?.bindingPriority ?? 50,
        propertyPriority: property?.bindingPriority ?? 50,
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
    if (relation.direction !== "TARGET_TO_SOURCE") {
      const source = this.adjacency.get(relation.sourceObjectId) ?? [];
      source.push({ objectId: relation.targetObjectId, relationId: relation.id });
      this.adjacency.set(relation.sourceObjectId, source);
    }
    if (relation.direction !== "SOURCE_TO_TARGET") {
      const target = this.adjacency.get(relation.targetObjectId) ?? [];
      target.push({ objectId: relation.sourceObjectId, relationId: relation.id });
      this.adjacency.set(relation.targetObjectId, target);
    }
  }
}

function compareSemanticMatches(
  left: SemanticMatch,
  right: SemanticMatch,
): number {
  const tier = { EXACT_LABEL: 3, SYNONYM: 2, NGRAM: 1 };
  return (
    tier[right.evidenceTier] - tier[left.evidenceTier] ||
    right.objectPriority - left.objectPriority ||
    right.propertyPriority - left.propertyPriority ||
    right.score - left.score ||
    left.id.localeCompare(right.id)
  );
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
