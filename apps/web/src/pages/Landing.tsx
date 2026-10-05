import type { AppConfigResponse } from '@voicequery/shared';
import { Badge, Button, Card } from '../components/ui.tsx';
import { FOOTER_SPACER_CLASS } from '../components/AppFooter.tsx';

const STEPS = [
  {
    title: 'Ask in plain language',
    body: 'Type your question or speak it. Your transcript is editable before anything runs.',
  },
  {
    title: 'See the work, not just the answer',
    body: 'Every answer shows the generated SQL, the rows it returned, and how long each stage took.',
  },
  {
    title: 'Keep the thread going',
    body: '“Now show only September” continues on the same dataset, using the earlier turns as context.',
  },
];

const SAFETY = [
  {
    title: 'Generated SQL is parsed, not trusted',
    body: 'Queries are validated against a read-only allowlist. A SELECT that hides a file-reading function is rejected before it reaches the engine.',
  },
  {
    title: 'Isolated query engine',
    body: 'Each dataset is its own read-only DuckDB file with filesystem and network access disabled at the engine level.',
  },
  {
    title: 'Your data stays yours',
    body: 'Only the schema and the rows your query returns are sent to the AI provider — never the whole file. Uploads expire automatically.',
  },
];

export function Landing({
  config,
  onTryDemo,
  onSignIn,
  onGetStarted,
  signedIn,
  realAiActive = false,
}: {
  config: AppConfigResponse;
  onTryDemo: () => void;
  onSignIn: () => void;
  /**
   * The primary call to action: an account, which is what real answers
   * require. Opens the same dialog as "Sign in" but on the create side,
   * since a visitor reading the landing page usually has no account yet.
   */
  onGetStarted: () => void;
  signedIn: boolean;
  /**
   * True when this visitor's questions reach a real model — because they
   * connected their own key, or the deployment has a platform one. The
   * deployment-level `demoMode` flag alone would keep claiming "demo" at
   * someone already getting real answers.
   */
  realAiActive?: boolean;
}) {
  return (
    <div className={`min-h-full bg-[var(--surface-0)] ${FOOTER_SPACER_CLASS}`}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-[var(--accent)] focus:px-4 focus:py-2 focus:text-[var(--on-accent)]"
      >
        Skip to content
      </a>

      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-base font-semibold text-[var(--text-primary)]">VoiceQuery</span>
        </div>
        <nav className="flex items-center gap-2">
          {signedIn ? (
            <Button size="sm" onClick={onTryDemo}>
              Open dashboard
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onSignIn}>
                Sign in
              </Button>
              {/*
                Guarded on guest.enabled, which it was not before: with guest
                mode off this button opened the sign-up dialog, so it offered
                a demo that did not exist.
              */}
              {config.guest.enabled && (
                <Button variant="secondary" size="sm" onClick={onTryDemo}>
                  Try the demo
                </Button>
              )}
              <Button size="sm" onClick={onGetStarted}>
                Get real answers
              </Button>
            </>
          )}
        </nav>
      </header>

      <main id="main">
        {/* --------------------------------- hero -------------------------------- */}
        <section className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
          <div className="max-w-3xl">
            {config.demoMode && !realAiActive && (
              <div className="mb-4">
                <Badge tone="warning">
                  Demo mode — answers come from a local stand-in, not an AI model
                </Badge>
              </div>
            )}

            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-[var(--text-primary)] sm:text-6xl">
              Talk to your data.
              <br />
              <span className="text-[var(--accent)]">Get answers you can check.</span>
            </h1>

            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--text-secondary)]">
              Ask a question by voice or text. VoiceQuery writes the SQL, runs it against your
              dataset in an isolated engine, and gives you a chart, the results, and a plain-language
              answer — with the query it used shown in full.
            </p>

            {/*
              Real answers lead; the demo is the fallback. The demo exists to
              show how the product works, so offering it as the first thing a
              visitor clicks sells the simulation rather than the product.
            */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {signedIn ? (
                <Button size="lg" onClick={onTryDemo}>
                  Open VoiceQuery
                </Button>
              ) : (
                <>
                  <Button size="lg" onClick={onGetStarted}>
                    Get real answers
                  </Button>
                  {config.guest.enabled && (
                    <Button size="lg" variant="secondary" onClick={onTryDemo}>
                      Try the demo
                    </Button>
                  )}
                </>
              )}
              <span className="text-sm text-[var(--text-secondary)]">
                {signedIn
                  ? 'Sample dataset already loaded'
                  : config.creditsEnabled
                    ? // Only promise free questions where an account actually
                      // gets them — on a deployment with no provider key of
                      // its own, signing up leads to the bring-your-own-key
                      // form instead, and saying otherwise would be a lie.
                      `${config.freeCredits} free questions with an account${
                        config.guest.enabled ? ' · the demo answers are simulated' : ''
                      }`
                    : config.guest.enabled
                      ? 'An account lets you use your own API key · the demo answers are simulated'
                      : 'Bring your own API key for real analysis'}
              </span>
            </div>
          </div>

          {/* A concrete example beats an abstract description. */}
          <Card className="mt-12 overflow-hidden">
            <div className="border-b border-[var(--border-subtle)] bg-[var(--surface-2)] px-4 py-2">
              <p className="text-xs font-medium text-[var(--text-muted)]">Example exchange</p>
            </div>
            <div className="space-y-3 p-4 sm:p-6">
              <div className="flex justify-end">
                <p className="rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]">
                  Which products generated the most revenue?
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4">
                <p className="text-sm text-[var(--text-primary)]">
                  Lumen Monitor 32 leads on revenue, followed by Pulse Smartwatch and Lumen
                  Monitor 27. The top three account for a little under half of total revenue
                  across the period.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--surface-2)] p-3 font-mono text-xs text-[var(--text-secondary)]">
                  <code>{`SELECT product, SUM(revenue) AS total_revenue
FROM t GROUP BY product
ORDER BY total_revenue DESC LIMIT 10`}</code>
                </pre>
              </div>
              <div className="flex justify-end">
                <p className="rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]">
                  Now show only September
                </p>
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                The follow-up keeps the same dataset and re-runs with a September filter.
              </p>
            </div>
          </Card>
        </section>

        {/* ------------------------------- how it works -------------------------- */}
        <section className="border-t border-[var(--border-subtle)] bg-[var(--surface-1)]">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 className="text-2xl font-semibold text-[var(--text-primary)]">How it works</h2>
            <div className="mt-8 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <div key={step.title}>
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">
                    {i + 1}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------- safety ------------------------------ */}
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
            Built to be safe with real data
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
            Letting a model write SQL against a database is the interesting part of this problem
            — and the dangerous one. Here is what actually stops it going wrong.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {SAFETY.map((item) => (
              <Card key={item.title} className="p-4">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary)]">
                  {item.body}
                </p>
              </Card>
            ))}
          </div>
        </section>

        {/* ---------------------------------- cta -------------------------------- */}
        <section className="border-t border-[var(--border-subtle)] bg-[var(--surface-1)]">
          <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:px-6">
            <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
              Try it on the sample dataset
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--text-secondary)]">
              Six months of retail sales across four regions. No upload needed — ask a question
              and see the whole pipeline run.
              {config.guest.enabled && (
                <>
                  {' '}
                  The demo runs without an account; sign up free when you want real AI answers
                  or to upload your own data.
                </>
              )}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {signedIn ? (
                <Button size="lg" onClick={onTryDemo}>
                  Open VoiceQuery
                </Button>
              ) : (
                <>
                  <Button size="lg" onClick={onGetStarted}>
                    Get real answers
                  </Button>
                  {config.guest.enabled && (
                    <Button size="lg" variant="secondary" onClick={onTryDemo}>
                      Try the demo
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-[var(--text-muted)] sm:px-6">
          <p>
            VoiceQuery is a portfolio demonstration project. Please do not upload confidential
            data. Uploaded files are deleted automatically after{' '}
            {config.limits.datasetTtlHours} hours.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect width="26" height="26" rx="7" fill="var(--accent)" />
      <rect x="6.5" y="12" width="2.4" height="6" rx="1.2" fill="white" opacity="0.75" />
      <rect x="11.3" y="8" width="2.4" height="10" rx="1.2" fill="white" />
      <rect x="16.1" y="10.5" width="2.4" height="7.5" rx="1.2" fill="white" opacity="0.75" />
    </svg>
  );
}
