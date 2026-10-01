import type {
  AnalysisResponse,
  AppConfigResponse,
  ConversationDetail,
  ConversationSummary,
  DatasetDetail,
  DatasetSummary,
  LedgerEntry,
  ProviderInfo,
  SessionState,
} from '@voicequery/shared';

/**
 * Typed API client.
 *
 * Two things this file is careful about:
 *  - The CSRF token lives in memory only, refreshed from every session
 *    response, and is attached to mutating calls.
 *  - A user's provider API key is passed straight through to a single POST and
 *    never stored here, in localStorage, or anywhere else on the client.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (body !== undefined && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    method,
    headers,
    // Send the session cookie.
    credentials: 'include',
    body:
      body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const err = (payload ?? {}) as { message?: string; error?: string; code?: string; details?: unknown };
    throw new ApiRequestError(
      err.message ?? `Request failed (${response.status}).`,
      response.status,
      err.code ?? err.error,
      err.details,
    );
  }

  return payload as T;
}

/* ---------------------------------- auth ---------------------------------- */

function rememberCsrf(state: SessionState): SessionState {
  setCsrfToken(state.csrfToken);
  return state;
}

export const api = {
  async config(): Promise<AppConfigResponse> {
    return request('GET', '/api/config');
  },

  async session(): Promise<SessionState> {
    return rememberCsrf(await request<SessionState>('GET', '/api/auth/session'));
  },

  /** Starts an anonymous demo session. No credentials required. */
  async startGuest(): Promise<SessionState> {
    return rememberCsrf(await request<SessionState>('POST', '/api/auth/guest'));
  },

  async register(email: string, password: string): Promise<SessionState> {
    return rememberCsrf(
      await request<SessionState>('POST', '/api/auth/register', { email, password }),
    );
  },

  async login(email: string, password: string): Promise<SessionState> {
    return rememberCsrf(
      await request<SessionState>('POST', '/api/auth/login', { email, password }),
    );
  },

  async logout(): Promise<SessionState> {
    return rememberCsrf(await request<SessionState>('POST', '/api/auth/logout'));
  },

  /* -------------------------------- datasets ------------------------------- */

  async datasets(): Promise<DatasetSummary[]> {
    const res = await request<{ datasets: DatasetSummary[] }>('GET', '/api/datasets');
    return res.datasets;
  },

  async dataset(id: string): Promise<{ dataset: DatasetDetail; exampleQuestions: string[] }> {
    return request('GET', `/api/datasets/${encodeURIComponent(id)}`);
  },

  async uploadCsv(file: File): Promise<DatasetDetail> {
    const form = new FormData();
    form.append('file', file);
    const res = await request<{ dataset: DatasetDetail }>('POST', '/api/datasets', form);
    return res.dataset;
  },

  async deleteDataset(id: string): Promise<void> {
    await request('DELETE', `/api/datasets/${encodeURIComponent(id)}`);
  },

  /* -------------------------------- analysis ------------------------------- */

  async analyze(input: {
    datasetId: string;
    question: string;
    conversationId?: string | null;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<AnalysisResponse> {
    const { signal, ...body } = input;
    return request('POST', '/api/analyze', body, { signal });
  },

  async conversations(): Promise<ConversationSummary[]> {
    const res = await request<{ conversations: ConversationSummary[] }>(
      'GET',
      '/api/conversations',
    );
    return res.conversations;
  },

  async conversation(id: string): Promise<ConversationDetail> {
    const res = await request<{ conversation: ConversationDetail }>(
      'GET',
      `/api/conversations/${encodeURIComponent(id)}`,
    );
    return res.conversation;
  },

  /* --------------------------------- credits ------------------------------- */

  async credits(): Promise<{ balance: number; ledger: LedgerEntry[] }> {
    return request('GET', '/api/credits');
  },

  /* ---------------------------------- byok --------------------------------- */

  async byokStatus(): Promise<{
    connected: boolean;
    providerId: string | null;
    model: string | null;
    fingerprint: string | null;
    expiresAt: string | null;
    providers: ProviderInfo[];
  }> {
    return request('GET', '/api/byok');
  },

  /** The key is sent once, over HTTPS, and never retained by the client. */
  async connectByok(providerId: string, apiKey: string, model?: string) {
    return request<{
      connected: boolean;
      providerId: string;
      model: string | null;
      fingerprint: string;
    }>('POST', '/api/byok', { providerId, apiKey, model });
  },

  async disconnectByok() {
    return request<{ connected: boolean }>('DELETE', '/api/byok');
  },
};
