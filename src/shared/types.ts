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
  | "partial"
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

export type TimeRangeKind =
  | "NONE"
  | "TODAY"
  | "YESTERDAY"
  | "CURRENT_WEEK"
  | "PREVIOUS_WEEK"
  | "CURRENT_MONTH"
  | "PREVIOUS_MONTH"
  | "CURRENT_QUARTER"
  | "PREVIOUS_QUARTER"
  | "CURRENT_YEAR"
  | "PREVIOUS_YEAR"
  | "ABSOLUTE_YEAR"
  | "ABSOLUTE_MONTH"
  | "CONTEXT_MONTH"
  | "ROLLING_PERIODS"
  | "LAST_N_COMPLETE_PERIODS"
  | "ABSOLUTE_RANGE";

export interface StructuredTimeRange {
  kind: TimeRangeKind;
  originalText?: string;
  year?: number;
  month?: number;
  count?: number;
  unit?: TimeGrain;
  start?: string;
  endExclusive?: string;
}

export interface QuestionLanguageFrame {
  originalQuestion: string;
  intentKind: "DIRECT_QUERY" | "EXPLORATORY_ANALYSIS" | "DIAGNOSTIC_ANALYSIS";
  metricTerms: string[];
  /** Original user spans retained for audit only; execution uses timeRange/timeGrain. */
  timeTerms: string[];
  timeRange?: StructuredTimeRange;
  timeGrain?: TimeGrain;
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
  acceptanceCriterionIds?: string[];
  status: "running" | "completed" | "failed";
  summary: string;
  intent?: AnalysisIntent;
  ir?: QueryIR;
  sql?: string;
  parameters?: unknown[];
  columns?: string[];
  rows?: Array<Record<string, string | number>>;
  rowCount?: number;
  truncated?: boolean;
  diagnosticEvaluation?: DiagnosticEvaluation;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface DiagnosticCandidate {
  dimensionId: string;
  label: string;
  objectLabel: string;
  score: number;
  reasons: string[];
  status: "PENDING" | "EVALUATED" | "ESTABLISHED";
}

export interface DiagnosticContribution {
  member: string;
  currentValue: number;
  previousValue: number;
  delta: number;
  growthRate?: number;
  alignedContributionShare: number;
  baselineShare: number;
  contributionLift?: number;
}

export interface DiagnosticEvaluation {
  dimensionId: string;
  dimensionLabel: string;
  measureId: string;
  measureLabel: string;
  status:
    | "ESTABLISHED"
    | "INSUFFICIENT_EXPLANATORY_POWER"
    | "INELIGIBLE"
    | "NO_DOMINANT_DRIVER_WITHIN_BUDGET";
  reason: string;
  rowCount: number;
  reconciliationRate?: number;
  relativeMateriality?: number;
  top1ContributionShare?: number;
  top3ContributionShare?: number;
  top1ToTop2Ratio?: number;
  top1ContributionLift?: number;
  maxGrowthRateDeviation?: number;
  driverStrength: number;
  dominantMembers: DiagnosticContribution[];
  evaluatedMeasureCount: number;
  metricEvaluations: DiagnosticMetricEvaluation[];
  nextCandidateRefs: string[];
}

export interface DiagnosticMetricEvaluation {
  measureId: string;
  measureLabel: string;
  status:
    | "ESTABLISHED"
    | "INSUFFICIENT_EXPLANATORY_POWER"
    | "INELIGIBLE";
  reason: string;
  rowCount: number;
  reconciliationRate?: number;
  relativeMateriality?: number;
  top1ContributionShare?: number;
  top3ContributionShare?: number;
  top1ToTop2Ratio?: number;
  top1ContributionLift?: number;
  maxGrowthRateDeviation?: number;
  driverStrength: number;
  dominantMembers: DiagnosticContribution[];
}

export type AcceptanceCriterionKind =
  | "SCOPE_BOUND"
  | "REQUESTED_RESULT"
  | "OVERVIEW"
  | "COMPARISON"
  | "STRUCTURE"
  | "PHENOMENON"
  | "BASELINE"
  | "DRIVERS"
  | "DATABASE_EVIDENCE"
  | "RESULT_COMPLETENESS";

export interface AcceptanceCriterion {
  id: string;
  kind: AcceptanceCriterionKind;
  label: string;
  description: string;
  required: boolean;
  status: "PENDING" | "SATISFIED" | "NOT_APPLICABLE" | "BLOCKED";
  evidenceStepIds: string[];
  summary?: string;
}

export interface AnalysisAcceptanceContract {
  profile: QuestionLanguageFrame["intentKind"];
  status:
    | "OPEN"
    | "SATISFIED"
    | "PARTIAL_BUDGET"
    | "PARTIAL_NO_PROGRESS"
    | "NEEDS_CLARIFICATION"
    | "FAILED";
  criteria: AcceptanceCriterion[];
  successfulQueries: number;
  maxSuccessfulQueries: number;
  remainingQueries: number;
  stopReason?: string;
}

export interface AnalysisRun {
  mode: QuestionLanguageFrame["intentKind"];
  objective: string;
  status:
    | "planning"
    | "running"
    | "completed"
    | "partial_budget"
    | "partial_no_progress"
    | "failed";
  maxSteps: number;
  acceptance: AnalysisAcceptanceContract;
  rootObjectId?: string;
  rootObjectLabel?: string;
  availableMetrics: Array<{ id: string; label: string }>;
  availableDimensions: Array<{
    id: string;
    label: string;
    objectLabel: string;
  }>;
  diagnosticCandidates?: DiagnosticCandidate[];
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
  operator:
    | "RANK"
    | "DENSE_RANK"
    | "RUNNING_SUM"
    | "MOVING_AVG"
    | "PERCENT_OF_TOTAL"
    | "PERCENT_OF_PARTITION";
  partitionByPropertyIds: string[];
  orderBy?: {
    entityId: string;
    direction: "ASC" | "DESC";
  };
  windowSize?: number;
  scale?: number;
  precision?: number;
  denominatorScope?: "AFTER_BUSINESS_FILTERS_BEFORE_TOP_N";
}

export interface GroupSelection {
  id: string;
  label: string;
  operator: "TOP_N" | "BOTTOM_N";
  partitionByPropertyIds: string[];
  orderByEntityId: string;
  count: number;
  ties: "INCLUDE" | "EXCLUDE";
}

export interface PeriodGroupCondition {
  id: string;
  label: string;
  measureId: string;
  operator: AggregateFilterOperator;
  value: number;
  quantifier: "EVERY" | "ANY" | "AT_LEAST_N";
  minimumMatches?: number;
  groupByPropertyIds: string[];
  expectedPeriodCount?: number;
  missingPeriodPolicy: "FAIL" | "IGNORE";
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
    kind?: TimeRangeKind;
    mode?: "AUTO" | "ROLLING" | "LAST_N_COMPLETE_PERIODS";
    count?: number;
    unit?: TimeGrain;
    year?: number;
    month?: number;
    start?: string;
    endExclusive?: string;
  };
  timeGrain?: {
    unit: TimeGrain;
    propertyId?: string;
  };
  derivedMeasures?: DerivedMeasureCalculation[];
  timeComparisons?: TimeComparisonCalculation[];
  windowCalculations?: WindowCalculation[];
  groupSelections?: GroupSelection[];
  periodConditions?: PeriodGroupCondition[];
  sort?: Array<{
    entityId: string;
    direction: "ASC" | "DESC";
  }>;
  limit?: number;
  resultKind: "aggregate" | "detail";
  title: string;
}

