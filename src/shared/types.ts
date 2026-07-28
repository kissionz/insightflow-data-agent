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
  facts?: Array<{
    label: string;
    value: string;
    source?: string;
    entityId?: string;
  }>;
  code?: {
    language: "json" | "sql";
    content: string;
  };
  createdAt: string;
  completedAt?: string;
}

export type QueryFilterOperator =
  | "EQ"
  | "NE"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "IN"
  | "CONTAINS"
  | "PREFIX"
  | "IS_NULL"
  | "NOT_NULL";

export type TimeGrain = "DAY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR";

export interface QuestionLanguageFrame {
  originalQuestion: string;
  intentKind: "DIRECT_QUERY" | "EXPLORATORY_ANALYSIS" | "DIAGNOSTIC_ANALYSIS";
  metricTerms: string[];
  timeTerms: string[];
  objectTerms: string[];
  businessValueTerms: string[];
  groupingTerms: string[];
  calculationTerms: string[];
  presentation: {
    kind: "AUTO" | "SINGLE_VALUE" | "TABLE" | "TREND" | "RANKING";
    limit?: number;
    sortDirection?: "ASC" | "DESC";
  };
}

export interface AnalysisRunStep {
  id: string;
  callId: string;
  sequence: number;
  title: string;
  objective: string;
  rationale?: string;
  role: "OVERVIEW" | "DIAGNOSTIC" | "SUPPORTING";
  status: "running" | "completed" | "failed";
  summary: string;
  ir?: QueryIR;
  sql?: string;
  parameters?: unknown[];
  columns?: string[];
  rows?: Array<Record<string, string | number>>;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AnalysisRun {
  mode: "EXPLORATORY_ANALYSIS" | "DIAGNOSTIC_ANALYSIS";
  objective: string;
  status: "planning" | "running" | "completed" | "failed";
  maxSteps: number;
  rootObjectId?: string;
  rootObjectLabel?: string;
  availableMetrics: Array<{ id: string; label: string }>;
  availableDimensions: Array<{
    id: string;
    label: string;
    objectLabel: string;
  }>;
  steps: AnalysisRunStep[];
}

export interface DirectAnalysisFilter {
  kind?: "DIRECT";
  propertyId: string;
  operator: QueryFilterOperator;
  value?: string | string[];
  businessValue?: string;
}

export interface BoundValueAnalysisFilter {
  kind: "BOUND_VALUE";
  valueBindingId: string;
  objectId: string;
  propertyId: string;
  operator: QueryFilterOperator;
  value: string;
  businessValue: string;
  evidenceTier: "EXACT_VALUE" | "PREFIX_VALUE";
  objectPriority: number;
  propertyPriority: number;
}

export type AnalysisFilter =
  | DirectAnalysisFilter
  | BoundValueAnalysisFilter;

export type AnalysisFilterExpression =
  | {
      type: "CONDITION";
      filter: AnalysisFilter;
    }
  | {
      type: "GROUP";
      operator: "AND" | "OR";
      children: AnalysisFilterExpression[];
    }
  | {
      type: "NOT";
      child: AnalysisFilterExpression;
    };

export type AggregateFilterOperator =
  | "EQ"
  | "NE"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE";

export interface AggregateAnalysisFilter {
  entityId: string;
  operator: AggregateFilterOperator;
  value: number;
}

export type AggregateFilterExpression =
  | {
      type: "CONDITION";
      filter: AggregateAnalysisFilter;
    }
  | {
      type: "GROUP";
      operator: "AND" | "OR";
      children: AggregateFilterExpression[];
    }
  | {
      type: "NOT";
      child: AggregateFilterExpression;
    };

export interface DerivedMeasureCalculation {
  id: string;
  label: string;
  operator: "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE" | "RATIO";
  leftMeasureId: string;
  rightMeasureId: string;
  scale?: number;
}

export interface TimeComparisonCalculation {
  id: string;
  label: string;
  measureId: string;
  comparison: "PREVIOUS_PERIOD" | "YEAR_OVER_YEAR";
  output: "PREVIOUS_VALUE" | "DIFFERENCE" | "GROWTH_RATE";
}

export interface WindowCalculation {
  id: string;
  label: string;
  measureId: string;
  operator: "RANK" | "DENSE_RANK" | "RUNNING_SUM" | "MOVING_AVG";
  partitionByPropertyIds: string[];
  orderBy: {
    entityId: string;
    direction: "ASC" | "DESC";
  };
  windowSize?: number;
}

export interface AnalysisIntent {
  rootObjectId?: string;
  measureIds: string[];
  dimensionPropertyIds: string[];
  filters: AnalysisFilter[];
  filterExpression?: AnalysisFilterExpression;
  aggregateFilters?: AggregateAnalysisFilter[];
  aggregateFilterExpression?: AggregateFilterExpression;
  timeRange?: {
    expression: string;
    propertyId?: string;
  };
  timeGrain?: {
    unit: TimeGrain;
    propertyId?: string;
  };
  derivedMeasures?: DerivedMeasureCalculation[];
  timeComparisons?: TimeComparisonCalculation[];
  windowCalculations?: WindowCalculation[];
  sort?: Array<{
    entityId: string;
    direction: "ASC" | "DESC";
  }>;
  limit?: number;
  resultKind: "aggregate" | "detail";
  title: string;
}

export interface QueryIR {
  version: 2;
  ontologyVersion: number;
  rootObjectId: string;
  measureIds: string[];
  dimensionPropertyIds: string[];
  filters: Array<
    | DirectAnalysisFilter
    | (BoundValueAnalysisFilter & {
        strategy: "DIRECT" | "EXISTS";
        relationIds: string[];
      })
  >;
  filterExpression?: AnalysisFilterExpression;
  aggregateFilters: AggregateAnalysisFilter[];
  aggregateFilterExpression?: AggregateFilterExpression;
  timeRange?: {
    propertyId: string;
    expression: string;
    start: string;
    endExclusive: string;
    mode: "TO_DATE" | "FULL_PERIOD" | "ROLLING";
    comparisonRanges?: Array<{
      comparison: TimeComparisonCalculation["comparison"];
      start: string;
      endExclusive: string;
    }>;
  };
  timeGrain?: {
    unit: TimeGrain;
    propertyId: string;
  };
  derivedMeasures: DerivedMeasureCalculation[];
  timeComparisons: TimeComparisonCalculation[];
  windowCalculations: WindowCalculation[];
  relationIds: string[];
  grain: string;
  resultKind: "aggregate" | "detail";
  sort: Array<{
    entityId: string;
    direction: "ASC" | "DESC";
  }>;
  limit: number;
}

export interface AgentPromptConfig {
  version: number;
  businessInstructions: string;
  timezone: string;
  updatedAt: string;
}

export interface PropertyValueIndexStatus {
  ontologyVersion: number;
  status: "idle" | "building" | "ready" | "partial" | "failed";
  indexedProperties: number;
  indexedValues: number;
  partialProperties: number;
  failedProperties: number;
  updatedAt?: string;
  error?: string;
}

export interface PropertyValueIndexProperty {
  ontologyVersion: number;
  objectId: string;
  objectLabel: string;
  propertyId: string;
  propertyLabel: string;
  sourceColumn: string;
  semanticMeaning: PropertyMeaning;
  status: "ready" | "partial" | "empty" | "failed";
  distinctValues: number;
  coveredRows: number;
  updatedAt: string;
  error?: string;
  topValues: Array<{
    value: string;
    frequency: number;
  }>;
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
  promptVersion?: number;
  trace: TraceStep[];
  analysisRun?: AnalysisRun;
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
  bindingPriority: number;
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
  bindingPriority: number;
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
  metricType?: "BASE" | "DERIVED";
  name: string;
  label: string;
  description: string;
  objectId: string;
  expression: string;
  definitionMode: "VISUAL" | "SQL";
  sourcePropertyId?: string;
  filterExpression?: string;
  timePropertyId?: string;
  leftMetricId?: string;
  rightMetricId?: string;
  calculationOperator?: "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE" | "RATIO";
  scale?: number;
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
  agentConfig: AgentPromptConfig;
  valueIndex: PropertyValueIndexStatus;
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
