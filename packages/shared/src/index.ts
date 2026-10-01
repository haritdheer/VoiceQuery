/**
 * Wire contract shared by the API and the web client.
 * Keep this file free of runtime dependencies so both sides can import it cheaply.
 */

/* ---------------------------------- auth ---------------------------------- */

export interface PublicUser {
  id: string;
  /** Null for a guest — an anonymous visitor trying the demo. */
  email: string | null;
  isGuest: boolean;
  createdAt: string;
}

export interface SessionState {
  user: PublicUser | null;
  credits: number;
  /** True once the one-time free grant has been issued to this account. */
  freeGrantIssued: boolean;
  /** Which AI account pays for model usage on the next analysis. */
  aiMode: AiMode;
  /**
   * Whether the next analysis will consume a credit. Server-authoritative so
   * the client never has to re-derive the BYOK / demo / platform precedence.
   * False in BYOK mode, and in demo mode unless the operator opted in.
   */
  creditsApply: boolean;
  /** Provider id of a connected BYOK key, when aiMode === 'byok'. */
  byokProvider: string | null;
  /** csrf token to echo back in the X-CSRF-Token header on mutating calls */
  csrfToken: string | null;
  /**
   * Guest state. A guest can explore the sample dataset with the demo
   * provider but cannot upload, connect a key, or buy credits — and never
   * reaches a real AI model, so anonymous traffic cannot spend the
   * operator's provider budget.
   */
  guest: GuestState | null;
}

export interface GuestState {
  /** Analyses this guest has run. */
  questionsUsed: number;
  /** Hard server-side ceiling. Past this, analysis is refused until sign-in. */
  questionsLimit: number;
  /** True once the ceiling is reached. */
  exhausted: boolean;
}

/** Which account pays the model bill. */
export type AiMode = 'platform' | 'byok' | 'demo';

/* -------------------------------- datasets -------------------------------- */

export type ColumnType = 'string' | 'number' | 'integer' | 'date' | 'timestamp' | 'boolean';

export interface ColumnSchema {
  /** Physical column name inside DuckDB (sanitised, unique). */
  name: string;
  /** The header as it appeared in the user's file. */
  originalName: string;
  type: ColumnType;
  nullable: boolean;
  /** Distinct sample values, capped — used to ground the model. Never the full column. */
  sampleValues: string[];
  nullCount: number;
}

export interface DatasetSummary {
  id: string;
  name: string;
  kind: 'sample' | 'upload';
  rowCount: number;
  columnCount: number;
  sizeBytes: number;
  createdAt: string;
  /** ISO timestamp after which the dataset file is swept. Null for the built-in sample. */
  expiresAt: string | null;
}

export interface DatasetDetail extends DatasetSummary {
  columns: ColumnSchema[];
  /** First N rows, for the preview grid. */
  preview: Record<string, unknown>[];
  /** Non-fatal problems found while ingesting (coerced types, renamed dupes, ...). */
  warnings: string[];
}

/* --------------------------------- charts --------------------------------- */

export type ChartKind = 'bar' | 'horizontalBar' | 'line' | 'area' | 'pie' | 'scatter' | 'none';

export interface ChartSpec {
  kind: ChartKind;
  /** Column from the result set to use on the category / x axis. */
  xKey: string;
  /** One or more numeric result columns to plot. */
  yKeys: string[];
  title: string;
  xLabel?: string;
  yLabel?: string;
  /** Hint for axis/tooltip formatting of the y values. */
  valueFormat?: 'number' | 'currency' | 'percent';
}

/* -------------------------------- analysis -------------------------------- */

export type StageName =
  | 'understanding'
  | 'generating_sql'
  | 'running_query'
  | 'preparing_answer';

export interface StageTiming {
  stage: StageName;
  ms: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows produced by the query before the display cap was applied. */
  totalRows: number;
  /** True when `rows` is a prefix of a larger result set. */
  truncated: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** A completed analysis, or a clarification request, or a failure. */
export type AnalysisOutcome = 'answered' | 'clarification' | 'error';

export interface AnalysisResponse {
  id: string;
  conversationId: string;
  outcome: AnalysisOutcome;
  question: string;
  /** Plain-language answer, or the clarifying question when outcome === 'clarification'. */
  answer: string;
  sql: string | null;
  chart: ChartSpec | null;
  result: QueryResult | null;
  timings: StageTiming[];
  totalMs: number;
  /** Whether this analysis consumed a platform credit. */
  creditConsumed: boolean;
  creditsRemaining: number;
  aiMode: AiMode;
  /** Present only when the provider reported it. Never estimated silently. */
  usage: TokenUsage | null;
  /** Set when this response came from the clearly-labelled offline demo provider. */
  simulated: boolean;
  error: string | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  datasetId: string;
  datasetName: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: AnalysisResponse[];
}

/* --------------------------------- credits -------------------------------- */

export type LedgerReason =
  | 'free_grant'
  | 'analysis_reserve'
  | 'analysis_refund'
  | 'admin_adjust';

export interface LedgerEntry {
  id: string;
  delta: number;
  reason: LedgerReason;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

/* ------------------------------- byok / meta ------------------------------ */

export interface ProviderInfo {
  id: string;
  label: string;
  /** Docs URL where a user creates an API key. */
  keyUrl: string;
  /** Placeholder only — key formats are never hard-validated client-side. */
  keyPlaceholder: string;
  /** True when the user must also choose a model (OpenAI, OpenRouter). */
  requiresModel: boolean;
  /** Where to browse this provider's model ids. */
  modelsUrl: string;
  modelPlaceholder: string | null;
  /** Human note about what validating the key costs. */
  validationNote: string;
  /** Clarifies that a consumer chat subscription is not API access. */
  subscriptionNote: string;
}

export interface AppConfigResponse {
  /** True when the server has no platform AI credentials and is returning simulated answers. */
  demoMode: boolean;
  providers: ProviderInfo[];
  limits: {
    maxUploadBytes: number;
    maxRows: number;
    maxColumns: number;
    maxResultRows: number;
    datasetTtlHours: number;
  };
  freeCredits: number;
  /**
   * Whether this deployment meters analyses with credits at all. False when
   * demo mode is running free, which makes the "N free questions" copy
   * misleading — the UI checks this before showing it.
   */
  creditsEnabled: boolean;
  guest: {
    /** Whether anonymous visitors may try the demo without signing in. */
    enabled: boolean;
    /** Answers a guest sees before the first sign-in nudge. */
    nudgeAfter: number;
    /** How often the nudge repeats after that. */
    nudgeEvery: number;
    /** Hard ceiling on analyses per guest session. */
    questionsLimit: number;
  };
}

export interface ApiError {
  error: string;
  message: string;
  /** Set when the client should do something specific rather than just report. */
  code?:
    | 'insufficient_credits'
    /** The user's own key failed. The message names their provider. */
    | 'byok_failed'
    /** The operator's shared key is rejected, expired or out of quota. */
    | 'platform_unavailable'
    | 'rate_limited'
    | 'unsafe_sql'
    | 'validation'
    | 'account_required'
    | 'guest_limit';
  details?: unknown;
}
