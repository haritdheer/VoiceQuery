import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalysisResponse,
  AppConfigResponse,
  DatasetDetail,
  DatasetSummary,
  SessionState,
  StageName,
} from '@voicequery/shared';
import { Alert, Badge, Button, Card, cx } from '../components/ui.tsx';
import { Composer } from '../components/Composer.tsx';
import { DatasetPanel } from '../components/DatasetPanel.tsx';
import { MessageCard, PendingCard } from '../components/MessageCard.tsx';
import { api, ApiRequestError } from '../lib/api.ts';
import { FOOTER_SPACER_CLASS } from '../components/AppFooter.tsx';
import type { ConnectKeyReason } from '../components/ConnectKeyModal.tsx';
import { HeaderMenu } from '../components/HeaderMenu.tsx';
import { DemoBadge } from '../components/DemoBadge.tsx';

/**
 * The working surface: dataset selection on the left, conversation on the right.
 *
 * Stage progress is advanced on a timer purely as a *display* affordance while
 * the request is in flight — the numbers shown once the answer arrives are the
 * server's measured timings, never these estimates.
 */
export function Dashboard({
  session,
  config,
  onOpenSettings,
  onOutOfCredits,
  onSessionRefresh,
  onSignOut,
  onGuestNudge,
  onSignUp,
  onConnectKey,
  onBack,
  openUploadToken,
}: {
  session: SessionState;
  config: AppConfigResponse;
  onOpenSettings: () => void;
  onOutOfCredits: () => void;
  onSessionRefresh: () => void;
  onSignOut: () => void;
  /** Raised when a guest should be shown the sign-in nudge. */
  onGuestNudge?: (blocking: boolean) => void;
  onSignUp?: () => void;
  /** Changing this opens the CSV upload dialog. */
  openUploadToken?: number;
  /** Leaves the dashboard for the landing page, keeping the session. */
  onBack?: () => void;
  /** Opens the provider-key form directly, with the reason it is showing. */
  onConnectKey?: (reason?: ConnectKeyReason) => void;
}) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [exampleQuestions, setExampleQuestions] = useState<string[]>([]);

  const [messages, setMessages] = useState<AnalysisResponse[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const [pending, setPending] = useState<{ question: string; stage: StageName; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  /* ------------------------------ initial load ----------------------------- */

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.datasets();
        setDatasets(list);
        // Default to the sample so the demo is one click from useful.
        const initial = list.find((d) => d.kind === 'sample') ?? list[0];
        if (initial) setSelectedId(initial.id);
      } catch {
        setError('Could not load your datasets.');
      } finally {
        setLoadingDatasets(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void (async () => {
      try {
        const res = await api.dataset(selectedId);
        setDetail(res.dataset);
        setExampleQuestions(res.exampleQuestions);
      } catch {
        setDetail(null);
        setExampleQuestions([]);
      }
    })();
  }, [selectedId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending]);

  /* ------------------------------ stage ticker ----------------------------- */

  useEffect(() => {
    if (!pending) return;
    const started = pending.startedAt;
    const timer = setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(ms);
      // Display-only progression; real timings replace this on completion.
      setPending((p) => {
        if (!p) return p;
        const stage: StageName =
          ms > 4500 ? 'preparing_answer' : ms > 2200 ? 'running_query' : ms > 700 ? 'generating_sql' : 'understanding';
        return p.stage === stage ? p : { ...p, stage };
      });
    }, 120);
    return () => clearInterval(timer);
  }, [pending?.startedAt]);

  /* ------------------------------ derived state ---------------------------- */

  // `creditsApply` is decided by the server, so BYOK and free demo mode are
  // both covered without the client re-deriving the precedence rules.
  const outOfCredits = session.creditsApply && session.credits <= 0;
  const isGuest = Boolean(session.user?.isGuest);
  const guestExhausted = Boolean(session.guest?.exhausted);

  /**
   * A signed-in account with nothing but the demo provider behind it.
   *
   * Guests are excluded deliberately: canned answers are the whole point of
   * the anonymous tour, and it is what keeps anonymous traffic off a paid
   * endpoint. But someone who has made an account is past the tour — letting
   * them keep asking questions would just be teaching them that the product
   * makes things up. `aiMode` is the server's per-session verdict, so this
   * clears the moment a key is connected.
   */
  const demoLocked = !isGuest && session.aiMode === 'demo';

  /* -------------------------------- analysis ------------------------------- */

  const ask = useCallback(
    async (question: string) => {
      if (!selectedId) return;
      // The gate makes this unreachable through the UI; this is the guard for
      // a stale closure or a voice result landing after the mode changed.
      if (demoLocked) return;
      setError(null);

      // A stable key means a retry of this exact request cannot double-charge.
      const idempotencyKey = crypto.randomUUID();
      const controller = new AbortController();
      abortRef.current = controller;

      setPending({ question, stage: 'understanding', startedAt: Date.now() });
      setElapsed(0);

      try {
        const response = await api.analyze({
          datasetId: selectedId,
          question,
          conversationId,
          idempotencyKey,
          signal: controller.signal,
        });
        setMessages((prev) => [...prev, response]);
        setConversationId(response.conversationId);
        onSessionRefresh();

        // Nudge a guest after `nudgeAfter` answers, then every `nudgeEvery`.
        // The count comes from the server's session state, not a local
        // counter, so it survives a reload and can't be reset by refreshing.
        if (isGuest && onGuestNudge) {
          const answered = (session.guest?.questionsUsed ?? 0) + 1;
          const { nudgeAfter, nudgeEvery } = config.guest;
          const due =
            answered === nudgeAfter ||
            (answered > nudgeAfter && (answered - nudgeAfter) % nudgeEvery === 0);
          if (due) onGuestNudge(false);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setError('That analysis was cancelled. No credit was charged.');
        } else if (err instanceof ApiRequestError) {
          if (err.code === 'guest_limit') {
            // The server refused, so this nudge is a wall rather than a hint.
            onGuestNudge?.(true);
            onSessionRefresh();
          } else if (err.code === 'account_required') {
            onGuestNudge?.(false);
          } else if (err.code === 'insufficient_credits') {
            onOutOfCredits();
            onSessionRefresh();
          } else if (err.code === 'platform_unavailable') {
            // The operator's key is rejected or out of quota. Nothing the
            // user can retry, and the credit was refunded — so go straight
            // to the only thing that unblocks them rather than showing an
            // error they can do nothing about.
            onConnectKey?.('platform_unavailable');
            onSessionRefresh();
          } else if (err.code === 'byok_failed') {
            setError(
              `${err.message} Your key was not used to run this. Reconnect a working key, or disconnect it to use your free questions.`,
            );
          } else {
            setError(err.message);
          }
        } else {
          setError('Something went wrong. Please try again.');
        }
      } finally {
        setPending(null);
        abortRef.current = null;
      }
    },
    [
      selectedId,
      conversationId,
      demoLocked,
      isGuest,
      session.guest?.questionsUsed,
      config.guest,
      onGuestNudge,
      onOutOfCredits,
      onConnectKey,
      onSessionRefresh,
    ],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const startNewConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setError(null);
  }, []);

  function selectDataset(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    // A conversation is bound to its dataset, so switching starts a fresh one.
    startNewConversation();
    setSidebarOpen(false);
  }


  const sidebar = useMemo(
    () => (
      <DatasetPanel
        datasets={datasets}
        selectedId={selectedId}
        detail={detail}
        limits={config.limits}
        isGuest={isGuest}
        openUploadToken={openUploadToken}
        onRequestAccount={() => onSignUp?.()}
        onSelect={selectDataset}
        onUploaded={(dataset) => {
          setDatasets((prev) => [
            { ...dataset },
            ...prev.filter((d) => d.id !== dataset.id),
          ]);
          selectDataset(dataset.id);
        }}
        onDeleted={(id) => {
          setDatasets((prev) => prev.filter((d) => d.id !== id));
          if (id === selectedId) {
            const fallback = datasets.find((d) => d.kind === 'sample');
            setSelectedId(fallback?.id ?? null);
            startNewConversation();
          }
        }}
      />
    ),
    [datasets, selectedId, detail, config.limits, isGuest, openUploadToken],
  );

  return (
    <div className={`relative z-10 flex h-full flex-col ${FOOTER_SPACER_CLASS}`}>
      {/* --------------------------------- header -------------------------------- */}
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[var(--surface-1)]">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="hidden rounded-lg p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-2)] sm:block lg:hidden"
            aria-label={sidebarOpen ? 'Hide datasets' : 'Show datasets'}
            aria-expanded={sidebarOpen}
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          {/*
            Leaves the dashboard without signing out — the session, datasets
            and conversation are all still there when you come back. The
            wordmark is part of the control rather than a second one beside
            it, because "click the logo for home" is what people try anyway.
          */}
          <button
            type="button"
            onClick={() => onBack?.()}
            className="group -ml-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label="Back to the home page"
          >
            <svg
              className="h-4 w-4 transition-transform group-hover:-translate-x-0.5"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M9.5 3.5 5 8l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-sm font-semibold text-[var(--text-primary)]">VoiceQuery</span>
          </button>

          {/*
            No deployment-level "Demo mode" badge here. It keyed off
            config.demoMode — whether the *server* has a platform key — which
            stays true even once the user connects their own key and is
            getting real AI answers. The badges on the right are derived from
            session.aiMode instead, so they always describe what is actually
            answering this user's questions.
          */}

          <div className="ml-auto flex items-center gap-2">
            {isGuest ? (
              <>
                {/*
                  Two shapes of the same fact. The full label plus a sign-up
                  button needs room a phone does not have — there it wrapped
                  to two lines and shoved the controls into the wordmark — so
                  below sm it becomes one word with the explanation, and the
                  sign-up route moves into the menu where the other actions
                  already live.
                */}
                <div className="sm:hidden">
                  <DemoBadge onUploadData={() => setSidebarOpen(true)} />
                </div>
                <div className="hidden items-center gap-2 sm:flex">
                  <Badge
                    tone="warning"
                    title="You are exploring anonymously. Answers are sample responses, not AI output."
                  >
                    Demo · not signed in
                  </Badge>
                  <Button size="sm" onClick={() => onSignUp?.()}>
                    Sign up free
                  </Button>
                </div>
              </>
            ) : session.aiMode === 'byok' ? (
              <Badge tone="accent" title="Your provider key is paying for model usage.">
                Your API key
              </Badge>
            ) : session.aiMode === 'demo' ? (
              <>
                <Badge
                  tone="warning"
                  title="Answers come from a local rule, not an AI model. Connect a provider key for real analysis."
                >
                  Demo answers
                </Badge>
                <Button size="sm" onClick={() => onConnectKey?.()}>
                  Use real AI
                </Button>
              </>
            ) : !session.creditsApply ? (
              <Badge
                tone="good"
                title="Your own key is paying, so application credits are not used."
              >
                Free — no AI calls
              </Badge>
            ) : (
              <button
                type="button"
                onClick={outOfCredits ? onOutOfCredits : onOpenSettings}
                className={cx(
                  'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  outOfCredits
                    ? 'bg-[var(--critical-soft)] text-[var(--critical)]'
                    : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
                aria-label={`${session.credits} credits remaining`}
              >
                {session.credits} credit{session.credits === 1 ? '' : 's'}
              </button>
            )}

            {/* From sm up there is room for these inline. */}
            <div className="hidden items-center gap-2 sm:flex">
              {messages.length > 0 && (
                <Button variant="ghost" size="sm" onClick={startNewConversation}>
                  New chat
                </Button>
              )}
              {!isGuest && (
                <>
                  <Button variant="ghost" size="sm" onClick={onOpenSettings}>
                    Settings
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onSignOut}>
                    Sign out
                  </Button>
                </>
              )}
            </div>

            {/*
              On a phone these collapse into the same menu, which also picks
              up the dataset list — the sidebar toggle was on the far left,
              away from everything else, so there were two unrelated menus on
              a screen with room for one.
            */}
            <div className="sm:hidden">
              <HeaderMenu
                attention
                attentionKey="dashboard"
                label="Menu"
                items={[
                  { label: sidebarOpen ? 'Hide datasets' : 'Datasets', onSelect: () => setSidebarOpen((v) => !v) },
                  ...(messages.length > 0
                    ? [{ label: 'New chat', onSelect: startNewConversation }]
                    : []),
                  ...(isGuest
                    ? [{ label: 'Create a free account', onSelect: () => onSignUp?.(), emphasis: true }]
                    : [
                        { label: 'Settings', onSelect: onOpenSettings },
                        { label: 'Sign out', onSelect: onSignOut },
                      ]),
                  { label: 'Back to home', onSelect: () => onBack?.() },
                ]}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 overflow-hidden px-4 py-5 sm:px-6">
        {/* -------------------------------- sidebar -------------------------------- */}
        <aside
          className={cx(
            'w-72 shrink-0 overflow-y-auto pb-6 lg:block',
            sidebarOpen
              ? 'fixed inset-0 z-30 block w-full bg-[var(--surface-0)] p-4 pt-20'
              : 'hidden',
          )}
        >
          {sidebarOpen && (
            <div className="mb-3 flex justify-end lg:hidden">
              <Button variant="secondary" size="sm" onClick={() => setSidebarOpen(false)}>
                Close
              </Button>
            </div>
          )}
          {loadingDatasets ? <SidebarSkeleton /> : sidebar}
        </aside>

        {/* ------------------------------ conversation ----------------------------- */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div
            className={cx(
              'flex min-h-0 flex-1 flex-col',
              // `inert` is what actually stops input — it takes the whole
              // subtree out of the tab order and swallows pointer events, so
              // the block holds for keyboard and screen-reader users too
              // rather than just looking closed. The blur is the signal.
              demoLocked && 'pointer-events-none blur-[3px] select-none',
            )}
            inert={demoLocked}
          >
          <div className="flex-1 space-y-5 overflow-y-auto pb-4">
            {messages.length === 0 && !pending && (
              <EmptyState
                datasetName={detail?.name ?? null}
                questions={exampleQuestions}
                onPick={(q) => void ask(q)}
                disabled={outOfCredits || !selectedId}
              />
            )}

            {messages.map((message) => (
              <MessageCard key={message.id} message={message} />
            ))}

            {pending && (
              <PendingCard question={pending.question} stage={pending.stage} elapsedMs={elapsed} />
            )}

            {error && <Alert tone="critical">{error}</Alert>}

            <div ref={bottomRef} />
          </div>

          {/* --------------------------------- composer ------------------------------- */}
          <div className="border-t border-[var(--border-subtle)] pt-4">
            {guestExhausted ? (
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="text-sm text-[var(--text-secondary)]">
                  You've used all {config.guest.questionsLimit} demo questions. Your results
                  above stay available.
                </p>
                <Button size="sm" onClick={() => onSignUp?.()}>
                  Create a free account
                </Button>
              </Card>
            ) : outOfCredits ? (
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="text-sm text-[var(--text-secondary)]">
                  You've used your {config.freeCredits} free questions. Connect your own API key
                  to keep going — your results above stay available.
                </p>
                <Button size="sm" onClick={onOutOfCredits}>
                  Use my API key
                </Button>
              </Card>
            ) : (
              <Composer
                onSubmit={(q) => void ask(q)}
                busy={Boolean(pending)}
                disabled={!selectedId}
                onCancel={cancel}
                placeholder={
                  detail ? `Ask about ${detail.name}…` : 'Select a dataset to begin…'
                }
              />
            )}
            <p className="mt-2 text-center text-xs text-[var(--text-muted)]">
              {isGuest
                ? 'Demo answers are generated by a local rule, not an AI model. The SQL, charts and query engine are real. Sign up for real AI analysis.'
                : 'Answers are generated from your data. Check the SQL and results before relying on them for a decision.'}
            </p>
          </div>
          </div>

          {demoLocked && <RealAiGate onConnectKey={() => onConnectKey?.('demo')} />}
        </main>
      </div>
    </div>
  );
}

