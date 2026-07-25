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
  mode?: "demo" | "live";
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
  result?: ResultArtifact;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "archived";
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

export interface OntologyObject {
  id: string;
  name: string;
  label: string;
  description: string;
  sourceTableId: string;
  status: OntologyEntityStatus;
  properties: Array<{
    id: string;
    name: string;
    label: string;
    dataType: string;
    sourceColumn: string;
    sensitive: boolean;
  }>;
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
  aggregation: "SUM" | "COUNT" | "COUNT_DISTINCT" | "AVG" | "MIN" | "MAX";
  format: "currency" | "number" | "percent";
  synonyms: string[];
  status: OntologyEntityStatus;
}

export interface OntologySnapshot {
  version: number;
  status: OntologyEntityStatus;
  publishedAt?: string;
  objects: OntologyObject[];
  relations: OntologyRelation[];
  metrics: Metric[];
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
  tables: PhysicalTable[];
  dataSource: SafeDataSourceConfig;
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
