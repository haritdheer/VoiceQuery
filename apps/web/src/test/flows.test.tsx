import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AnalysisResponse,
  AppConfigResponse,
  DatasetDetail,
  SessionState,
} from '@voicequery/shared';

/**
 * Frontend flow tests.
 *
 * The API module is mocked so these exercise the UI's own behaviour — states,
 * guards, and what the user is told — rather than re-testing the server, which
 * has its own suite.
 */

vi.mock('../lib/api.ts', () => ({
  api: {
    config: vi.fn(),
    session: vi.fn(),
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    datasets: vi.fn(),
    dataset: vi.fn(),
    uploadCsv: vi.fn(),
    deleteDataset: vi.fn(),
    analyze: vi.fn(),
    conversations: vi.fn(),
    conversation: vi.fn(),
    credits: vi.fn(),
    byokStatus: vi.fn(),
    connectByok: vi.fn(),
    disconnectByok: vi.fn(),
    datasetDownloadUrl: (id: string) => '/api/datasets/' + id + '/download',
  },
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
      public details?: unknown,
    ) {
      super(message);
      this.name = 'ApiRequestError';
    }
  },
  setCsrfToken: vi.fn(),
}));

const { api, ApiRequestError } = await import('../lib/api.ts');
const { Dashboard } = await import('../pages/Dashboard.tsx');
const { ConnectKeyModal } = await import('../components/ConnectKeyModal.tsx');
const { Composer } = await import('../components/Composer.tsx');
const { Landing } = await import('../pages/Landing.tsx');
const { AuthDialog } = await import('../components/AuthDialog.tsx');
const { AppFooter } = await import('../components/AppFooter.tsx');
const { HeaderMenu } = await import('../components/HeaderMenu.tsx');

/* --------------------------------- fixtures -------------------------------- */

const CONFIG: AppConfigResponse = {
  demoMode: false,
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      keyPlaceholder: 'sk-ant-...',
      requiresModel: false,
      modelsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      modelPlaceholder: null,
      validationNote: 'Validation bills a few tokens.',
      subscriptionNote: 'A Claude Pro or Max subscription does not include API credits.',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      keyUrl: 'https://platform.openai.com/api-keys',
      keyPlaceholder: 'sk-...',
      requiresModel: true,
      modelsUrl: 'https://developers.openai.com/api/docs/models',
      modelPlaceholder: 'gpt-6.1-sol',
      validationNote: 'Validation bills a few tokens.',
      subscriptionNote: 'A ChatGPT Plus or Pro subscription does not include API credits.',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      keyUrl: 'https://openrouter.ai/keys',
      keyPlaceholder: 'sk-or-v1-...',
      requiresModel: true,
      modelsUrl: 'https://openrouter.ai/models?supported_parameters=structured_outputs',
      modelPlaceholder: 'anthropic/claude-sonnet-4.5',
      validationNote: 'Validation bills a small amount.',
      subscriptionNote: 'OpenRouter is pay-as-you-go.',
    },
  ],
  limits: {
    maxUploadBytes: 10 * 1024 * 1024,
    maxRows: 200_000,
    maxColumns: 60,
    maxResultRows: 500,
    datasetTtlHours: 24,
  },
  freeCredits: 5,
  creditsEnabled: true,
  guest: { enabled: true, nudgeAfter: 2, nudgeEvery: 3, questionsLimit: 15 },
};

const SESSION = (
  credits: number,
  aiMode: SessionState['aiMode'] = 'platform',
  creditsApply = aiMode === 'platform',
): SessionState => ({
  user: { id: 'u1', email: 'demo@example.com', isGuest: false, createdAt: new Date().toISOString() },
  credits,
  freeGrantIssued: true,
  aiMode,
  creditsApply,
  byokProvider: aiMode === 'byok' ? 'anthropic' : null,
  csrfToken: 'csrf-token',
  guest: null,
});

const SAMPLE_DETAIL: DatasetDetail = {
  id: 'sample-sales',
  name: 'Sample: Retail Sales 2024',
  kind: 'sample',
  rowCount: 2524,
  columnCount: 8,
  sizeBytes: 100_000,
  createdAt: new Date().toISOString(),
  expiresAt: null,
  columns: [
    { name: 'product', originalName: 'product', type: 'string', nullable: false, sampleValues: ['Aurora Headphones'], nullCount: 0 },
    { name: 'revenue', originalName: 'revenue', type: 'number', nullable: false, sampleValues: ['129'], nullCount: 0 },
  ],
  preview: [{ product: 'Aurora Headphones', revenue: 129 }],
  warnings: [],
};

