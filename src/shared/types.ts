export type TraceStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "waiting_for_approval"
  | "failed";

export type TurnStatus =
  | "understanding"
  | "planning"
  | "querying"
  | "completed"
  | "needs_clarification"
  | "failed"
  | "cancelled";

export interface TraceStep {
  id: string;
  turnId: string;
  kind:
    | "understanding"
    | "inheritance"
    | "semantic_binding"
    | "relation_path"
    | "grain_check"
    | "query_plan"
    | "sql"
    | "approval"
    | "execution"
    | "interpretation";
  label: string;
  status: TraceStatus;
  summary: string;
  detail?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ResultSeries {
  name: string;
  data: number[];
}

export interface ResultArtifact {
  kind: "analysis";
  mode: "live";
  conclusion: string;
  kpis: Array<{
    label: string;
    value: string;
    change?: string;
  }>;
  chart: {
    title: string;
    type: "line" | "bar";
    categories: string[];
    series: ResultSeries[];
  };
  columns: string[];
  rows: Array<Record<string, string | number>>;
  rowCount: number;
  truncated: boolean;
}

export interface Turn {
  id: string;
  conversationId: string;
  parentTurnId?: string;
  question: string;
  answer?: string;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
  ontologyVersion: number;
  trace: TraceStep[];
  responseKind?: "analysis" | "conversation" | "configuration_required" | "clarification";
  result?: ResultArtifact;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "archived";
  harnessSessionId?: string;
  turns: Turn[];
}

export type PhysicalTableStatus =
  | "UNMODELED"
  | "DRAFTING"
  | "MODELED"
  | "CHANGED"
  | "IGNORED"
  | "REMOVED";

export interface PhysicalTable {
  id: string;
  catalog: string;
  database: string;
  name: string;
  type: "TABLE" | "VIEW";
  status: PhysicalTableStatus;
  rowEstimate?: number;
  description?: string;
  columns: Array<{
    name: string;
    dataType: string;
    nullable: boolean;
    sensitive: boolean;
    comment?: string;
  }>;
  fingerprint: string;
  scannedAt: string;
}

export type OntologyEntityStatus =
  | "DRAFT"
  | "VERIFIED"
  | "PUBLISHED"
  | "DEPRECATED";

export type PropertyVisibility = "ANALYTICAL" | "DETAIL_ONLY" | "HIDDEN";

export type OntologyObjectType =
  | "ENTITY"
  | "EVENT"
  | "SNAPSHOT"
  | "AGGREGATE"
  | "RELATIONSHIP";

export type PropertyMeaning =
  | "ID"
  | "CODE"
  | "NAME"
  | "ENTITY_REFERENCE"
  | "CATEGORY"
  | "TIME"
  | "NUMBER"
  | "BOOLEAN"
  | "GEOGRAPHY"
  | "TEXT";

export type NumericKind = "GENERAL" | "CURRENCY" | "RATIO";
export type NumericAggregationBehavior =
  | "ADDITIVE"
  | "SEMI_ADDITIVE"
  | "NON_ADDITIVE";

export interface NumericPropertySpec {
  kind: NumericKind;
  unit?: string;
  currency?: string;
  defaultAggregation: "SUM" | "AVG" | "MIN" | "MAX" | "NONE";
  aggregationBehavior: NumericAggregationBehavior;
}

export interface OntologyProperty {
  id: string;
  name: string;
  label: string;
  description: string;
  dataType: string;
  sourceColumn: string;
  sensitive: boolean;
  meaning: PropertyMeaning;
  unique: boolean;
  valueSearchable: boolean;
  numericSpec?: NumericPropertySpec;
  visibility: PropertyVisibility;
  synonyms: string[];
  format?: string;
  detailOrder?: number;
  defaultDisplay: boolean;
  exportable: boolean;
  nullDisplay?: string;
}

export interface OntologyObject {
  id: string;
  name: string;
  label: string;
  description: string;
  sourceTableId: string;
  status: OntologyEntityStatus;
  objectType: OntologyObjectType;
  grainPropertyIds: string[];
  grain: string;
  identityReviewRequired?: boolean;
  defaultTimePropertyId?: string;
  defaultFilter?: string;
  category?: string;
  owner?: string;
  exampleQuestions: string[];
  properties: OntologyProperty[];
  synonyms: string[];
}

export interface OntologyRelation {
  id: string;
  name: string;
  sourceObjectId: string;
  targetObjectId: string;
  type:
    | "REFERENCE"
    | "COMPOSITION"
    | "ASSOCIATION"
    | "HIERARCHY"
    | "EVENT_PARTICIPATION"
    | "IDENTITY"
    | "DERIVED";
  cardinality:
    | "ONE_TO_ONE"
    | "ONE_TO_MANY"
    | "MANY_TO_ONE"
    | "MANY_TO_MANY";
  joinExpression: string;
  sourcePropertyId?: string;
  targetPropertyId?: string;
  direction: "BIDIRECTIONAL" | "SOURCE_TO_TARGET" | "TARGET_TO_SOURCE";
  required: boolean;
  enabled: boolean;
  fanoutRisk: "NONE" | "LOW" | "HIGH";
  status: OntologyEntityStatus;
}

export interface Metric {
  id: string;
  name: string;
  label: string;
  description: string;
  objectId: string;
  expression: string;
  definitionMode: "VISUAL" | "SQL";
  sourcePropertyId?: string;
  filterExpression?: string;
  timePropertyId?: string;
  aggregation:
    | "SUM"
    | "COUNT"
    | "COUNT_DISTINCT"
    | "AVG"
    | "MIN"
    | "MAX"
    | "CUSTOM";
  format: "currency" | "number" | "percent";
  unit?: string;
  synonyms: string[];
  status: OntologyEntityStatus;
}

export interface OntologySnapshot {
  schemaVersion: 2;
  version: number;
  baseVersion?: number;
  status: OntologyEntityStatus;
  publishedAt?: string;
  objects: OntologyObject[];
  relations: OntologyRelation[];
  metrics: Metric[];
}

export interface OntologyValidationIssue {
  level: "ERROR" | "WARNING";
  code: string;
  message: string;
  objectId?: string;
  entityId?: string;
}

export interface OntologyValidationResult {
  valid: boolean;
  issues: OntologyValidationIssue[];
}

export interface SafeDataSourceConfig {
  configured: boolean;
  host?: string;
  port?: number;
  username?: string;
  catalog?: string;
  database?: string;
  tls?: boolean;
  passwordStored: boolean;
  lastTestedAt?: string;
  lastTestOk?: boolean;
}

export interface DataSourceInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  catalog: string;
  database: string;
  tls: boolean;
}

export interface BootstrapPayload {
  conversations: Conversation[];
  ontology: OntologySnapshot;
  ontologyDraft?: OntologySnapshot;
  tables: PhysicalTable[];
  dataSource: SafeDataSourceConfig;
  runtime: {
    modelConfigured: boolean;
    analysisReady: boolean;
    provider?: string;
    model?: string;
    modelError?: string;
    credentialStore: "macos_keychain" | "windows_dpapi" | "environment";
  };
}

export interface DataAgentEvent {
  eventId: string;
  conversationId: string;
  turnId: string;
  sequence: number;
  timestamp: string;
  type:
    | "turn_created"
    | "trace_step_started"
    | "trace_step_completed"
    | "trace_step_failed"
    | "turn_updated"
    | "turn_completed"
    | "turn_failed";
  turn?: Turn;
}