export interface QueryIR {
  version: 3;
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
    mode: "TO_DATE" | "FULL_PERIOD" | "ROLLING" | "COMPLETE_PERIODS";
    periodCount?: number;
    periodUnit?: TimeGrain;
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
  groupSelections: GroupSelection[];
  periodConditions: PeriodGroupCondition[];
  relationIds: string[];
  grain: string;
  resultKind: "aggregate" | "detail";
  sort: Array<{
    entityId: string;
    direction: "ASC" | "DESC";
  }>;
  limit: number;
  resultContract: {
    calculationSource: "DORIS_SQL";
    businessLogicBeforeLimit: true;
    completeness: "COMPLETE_IF_NOT_TRUNCATED";
    expectedPeriodCount?: number;
    exhaustiveRequested: boolean;
  };
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
  data: Array<number | null>;
}

export type ResultChartType =
  | "line"
  | "bar"
  | "horizontal-bar"
  | "donut"
  | "none";

export type ResultValueFormat = "currency" | "number" | "percent";

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
    type: ResultChartType;
    label: "趋势" | "构成" | "排名" | "对比" | "数据";
    rationale: string;
    note?: string;
    categoryLabel?: string;
    valueFormat?: ResultValueFormat;
    categories: string[];
    series: ResultSeries[];
  };
  columns: string[];
  rows: Array<Record<string, string | number>>;
  rowCount: number;
  truncated: boolean;
  verification?: {
    calculationSource: "DORIS_SQL" | "DETERMINISTIC_CALCULATOR";
    exhaustive: boolean;
    businessLogicBeforeLimit: boolean;
    expectedPeriodCount?: number;
    claimPolicy: "DATABASE_EVIDENCE_ONLY";
  };
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
  responseKind?:
    | "analysis"
    | "partial_analysis"
    | "conversation"
    | "configuration_required"
    | "clarification";
  resultIntent?: AnalysisIntent;
  result?: ResultArtifact;
}

export type CanvasItemWidth = "standard" | "wide";

export interface CanvasItem {
  id: string;
  title: string;
  intent: AnalysisIntent;
  presentation?: "chart" | "metric";
  width: CanvasItemWidth;
  position: number;
  sourceConversationId: string;
  sourceTurnId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasQueryResponse {
  itemId: string;
  result: ResultArtifact;
  resolvedTimeRange?: QueryIR["timeRange"];
  refreshedAt: string;
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

export interface DimensionHierarchy {
  id: string;
  name: string;
  label: string;
  description?: string;
  levels: Array<{
    objectId: string;
    propertyId: string;
  }>;
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
  dimensionHierarchies?: DimensionHierarchy[];
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
  canvasItems: CanvasItem[];
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