const ANSWER = (overrides: Partial<AnalysisResponse> = {}): AnalysisResponse => ({
  id: `m-${Math.random()}`,
  conversationId: 'c1',
  outcome: 'answered',
  question: 'Which products generated the most revenue?',
  answer: 'Lumen Monitor 32 leads on revenue with $184,300.',
  sql: 'SELECT product, SUM(revenue) AS total_revenue FROM t GROUP BY product ORDER BY total_revenue DESC LIMIT 10',
  chart: {
    kind: 'bar',
    xKey: 'product',
    yKeys: ['total_revenue'],
    title: 'Revenue by product',
    valueFormat: 'currency',
  },
  result: {
    columns: ['product', 'total_revenue'],
    rows: [
      { product: 'Lumen Monitor 32', total_revenue: 184300 },
      { product: 'Pulse Smartwatch', total_revenue: 121450 },
    ],
    totalRows: 2,
    truncated: false,
  },
  timings: [
    { stage: 'understanding', ms: 4 },
    { stage: 'generating_sql', ms: 1820 },
    { stage: 'running_query', ms: 12 },
    { stage: 'preparing_answer', ms: 980 },
  ],
  totalMs: 2816,
  creditConsumed: true,
  creditsRemaining: 1,
  aiMode: 'platform',
  usage: { inputTokens: 900, outputTokens: 140 },
  simulated: false,
  error: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const noop = () => {};

function renderDashboard(session: SessionState, overrides: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  return render(
    <Dashboard
      session={session}
      config={CONFIG}
      onOpenSettings={noop}
      onOutOfCredits={noop}
      onSessionRefresh={noop}
      onSignOut={noop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.mocked(api.datasets).mockResolvedValue([
    {
      id: 'sample-sales',
      name: 'Sample: Retail Sales 2024',
      kind: 'sample',
      rowCount: 2524,
      columnCount: 8,
      sizeBytes: 100_000,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    },
  ]);
  vi.mocked(api.dataset).mockResolvedValue({
    dataset: SAMPLE_DETAIL,
    exampleQuestions: ['Which products generated the most revenue?', 'How did revenue trend month over month?'],
  });
  vi.mocked(api.credits).mockResolvedValue({ balance: 2, ledger: [] });
  vi.mocked(api.byokStatus).mockResolvedValue({
    connected: false,
    providerId: null,
    model: null,
    fingerprint: null,
    expiresAt: null,
    providers: CONFIG.providers,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------- sample flow ------------------------------- */

describe('sample dataset analysis', () => {
  it('shows the sample dataset and example questions without any upload', async () => {
    renderDashboard(SESSION(2));

    expect(await screen.findByText('Sample: Retail Sales 2024')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    ).toBeInTheDocument();
  });

  it('runs an analysis and renders answer, SQL, table and timings', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());

    renderDashboard(SESSION(2));

    const example = await screen.findByRole('button', {
      name: 'Which products generated the most revenue?',
    });
    await user.click(example);

    expect(await screen.findByText(/Lumen Monitor 32 leads on revenue/)).toBeInTheDocument();

    // The SQL is available in an expandable panel.
    const sqlToggle = screen.getByText('View generated SQL');
    await user.click(sqlToggle);
    expect(screen.getByText(/SELECT product, SUM\(revenue\)/)).toBeInTheDocument();

    // The result table is present with real values. Scope to the answer
    // card, because the sidebar's data preview is also a table.
    const answerCard = screen.getByRole('article');
    expect(within(answerCard).getByRole('table')).toBeInTheDocument();
    expect(
      within(answerCard).getByText((184300).toLocaleString(undefined, { maximumFractionDigits: 2 })),
    ).toBeInTheDocument();
    expect(within(answerCard).getByText('Lumen Monitor 32')).toBeInTheDocument();

    // Measured stage timings are displayed.
    expect(screen.getByText(/Generating SQL/)).toBeInTheDocument();
    expect(screen.getByText('1.8 s')).toBeInTheDocument();
  });

  it('sends a follow-up on the same conversation', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze)
      .mockResolvedValueOnce(ANSWER())
      .mockResolvedValueOnce(
        ANSWER({ question: 'Now show only September', answer: 'In September, revenue was $166,202.' }),
      );

    renderDashboard(SESSION(2));

    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );
    await screen.findByText(/Lumen Monitor 32 leads/);

    const box = screen.getByLabelText('Ask a question about your data');
    await user.type(box, 'Now show only September');
    await user.click(screen.getByRole('button', { name: /^Ask$/ }));

    await waitFor(() => {
      expect(vi.mocked(api.analyze).mock.calls).toHaveLength(2);
    });

    // The second call reuses the conversation id returned by the first.
    const secondCall = vi.mocked(api.analyze).mock.calls[1]![0];
    expect(secondCall.conversationId).toBe('c1');
    expect(secondCall.datasetId).toBe('sample-sales');
    expect(await screen.findByText(/In September, revenue was/)).toBeInTheDocument();
  });

  it('sends a fresh idempotency key per request so a retry cannot double-charge', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    renderDashboard(SESSION(2));

    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );
    await screen.findByText(/Lumen Monitor 32 leads/);

    const call = vi.mocked(api.analyze).mock.calls[0]![0];
    expect(call.idempotencyKey).toBeTruthy();
    expect(call.idempotencyKey.length).toBeGreaterThan(8);
  });

  it('labels a simulated answer as demo mode', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER({ simulated: true, aiMode: 'demo' }));
    renderDashboard(SESSION(2));

    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );
    expect(await screen.findByText(/Demo mode — simulated/)).toBeInTheDocument();
  });

  it('surfaces a clarification without claiming an answer', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(
      ANSWER({
        outcome: 'clarification',
        answer: 'Which margin do you mean — gross or net? Neither column exists in this dataset.',
        sql: null,
        chart: null,
        result: null,
        creditConsumed: false,
      }),
    );
    renderDashboard(SESSION(2));

    const box = await screen.findByLabelText('Ask a question about your data');
    await user.type(box, 'what is the margin');
    await user.click(screen.getByRole('button', { name: /^Ask$/ }));

    expect(await screen.findByText('Needs clarification')).toBeInTheDocument();
    expect(screen.getByText('No credit used')).toBeInTheDocument();
    expect(screen.queryByText('View generated SQL')).not.toBeInTheDocument();
  });
});

