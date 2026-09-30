import { lazy, Suspense, useState } from 'react';
import type { AnalysisResponse, StageName } from '@voicequery/shared';
import { Badge, Button, Card, Disclosure } from './ui.tsx';
import { ResultTable } from './ResultTable.tsx';
import { formatDuration } from '../lib/format.ts';
import { useSpeechSynthesis } from '../hooks/useSpeech.ts';

/**
 * Recharts is by far the largest dependency and is only needed once an answer
 * with a chart exists — loading it lazily keeps the landing page and the
 * empty dashboard light.
 */
const Chart = lazy(() => import('./Chart.tsx').then((m) => ({ default: m.Chart })));

const STAGE_LABELS: Record<StageName, string> = {
  understanding: 'Understanding your question',
  generating_sql: 'Generating SQL',
  running_query: 'Running query',
  preparing_answer: 'Preparing answer',
};

/** Timings shown are measured on the server; nothing here is estimated. */
function Timings({ message }: { message: AnalysisResponse }) {
  if (message.timings.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
      {message.timings.map((t) => (
        <span key={t.stage}>
          {STAGE_LABELS[t.stage]} <span className="tabular-nums">{formatDuration(t.ms)}</span>
        </span>
      ))}
      <span className="font-medium text-[var(--text-secondary)]">
        Total <span className="tabular-nums">{formatDuration(message.totalMs)}</span>
      </span>
    </div>
  );
}

export function MessageCard({ message }: { message: AnalysisResponse }) {
  const [copied, setCopied] = useState(false);
  const speech = useSpeechSynthesis();

  const copySql = async () => {
    if (!message.sql) return;
    try {
      await navigator.clipboard.writeText(message.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="vq-rise space-y-3">
      {/* The question, as asked. */}
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]">
          {message.question}
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {message.outcome === 'clarification' && <Badge tone="warning">Needs clarification</Badge>}
            {message.simulated && (
              <Badge
                tone="warning"
                title="This answer was produced by a local rule-based demo provider, not an AI model."
              >
                Demo mode — simulated
              </Badge>
            )}
            {message.aiMode === 'byok' && <Badge tone="accent">Your API key</Badge>}
            {!message.creditConsumed && message.outcome === 'clarification' && (
              <Badge tone="good">No credit used</Badge>
            )}
            {message.usage && (
              <Badge
                tone="neutral"
                title="Token counts reported by the provider. Monetary cost is not estimated here."
              >
                {(message.usage.inputTokens + message.usage.outputTokens).toLocaleString()} tokens
              </Badge>
            )}
          </div>

          <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-[var(--text-primary)]">
            {message.answer}
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Timings message={message} />
            {speech.supported && message.answer && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (speech.speaking ? speech.cancel() : speech.speak(message.answer))}
                aria-label={speech.speaking ? 'Stop reading the answer' : 'Read the answer aloud'}
              >
                {speech.speaking ? '■ Stop' : '▶ Read aloud'}
              </Button>
            )}
          </div>
        </div>

        {message.chart && message.result && (
          <div className="border-t border-[var(--border-subtle)] p-4">
            <Suspense
              fallback={<div className="vq-pulse h-72 rounded-lg bg-[var(--surface-2)]" />}
            >
              <Chart spec={message.chart} result={message.result} />
            </Suspense>
          </div>
        )}

        {message.result && (
          <div className="border-t border-[var(--border-subtle)]">
            <ResultTable result={message.result} />
          </div>
        )}

        {message.sql && (
          <div className="border-t border-[var(--border-subtle)] p-3">
            <Disclosure
              label="View generated SQL"
              right={
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.preventDefault();
                    void copySql();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void copySql();
                    }
                  }}
                  className="rounded px-2 py-0.5 text-xs text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  {copied ? 'Copied' : 'Copy'}
                </span>
              }
            >
              <pre className="overflow-x-auto rounded-md bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--text-primary)]">
                <code className="font-mono">{message.sql}</code>
              </pre>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                This query was parsed and checked against a read-only allowlist before running
                in an isolated engine with no file or network access.
              </p>
            </Disclosure>
          </div>
        )}
      </Card>
    </article>
  );
}

/** Live progress while an analysis is running. Stages advance as they finish. */
export function PendingCard({
  question,
  stage,
  elapsedMs,
}: {
  question: string;
  stage: StageName;
  elapsedMs: number;
}) {
  const order: StageName[] = [
    'understanding',
    'generating_sql',
    'running_query',
    'preparing_answer',
  ];
  const currentIndex = order.indexOf(stage);

  return (
    <article className="vq-rise space-y-3">
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--accent)] px-4 py-2 text-sm text-[var(--on-accent)]">
          {question}
        </p>
      </div>

      <Card className="p-4">
        <ol className="space-y-2" aria-live="polite" aria-label="Analysis progress">
          {order.map((s, i) => {
            const done = i < currentIndex;
            const active = i === currentIndex;
            return (
              <li key={s} className="flex items-center gap-2.5 text-sm">
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                    done
                      ? 'border-[var(--good)] bg-[var(--good)] text-white'
                      : active
                        ? 'vq-pulse border-[var(--accent)] bg-[var(--accent)] text-white'
                        : 'border-[var(--border-strong)]'
                  }`}
                >
                  {done ? '✓' : ''}
                </span>
                <span
                  className={
                    done || active
                      ? 'text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)]'
                  }
                >
                  {STAGE_LABELS[s]}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs tabular-nums text-[var(--text-muted)]">
          {formatDuration(elapsedMs)} elapsed
        </p>
      </Card>
    </article>
  );
}
