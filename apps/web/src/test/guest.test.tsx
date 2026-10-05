import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalysisResponse, AppConfigResponse, DatasetDetail, SessionState } from '@voicequery/shared';

/** Guest (not-signed-in) flows. */

vi.mock('../lib/api.ts', () => ({
  api: {
    config: vi.fn(),
    session: vi.fn(),
    startGuest: vi.fn(),
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
const { Landing } = await import('../pages/Landing.tsx');
const { GuestNudgeModal } = await import('../components/GuestNudgeModal.tsx');
const { default: App } = await import('../App.tsx');

const noop = () => {};

const CONFIG: AppConfigResponse = {
  demoMode: true,
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
  freeCredits: 2,
  creditsEnabled: false,
  guest: { enabled: true, nudgeAfter: 2, nudgeEvery: 3, questionsLimit: 15 },
};

const GUEST = (questionsUsed: number, exhausted = false): SessionState => ({
  user: { id: 'g1', email: null, isGuest: true, createdAt: new Date().toISOString() },
  credits: 0,
  freeGrantIssued: false,
  aiMode: 'demo',
  creditsApply: false,
  byokProvider: null,
  csrfToken: 'csrf-token',
  guest: { questionsUsed, questionsLimit: 15, exhausted },
});

const SAMPLE: DatasetDetail = {
  id: 'sample-sales',
  name: 'Sample: Retail Sales 2024',
  kind: 'sample',
  rowCount: 2524,
  columnCount: 8,
  sizeBytes: 100_000,
  createdAt: new Date().toISOString(),
  expiresAt: null,
  columns: [
    { name: 'product', originalName: 'product', type: 'string', nullable: false, sampleValues: [], nullCount: 0 },
  ],
  preview: [],
  warnings: [],
};

const ANSWER = (): AnalysisResponse => ({
  id: `m-${Math.random()}`,
  conversationId: 'c1',
  outcome: 'answered',
  question: 'Which products generated the most revenue?',
  answer: 'Lumen Monitor 32 leads on revenue.',
  sql: 'SELECT product, SUM(revenue) AS r FROM t GROUP BY product',
  chart: null,
  result: { columns: ['product', 'r'], rows: [{ product: 'Lumen Monitor 32', r: 1 }], totalRows: 1, truncated: false },
  timings: [{ stage: 'understanding', ms: 1 }],
  totalMs: 10,
  creditConsumed: false,
  creditsRemaining: 0,
  aiMode: 'demo',
  usage: null,
  simulated: true,
  error: null,
  createdAt: new Date().toISOString(),
});

function renderDashboard(session: SessionState, overrides: Record<string, unknown> = {}) {
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

const EXAMPLE = 'Which products generated the most revenue?';

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
  vi.mocked(api.dataset).mockResolvedValue({ dataset: SAMPLE, exampleQuestions: [EXAMPLE] });
});

afterEach(() => vi.clearAllMocks());

describe('guest dashboard', () => {
  it('lets an anonymous visitor ask without signing in', async () => {
    const user = userEvent.setup();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    renderDashboard(GUEST(0));

    expect(await screen.findByText('Demo · not signed in')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    expect(await screen.findByText(/Lumen Monitor 32 leads/)).toBeInTheDocument();
  });

  it('replaces the upload control with a sign-up prompt', async () => {
    renderDashboard(GUEST(0));
    expect(await screen.findByText(/Uploading a CSV needs a free account/)).toBeInTheDocument();
    expect(document.getElementById('vq-csv-input')).toBeNull();
  });

  it('states that demo answers are not AI output', async () => {
    renderDashboard(GUEST(0));
    expect(
      await screen.findByText(/Demo answers are generated by a local rule, not an AI model/),
    ).toBeInTheDocument();
  });

  it('hides settings and sign-out for a guest', async () => {
    renderDashboard(GUEST(0));
    await screen.findByText('Demo · not signed in');
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up free' })).toBeInTheDocument();
  });
});

describe('guest nudge cadence', () => {
  it('does not nudge before the threshold', async () => {
    const user = userEvent.setup();
    const onGuestNudge = vi.fn();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    renderDashboard(GUEST(0), { onGuestNudge });

    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    await screen.findByText(/Lumen Monitor 32 leads/);
    expect(onGuestNudge).not.toHaveBeenCalled();
  });

  it('nudges on the nudgeAfter-th answer', async () => {
    const user = userEvent.setup();
    const onGuestNudge = vi.fn();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    // One answer already given, so this one is the 2nd = nudgeAfter.
    renderDashboard(GUEST(1), { onGuestNudge });

    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    await waitFor(() => expect(onGuestNudge).toHaveBeenCalledWith(false));
  });

  it('repeats every nudgeEvery answers afterwards', async () => {
    const user = userEvent.setup();
    const onGuestNudge = vi.fn();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    // nudgeAfter=2, nudgeEvery=3 → 2, 5, 8. This answer is the 5th.
    renderDashboard(GUEST(4), { onGuestNudge });

    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    await waitFor(() => expect(onGuestNudge).toHaveBeenCalledWith(false));
  });

  it('stays quiet on an answer between nudges', async () => {
    const user = userEvent.setup();
    const onGuestNudge = vi.fn();
    vi.mocked(api.analyze).mockResolvedValue(ANSWER());
    // 4th answer: after the first nudge, before the next.
    renderDashboard(GUEST(3), { onGuestNudge });

    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    await screen.findByText(/Lumen Monitor 32 leads/);
    expect(onGuestNudge).not.toHaveBeenCalled();
  });

  it('raises a blocking nudge when the server refuses at the ceiling', async () => {
    const user = userEvent.setup();
    const onGuestNudge = vi.fn();
    vi.mocked(api.analyze).mockRejectedValue(
      new ApiRequestError('The demo is limited to 15 questions.', 403, 'guest_limit'),
    );
    renderDashboard(GUEST(15), { onGuestNudge });

    await user.click(await screen.findByRole('button', { name: EXAMPLE }));
    await waitFor(() => expect(onGuestNudge).toHaveBeenCalledWith(true));
  });

  it('replaces the composer once the ceiling is reached', async () => {
    renderDashboard(GUEST(15, true));
    expect(await screen.findByText(/used all 15 demo questions/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask a question about your data')).not.toBeInTheDocument();
  });
});

describe('guest nudge modal', () => {
  const props = {
    open: true,
    questionsUsed: 2,
    questionsLimit: 15,
    onClose: noop,
    onSignIn: noop,
  };

  it('offers Cancel, and Cancel only closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSignIn = vi.fn();
    render(<GuestNudgeModal {...props} blocking={false} onClose={onClose} onSignIn={onSignIn} />);

    expect(screen.getByText('Enjoying the demo?')).toBeInTheDocument();
    // The nudge must not imply the demo has stopped working.
    expect(screen.getByText(/keep exploring without an account/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('routes OK to sign-up', async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn();
    render(<GuestNudgeModal {...props} blocking={false} onSignIn={onSignIn} />);
    await user.click(screen.getByRole('button', { name: /OK, sign me up/ }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it('says plainly that demo answers are not from a model', () => {
    render(<GuestNudgeModal {...props} blocking={false} />);
    expect(screen.getByText(/not an AI model/)).toBeInTheDocument();
  });

  it('drops the keep-exploring option when blocking', () => {
    render(<GuestNudgeModal {...props} blocking questionsUsed={15} />);
    expect(screen.getByText(/end of the demo/)).toBeInTheDocument();
    // Offering "keep exploring" would be false once the server refuses.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByText(/keep exploring without an account/)).not.toBeInTheDocument();
    // Earlier results stay reachable.
    expect(screen.getByRole('button', { name: /review my earlier results/ })).toBeInTheDocument();
  });
});

describe('landing copy with guest mode', () => {
  it('leads with real answers and offers the demo second', () => {
    render(<Landing config={CONFIG} signedIn={false} onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />);

    // Both routes are offered, but the demo is explicitly the lesser one —
    // leading with it would be selling the simulation rather than the
    // product.
    expect(screen.getAllByRole('button', { name: 'Get real answers' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Try the demo' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/the demo answers are simulated/)).toBeInTheDocument();
  });

  it('drops the demo button entirely when guest mode is off', () => {
    const noGuest = {
      ...CONFIG,
      creditsEnabled: true,
      guest: { ...CONFIG.guest, enabled: false },
    };
    render(<Landing config={noGuest} signedIn={false} onTryDemo={noop} onSignIn={noop} onGetStarted={noop} />);
    expect(screen.queryByRole('button', { name: 'Try the demo' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Get real answers' }).length).toBeGreaterThan(0);
  });
});

/* ---------------------- entering the demo from the top --------------------- */

/**
 * The whole App, so "Try the demo" is exercised through the real handler
 * rather than a stubbed callback. These cover a regression where any failure
 * from startGuest — including the API simply being down — was answered with
 * the create-account dialog, which blames the visitor for an outage and
 * contradicts the "no sign-up needed" promise they just read.
 */
describe('clicking Try the demo', () => {
  beforeEach(() => {
    vi.mocked(api.config).mockResolvedValue(CONFIG);
    vi.mocked(api.session).mockResolvedValue({
      user: null,
      credits: 0,
      freeGrantIssued: false,
      aiMode: 'demo',
      creditsApply: false,
      byokProvider: null,
      csrfToken: null,
      guest: null,
    });
    vi.mocked(api.datasets).mockResolvedValue([]);
  });

  async function clickTryTheDemo() {
    const user = userEvent.setup();
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'Try the demo' });
    await user.click(buttons[0]!);
    return user;
  }

  it('goes straight into the demo and explains what it is', async () => {
    vi.mocked(api.startGuest).mockResolvedValue(GUEST(0));
    await clickTryTheDemo();

    // No account step at all.
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();

    // Straight to the dashboard, with the expectation-setting dialog over it.
    expect(await screen.findByText("You're in demo mode")).toBeInTheDocument();
    expect(screen.getByText(/Answers are simulated/)).toBeInTheDocument();
    // …and it does not oversell the problem either: the engine is genuine.
    expect(screen.getByText(/Everything else is real/)).toBeInTheDocument();
  });

  it('dismisses to the working dashboard', async () => {
    vi.mocked(api.startGuest).mockResolvedValue(GUEST(0));
    const user = await clickTryTheDemo();

    await screen.findByText("You're in demo mode");
    await user.click(screen.getByRole('button', { name: 'Explore the demo' }));

    await waitFor(() =>
      expect(screen.queryByText("You're in demo mode")).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Demo · not signed in')).toBeInTheDocument();
  });

  it('reports an unreachable API instead of demanding an account', async () => {
    vi.mocked(api.startGuest).mockRejectedValue(new TypeError('Failed to fetch'));
    await clickTryTheDemo();

    expect(await screen.findByText(/Could not reach the VoiceQuery API/)).toBeInTheDocument();
    expect(screen.queryByText('Create your account')).not.toBeInTheDocument();
  });

  it('does offer an account when the server refuses anonymous access', async () => {
    vi.mocked(api.startGuest).mockRejectedValue(
      new ApiRequestError('Anonymous demo access is disabled.', 403, 'guest_disabled'),
    );
    await clickTryTheDemo();

    // A 403 is the one case where an account really is the only way in.
    expect(await screen.findByText('Create your account')).toBeInTheDocument();
  });
});

/* ------------------------------ the backdrop ------------------------------ */

/**
 * The 3D field is decoration. The failure modes that matter are not visual:
 * a full-viewport fixed layer that swallows clicks, or one that a screen
 * reader walks through announcing fragments of SQL.
 */
describe('background field', () => {
  beforeEach(() => {
    vi.mocked(api.config).mockResolvedValue(CONFIG);
    vi.mocked(api.session).mockResolvedValue({
      user: null,
      credits: 0,
      freeGrantIssued: false,
      aiMode: 'demo',
      creditsApply: false,
      byokProvider: null,
      csrfToken: null,
      guest: null,
    });
    vi.mocked(api.datasets).mockResolvedValue([]);
  });

  it('is hidden from assistive technology and takes no pointer events', async () => {
    render(<App />);
    await screen.findAllByRole('button', { name: 'Try the demo' });

    const field = document.querySelector('.vq-field');
    expect(field).not.toBeNull();
    expect(field).toHaveAttribute('aria-hidden', 'true');
    // The class sets pointer-events: none; assert the contract it relies on
    // is still declared, since losing it makes the whole page unclickable.
    expect(field).toHaveClass('vq-field');

    // Nothing inside it should be reachable as content.
    expect(field!.querySelectorAll('button, a, input')).toHaveLength(0);
  });

  it('does not stop the page being used', async () => {
    const user = userEvent.setup();
    vi.mocked(api.startGuest).mockResolvedValue(GUEST(0));
    render(<App />);

    const buttons = await screen.findAllByRole('button', { name: 'Try the demo' });
    await user.click(buttons[0]!);

    expect(await screen.findByText("You're in demo mode")).toBeInTheDocument();
  });
});