/* ------------------------------ exhausted credits --------------------------- */

describe('exhausted credits', () => {
  it('replaces the composer with an upgrade prompt at zero credits', async () => {
    renderDashboard(SESSION(0));
    expect(await screen.findByText(/You've used your 5 free questions/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask a question about your data')).not.toBeInTheDocument();
  });

  it('keeps the composer when BYOK is connected even at zero credits', async () => {
    renderDashboard(SESSION(0, 'byok'));
    expect(await screen.findByLabelText('Ask a question about your data')).toBeInTheDocument();
    expect(screen.getByText('Your API key')).toBeInTheDocument();
  });

  it('does not charge credits in free demo mode', async () => {
    renderDashboard(SESSION(0, 'demo', false));
    await screen.findByText('Demo answers');
    expect(screen.queryByText(/You've used your 5 free questions/)).not.toBeInTheDocument();
  });

  it('offers a way out of demo answers instead of only labelling them', async () => {
    const user = userEvent.setup();
    const onConnectKey = vi.fn();
    renderDashboard(SESSION(0, 'demo', false), { onConnectKey });

    expect(await screen.findByText('Demo answers')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Use real AI' }),
    );
    expect(onConnectKey).toHaveBeenCalled();
  });

  it('still gates demo mode when the operator opts into charging', async () => {
    renderDashboard(SESSION(0, 'demo', true));
    expect(await screen.findByText(/You've used your 5 free questions/)).toBeInTheDocument();
  });

  /* ------------------------ signed-in demo-mode gate ----------------------- */

  describe('real-AI gate', () => {
    /** The conversation column, which is the element the gate makes inert. */
    const chatColumn = () => screen.getByRole('main').firstElementChild as HTMLElement;

    it('stops a signed-in account from asking anything on demo answers', async () => {
      renderDashboard(SESSION(2, 'demo', false));

      expect(
        await screen.findByText('Connect an AI provider to ask questions'),
      ).toBeInTheDocument();
      // `inert` is what enforces it: the textarea and the example-question
      // buttons are still rendered, but nothing inside can be typed in,
      // clicked or tabbed to.
      expect(chatColumn()).toHaveAttribute('inert');
      expect(chatColumn()).toContainElement(
        screen.getByLabelText('Ask a question about your data'),
      );
    });

    it('explains why rather than just refusing', async () => {
      renderDashboard(SESSION(2, 'demo', false));
      expect(await screen.findByText(/canned demo responses/)).toBeInTheDocument();
      expect(screen.getByText(/never written to a database, a log or your browser/))
        .toBeInTheDocument();
    });

    it('the gate button opens the key form', async () => {
      const user = userEvent.setup();
      const onConnectKey = vi.fn();
      renderDashboard(SESSION(2, 'demo', false), { onConnectKey });

      const gate = within(await screen.findByRole('region', { name: 'Real AI required' }));
      await user.click(gate.getByRole('button', { name: 'Use real AI' }));
      expect(onConnectKey).toHaveBeenCalled();
    });

    it('leaves a guest free to explore, since that is the point of the tour', async () => {
      const guest = SESSION(0, 'demo', false);
      renderDashboard({
        ...guest,
        user: { ...guest.user!, isGuest: true, email: null },
        guest: { questionsUsed: 0, questionsLimit: 3, exhausted: false },
      });
      await screen.findByText('Demo · not signed in');
      expect(screen.queryByText('Connect an AI provider to ask questions')).not.toBeInTheDocument();
      expect(chatColumn()).not.toHaveAttribute('inert');
    });

    it('lifts as soon as a key is connected', async () => {
      const { rerender } = renderDashboard(SESSION(2, 'demo', false));
      await screen.findByText('Connect an AI provider to ask questions');

      rerender(
        <Dashboard
          session={SESSION(2, 'byok')}
          config={CONFIG}
          onOpenSettings={noop}
          onOutOfCredits={noop}
          onSessionRefresh={noop}
          onSignOut={noop}
        />,
      );

      await waitFor(() =>
        expect(screen.queryByText('Connect an AI provider to ask questions')).toBeNull(),
      );
      expect(chatColumn()).not.toHaveAttribute('inert');
    });
  });

  it('opens the upgrade modal when the server reports 402', async () => {
    const user = userEvent.setup();
    const onOutOfCredits = vi.fn();
    vi.mocked(api.analyze).mockRejectedValue(
      new ApiRequestError('You have used all of your free questions.', 402, 'insufficient_credits'),
    );

    renderDashboard(SESSION(1), { onOutOfCredits });

    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );
    await waitFor(() => expect(onOutOfCredits).toHaveBeenCalled());
  });

  it('sends an out-of-credits user straight to the key form, with nothing to buy', () => {
    render(
      <ConnectKeyModal
        open
        reason="exhausted"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    expect(screen.getByText("You've used your 5 free questions")).toBeInTheDocument();
    // The form itself, not a menu: there is no second option to offer.
    expect(screen.getByLabelText(/API key/)).toBeInTheDocument();
    expect(screen.queryByText(/Buy credits/)).not.toBeInTheDocument();
    expect(screen.queryByText(/purchase/i)).not.toBeInTheDocument();
  });

  it('says the shared key failed, and that nothing was charged', () => {
    render(
      <ConnectKeyModal
        open
        reason="platform_unavailable"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    expect(screen.getByText('Our shared key is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/you were not charged for it/)).toBeInTheDocument();
  });

  it('opens the key form when the platform key is rejected mid-question', async () => {
    const user = userEvent.setup();
    const onConnectKey = vi.fn();
    vi.mocked(api.analyze).mockRejectedValue(
      new ApiRequestError(
        'The shared API key is not usable right now.',
        503,
        'platform_unavailable',
      ),
    );

    renderDashboard(SESSION(3), { onConnectKey });
    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );

    // Not an error message the user can do nothing about — the one action
    // that unblocks them, with the reason so the copy can explain itself.
    await waitFor(() => expect(onConnectKey).toHaveBeenCalledWith('platform_unavailable'));
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
  });
});

/* ----------------------------------- BYOK ---------------------------------- */

describe('bring your own key', () => {
  it('states that the user’s provider pays and that a chat subscription does not', () => {
    render(
      <ConnectKeyModal
        open
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );

    expect(screen.getByText(/Your provider account pays/)).toBeInTheDocument();
    expect(screen.getByText(/does not include API credits/)).toBeInTheDocument();
    expect(screen.getByText(/Validation bills a few tokens/)).toBeInTheDocument();
    expect(screen.getByText(/never written to our\s+database/)).toBeInTheDocument();
  });

  it('shows the provider error and does not silently fall back', async () => {
    const user = userEvent.setup();
    vi.mocked(api.connectByok).mockRejectedValue(
      new ApiRequestError('The API key was rejected by Anthropic.', 400, 'byok_failed'),
    );
    const onConnected = vi.fn();

    render(
      <ConnectKeyModal
        open
        onClose={noop}
        onConnected={onConnected}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );

    await user.type(screen.getByLabelText(/API key/), 'sk-ant-invalid');
    await user.click(screen.getByRole('button', { name: /Validate & connect/ }));

    expect(await screen.findByText('The API key was rejected by Anthropic.')).toBeInTheDocument();
    // The modal stays open and nothing was connected.
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('uses a password field so the key is not shown or autofilled', () => {
    render(
      <ConnectKeyModal
        open
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    const input = screen.getByLabelText(/API key/);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });
});

/* ------------------------------ CSV download ------------------------------ */

describe('downloading a dataset', () => {
  it('offers every dataset as a CSV download', async () => {
    renderDashboard(SESSION(2));
    const link = await screen.findByRole('link', {
      name: 'Download Sample: Retail Sales 2024 as CSV',
    });

    // An anchor, not a button: the browser streams it to disk itself rather
    // than the page buffering a whole dataset in memory.
    expect(link).toHaveAttribute('href', '/api/datasets/sample-sales/download');
    expect(link).toHaveAttribute('download', 'Sample: Retail Sales 2024.csv');
  });

  it('offers the sample as a worked example inside the upload dialog', async () => {
    const user = userEvent.setup();
    renderDashboard(SESSION(2));
    await screen.findByText('Sample: Retail Sales 2024');
    await user.click(screen.getByRole('button', { name: 'Upload CSV' }));

    const dialog = within(await screen.findByRole('dialog'));
    const link = dialog.getByRole('link', { name: /Download the sample as CSV/ });
    expect(link).toHaveAttribute('href', '/api/datasets/sample-sales/download');
  });
});

/* -------------------------------- CSV upload ------------------------------- */

describe('CSV upload', () => {
  /**
   * The file input lives in the format dialog, which is the only way in from
   * the sidebar button — so every upload test opens it first.
   */
  async function openUploadDialog(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByText('Sample: Retail Sales 2024');
    await user.click(screen.getByRole('button', { name: 'Upload CSV' }));
    return within(await screen.findByRole('dialog'));
  }

  it('explains the expected format before asking for a file', async () => {
    const user = userEvent.setup();
    renderDashboard(SESSION(2));
    const dialog = await openUploadDialog(user);

    // The worked example and the rules that the parser actually enforces.
    expect(dialog.getByRole('columnheader', { name: 'order_date' })).toBeInTheDocument();
    expect(dialog.getByRole('cell', { name: '$1,240.50' })).toBeInTheDocument();
    expect(dialog.getByText(/The first row must be the column names/)).toBeInTheDocument();
    expect(dialog.getByText(/no totals row at the bottom/)).toBeInTheDocument();
    expect(dialog.getByText(/Blank, NULL, NA and - are all read as missing/)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Choose a CSV file' })).toBeInTheDocument();
  });

  it('rejects a non-CSV file before it reaches the network', async () => {
    const user = userEvent.setup();
    renderDashboard(SESSION(2));
    await openUploadDialog(user);

    // userEvent.upload filters by the input's accept attribute, so a .json
    // file would never reach the handler. Fire the change directly to prove
    // the client-side guard also holds for a drag-and-drop style delivery.
    const input = document.getElementById('vq-csv-input') as HTMLInputElement;
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText('Only .csv files are supported.')).toBeInTheDocument();
    expect(api.uploadCsv).not.toHaveBeenCalled();
  });

  it('shows the server’s validation message and hint on a bad CSV', async () => {
    const user = userEvent.setup();
    vi.mocked(api.uploadCsv).mockRejectedValue(
      new ApiRequestError('No header row was found.', 422, 'invalid_csv', {
        hint: 'The first row must contain column names.',
      }),
    );

    renderDashboard(SESSION(2));
    await openUploadDialog(user);

    const input = document.getElementById('vq-csv-input') as HTMLInputElement;
    await user.upload(input, new File(['a,b\n'], 'bad.csv', { type: 'text/csv' }));

    expect(await screen.findByText('No header row was found.')).toBeInTheDocument();
    expect(screen.getByText('The first row must contain column names.')).toBeInTheDocument();
    // The dialog stays open on failure so the guidance is still on screen.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('adds an uploaded dataset and shows its inferred schema and warnings', async () => {
    const user = userEvent.setup();
    const uploaded: DatasetDetail = {
      ...SAMPLE_DETAIL,
      id: 'ds-2',
      name: 'my-sales',
      kind: 'upload',
      rowCount: 3,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      warnings: ['Duplicate column "Amount" was renamed to "amount_2".'],
    };
    vi.mocked(api.uploadCsv).mockResolvedValue(uploaded);
    vi.mocked(api.dataset).mockResolvedValue({ dataset: uploaded, exampleQuestions: [] });

    renderDashboard(SESSION(2));
    await openUploadDialog(user);

    const input = document.getElementById('vq-csv-input') as HTMLInputElement;
    await user.upload(input, new File(['a,b\n1,2'], 'my-sales.csv', { type: 'text/csv' }));

    expect(await screen.findByText('my-sales')).toBeInTheDocument();
    expect(
      await screen.findByText('Duplicate column "Amount" was renamed to "amount_2".'),
    ).toBeInTheDocument();
    // …and closes on success, revealing the schema it just loaded.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('states the upload limits and the expiry policy', async () => {
    renderDashboard(SESSION(2));
    // The sentence is interpolated across several nodes, so assert on the
    // rendered text of the upload panel as a whole.
    await screen.findByText(/Uploads are deleted automatically after 24 hours./);
    expect(document.body.textContent).toContain(
      `max 10.0 MB, ${(200_000).toLocaleString()} rows, 60 columns`,
    );
    expect(
      screen.getByText('Uploads are deleted automatically after 24 hours.'),
    ).toBeInTheDocument();
  });
});

/* ------------------------------ voice fallback ------------------------------ */

describe('microphone fallback', () => {
  it('explains the fallback and keeps typing available with no speech support', async () => {
    // jsdom has no SpeechRecognition, which is exactly the unsupported case.
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);

    expect(
      screen.getByText(/Voice input is not available in this browser/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask by voice')).not.toBeInTheDocument();

    // Typing still works.
    await user.type(screen.getByLabelText('Ask a question about your data'), 'total revenue');
    await user.click(screen.getByRole('button', { name: /^Ask$/ }));
    expect(onSubmit).toHaveBeenCalledWith('total revenue');
  });

  it('offers the microphone when the browser supports it', async () => {
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: unknown = null;
      onerror: unknown = null;
      onend: unknown = null;
      onstart: (() => void) | null = null;
      start() {
        this.onstart?.();
      }
      stop() {}
      abort() {}
    }
    (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;

    try {
      render(<Composer onSubmit={noop} />);
      expect(await screen.findByLabelText('Ask by voice')).toBeInTheDocument();
      expect(
        screen.queryByText(/Voice input is not available/),
      ).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    }
  });

  it('submits on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Ask a question about your data');

    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(box, '{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
  });
});

/* ------------------------------- accessibility ------------------------------ */

describe('accessibility', () => {
  it('exposes the analysis progress as a live region', async () => {
    const user = userEvent.setup();
    let resolve!: (value: AnalysisResponse) => void;
    vi.mocked(api.analyze).mockReturnValue(
      new Promise<AnalysisResponse>((r) => {
        resolve = r;
      }),
    );

    renderDashboard(SESSION(2));
    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );

    const progress = await screen.findByLabelText('Analysis progress');
    expect(progress).toHaveAttribute('aria-live', 'polite');
    expect(within(progress).getByText('Understanding your question')).toBeInTheDocument();

    resolve(ANSWER());
    await screen.findByText(/Lumen Monitor 32 leads/);
  });

  it('gives the result table a caption describing the row count', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    renderDashboard(SESSION(2));

    await user.click(
      await screen.findByRole('button', { name: 'Which products generated the most revenue?' }),
    );
    const answerCard = await screen.findByRole('article');
    const table = within(answerCard).getByRole('table');
    expect(within(table).getByText(/Query results: 2 of 2 rows/)).toBeInTheDocument();
  });

  it('marks the selected dataset with aria-current', async () => {
    renderDashboard(SESSION(2));
    const button = await screen.findByRole('button', { name: /Sample: Retail Sales 2024/ });
    await waitFor(() => expect(button).toHaveAttribute('aria-current', 'true'));
  });
});

/* ------------------------- allowance copy honesty ------------------------- */

describe('free-allowance copy', () => {
  // Guest mode is off in these fixtures: with it on the landing page leads
  // with "no sign-up needed" instead, which is covered in guest.test.tsx.
  const METERED = { ...CONFIG, guest: { ...CONFIG.guest, enabled: false } };
  const FREE_DEMO = { ...METERED, demoMode: true, creditsEnabled: false };

  it('promises free questions when credits are actually metered', () => {
    render(<Landing config={METERED} hasAccount={false} onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />);
    expect(screen.getByText(/5 free questions with an account/)).toBeInTheDocument();
  });

  /**
   * The promise has to track where the questions would actually come from.
   * On a deployment with no provider key of its own, an account gets you the
   * bring-your-own-key form, not five free answers — so the landing page must
   * not say otherwise.
   */
  it('does not promise a free allowance when nothing is metered', () => {
    render(<Landing config={FREE_DEMO} hasAccount={false} onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />);
    expect(screen.queryByText(/free questions with an account/)).not.toBeInTheDocument();
    expect(screen.getByText(/Bring your own API key/)).toBeInTheDocument();
  });

  it('labels demo mode on the landing page', () => {
    render(<Landing config={FREE_DEMO} hasAccount={false} onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />);
    expect(
      screen.getByText(/answers come from a local stand-in, not an AI model/),
    ).toBeInTheDocument();
  });

  it('keeps the allowance out of the sign-up dialog when nothing is metered', () => {
    render(
      <AuthDialog
        open
        onClose={noop}
        onAuthenticated={noop}
        freeCredits={5}
        creditsEnabled={false}
      />,
    );
    expect(screen.queryByText(/free questions/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('shows the allowance in the sign-up dialog when it is real', () => {
    render(
      <AuthDialog open onClose={noop} onAuthenticated={noop} freeCredits={5} creditsEnabled />,
    );
    expect(screen.getByText(/New accounts get 5 free questions/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create account & get 5 free questions/ }),
    ).toBeInTheDocument();
  });
});

/* ------------------------- reaching the key form -------------------------- */

/**
 * These exist because the BYOK form was once only reachable by running out of
 * credits — which cannot happen in free demo mode, leaving no way at all to
 * enter a key. Each test pins one entry point open.
 */
describe('connecting an API key is reachable', () => {
  it('opens straight to the key form when asked', () => {
    render(
      <ConnectKeyModal
        open
        reason="upgrade"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    // The key field is present without any intermediate click.
    expect(screen.getByLabelText(/API key/)).toBeInTheDocument();
  });

  it('does not claim the allowance is exhausted when it is not', () => {
    render(
      <ConnectKeyModal
        open
        reason="upgrade"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    expect(screen.getByText('Use your own AI provider key')).toBeInTheDocument();
    expect(screen.queryByText(/You've used your 5 free questions/)).not.toBeInTheDocument();
  });

  it('still says so when the allowance really is exhausted', () => {
    render(
      <ConnectKeyModal
        open
        reason="exhausted"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
    expect(screen.getByText("You've used your 5 free questions")).toBeInTheDocument();
  });
});

/* --------------------------- multiple providers --------------------------- */

describe('provider selection', () => {
  function openByok() {
    return render(
      <ConnectKeyModal
        open
        reason="upgrade"
        onClose={noop}
        onConnected={noop}
        providers={CONFIG.providers}
        freeCredits={5}
      />,
    );
  }

  it('offers every configured provider', () => {
    openByok();
    const select = screen.getByLabelText('Provider') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['anthropic', 'openai', 'openrouter']);
  });

  it('asks for no model when the provider does not need one', () => {
    openByok();
    // Anthropic is first and uses the server's configured model.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/API key/)).toHaveAttribute('placeholder', 'sk-ant-...');
  });

  it('asks for a model when switching to OpenAI', async () => {
    const user = userEvent.setup();
    openByok();
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');

    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toHaveAttribute('placeholder', 'gpt-6.1-sol');
    expect(screen.getByLabelText(/API key/)).toHaveAttribute('placeholder', 'sk-...');
  });

  it('asks for a vendor-prefixed model on OpenRouter', async () => {
    const user = userEvent.setup();
    openByok();
    await user.selectOptions(screen.getByLabelText('Provider'), 'openrouter');

    expect(screen.getByLabelText('Model')).toHaveAttribute(
      'placeholder',
      'anthropic/claude-sonnet-4.5',
    );
    expect(screen.getByLabelText(/API key/)).toHaveAttribute('placeholder', 'sk-or-v1-...');
  });

  it('sends the model along with the key', async () => {
    const user = userEvent.setup();
    vi.mocked(api.connectByok).mockResolvedValue({
      connected: true,
      providerId: 'openai',
      model: 'gpt-6-luna',
      fingerprint: 'abc123',
    });

    openByok();
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await user.type(screen.getByLabelText(/API key/), 'sk-test-key-value');
    await user.type(screen.getByLabelText('Model'), 'gpt-6-luna');
    await user.click(screen.getByRole('button', { name: /Validate & connect/ }));

    await waitFor(() =>
      expect(api.connectByok).toHaveBeenCalledWith('openai', 'sk-test-key-value', 'gpt-6-luna'),
    );
  });

  it('omits the model for a provider that does not take one', async () => {
    const user = userEvent.setup();
    vi.mocked(api.connectByok).mockResolvedValue({
      connected: true,
      providerId: 'anthropic',
      model: null,
      fingerprint: 'abc123',
    });

    openByok();
    await user.type(screen.getByLabelText(/API key/), 'sk-ant-test-key');
    await user.click(screen.getByRole('button', { name: /Validate & connect/ }));

    await waitFor(() =>
      expect(api.connectByok).toHaveBeenCalledWith('anthropic', 'sk-ant-test-key', undefined),
    );
  });

  it('clears a stale model when the provider changes', async () => {
    const user = userEvent.setup();
    openByok();
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await user.type(screen.getByLabelText('Model'), 'gpt-6-luna');

    // An OpenAI model id is meaningless to OpenRouter.
    await user.selectOptions(screen.getByLabelText('Provider'), 'openrouter');
    expect(screen.getByLabelText('Model')).toHaveValue('');
  });

  it('shows each provider’s own subscription caveat', async () => {
    const user = userEvent.setup();
    openByok();
    expect(screen.getByText(/Claude Pro or Max subscription/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    expect(screen.getByText(/ChatGPT Plus or Pro subscription/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Provider'), 'openrouter');
    expect(screen.getByText(/pay-as-you-go/)).toBeInTheDocument();
  });
});

/* ---------------------- header honesty about who answers ------------------ */

/**
 * The header once carried a "Demo mode" badge driven by `config.demoMode` —
 * whether the *server* had a platform key. That stayed lit even after a user
 * connected their own key and was getting real AI answers, which is simply a
 * false statement. Everything shown now derives from `session.aiMode`.
 */
describe('header reflects who is actually answering', () => {
  const DEMO_DEPLOYMENT = { ...CONFIG, demoMode: true, creditsEnabled: false };

  it('says nothing about demo mode once the user’s own key is connected', async () => {
    render(
      <Dashboard
        session={SESSION(0, 'byok')}
        config={DEMO_DEPLOYMENT}
        onOpenSettings={noop}
        onOutOfCredits={noop}
        onSessionRefresh={noop}
        onSignOut={noop}
      />,
    );

    expect(await screen.findByText('Your API key')).toBeInTheDocument();
    expect(screen.queryByText('Demo mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo answers')).not.toBeInTheDocument();
    expect(screen.queryByText(/not signed in/)).not.toBeInTheDocument();
  });

  it('still labels demo answers when no key is connected', async () => {
    render(
      <Dashboard
        session={SESSION(0, 'demo', false)}
        config={DEMO_DEPLOYMENT}
        onOpenSettings={noop}
        onOutOfCredits={noop}
        onSessionRefresh={noop}
        onSignOut={noop}
      />,
    );
    expect(await screen.findByText('Demo answers')).toBeInTheDocument();
  });

  it('drops the landing-page demo banner for a BYOK visitor', () => {
    const { rerender } = render(
      <Landing config={DEMO_DEPLOYMENT} hasAccount onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />,
    );
    expect(screen.getByText(/answers come from a local stand-in/)).toBeInTheDocument();

    rerender(
      <Landing config={DEMO_DEPLOYMENT} hasAccount realAiActive onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />,
    );
    expect(screen.queryByText(/answers come from a local stand-in/)).not.toBeInTheDocument();
  });
});

describe('persistent credit footer', () => {
  it('names both authors', () => {
    render(<AppFooter />);
    expect(screen.getByText('Harit')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('is fixed to the viewport so it survives scrolling', () => {
    const { container } = render(<AppFooter />);
    const footer = container.querySelector('footer')!;
    expect(footer.className).toContain('fixed');
    expect(footer.className).toContain('bottom-0');
  });

  it('hides the decorative heart from screen readers', () => {
    const { container } = render(<AppFooter />);
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('💙');
  });
});

/* ------------------------------ header menu ------------------------------ */

/**
 * The collapsed header. jsdom does not apply the media queries, so these
 * drive the component directly rather than trying to simulate a phone.
 */
describe('header menu', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* not available in every environment */
    }
  });

  it('keeps its items out of the page until opened', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HeaderMenu items={[{ label: 'Sign out', onSelect }]} />);

    // Matters because the same labels exist as inline buttons at wider
    // widths — if the menu rendered them while closed, every query for
    // "Sign out" would match twice.
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    // …and it closes behind the choice.
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('closes on Escape without choosing anything', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<HeaderMenu items={[{ label: 'Settings', onSelect }]} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('stops drawing attention once the menu has been found', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<HeaderMenu attention items={[{ label: 'X', onSelect: noop }]} />);

    const button = () => screen.getByRole('button', { name: 'Menu' });
    expect(button()).toHaveClass('vq-attention');

    await user.click(button());
    expect(button()).not.toHaveClass('vq-attention');

    // And it stays found: a cue that returns on every visit is just noise.
    unmount();
    render(<HeaderMenu attention items={[{ label: 'X', onSelect: noop }]} />);
    expect(screen.getByRole('button', { name: 'Menu' })).not.toHaveClass('vq-attention');
  });
});

/* --------------- the attention ring is remembered per menu ---------------- */

describe('attention ring scoping', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* not available everywhere */
    }
  });

  it('finding one menu does not silence another', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <HeaderMenu attention attentionKey="landing" items={[{ label: 'A', onSelect: noop }]} />,
    );
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    unmount();

    // A different menu holds different things, so finding the first teaches
    // the user nothing about the second. Sharing one key meant the dashboard
    // menu never pulsed at all once the landing one had been opened.
    render(
      <HeaderMenu attention attentionKey="dashboard" items={[{ label: 'B', onSelect: noop }]} />,
    );
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveClass('vq-attention');
  });
});