/**
 * Sits over the blurred conversation when a signed-in account has no real
 * model behind it. Scoped to this column on purpose rather than being a
 * page-wide dialog: the sidebar and Settings stay reachable, so the user can
 * look at their data and connect a key instead of being boxed in with one
 * button.
 */
function RealAiGate({ onConnectKey }: { onConnectKey: () => void }) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center p-4"
      role="region"
      aria-label="Real AI required"
    >
      <Card className="vq-rise max-w-md p-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--accent-soft)]">
          <svg className="h-5 w-5 text-[var(--accent)]" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10 2.5l1.9 4.2 4.6.5-3.4 3.1.9 4.5L10 12.6l-4 2.2.9-4.5L3.5 7.2l4.6-.5L10 2.5z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          Connect an AI provider to ask questions
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          This deployment has no AI provider of its own, so the only answers it can produce are
          canned demo responses. Rather than hand you a made-up number that looks real, questions
          are paused until a key is connected.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          Add an Anthropic, OpenAI or OpenRouter key and every question is answered by that
          model, billed to your own account. Your key is held in server memory for this session
          only — never written to a database, a log or your browser.
        </p>

        <div className="mt-5">
          <Button onClick={onConnectKey}>Use real AI</Button>
        </div>
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          The dataset panel, schema and SQL engine all still work — it is only the model that is
          missing.
        </p>
      </Card>
    </div>
  );
}

function EmptyState({
  datasetName,
  questions,
  onPick,
  disabled,
}: {
  datasetName: string | null;
  questions: string[];
  onPick: (q: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="py-8">
      <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
        {datasetName ? `Ask about ${datasetName}` : 'Choose a dataset to begin'}
      </h1>
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
        Type a question, or use the microphone. You'll get a chart, the rows behind it, and the
        SQL that produced them.
      </p>

      {questions.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Try one of these
          </p>
          <div className="flex flex-wrap gap-2">
            {questions.map((q) => (
              <button
                key={q}
                type="button"
                disabled={disabled}
                onClick={() => onPick(q)}
                className="rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3.5 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="vq-pulse h-16 rounded-lg bg-[var(--surface-2)]" />
      ))}
    </div>
  );
}
