import { useEffect, useState } from 'react';
import type { AppConfigResponse, LedgerEntry, SessionState } from '@voicequery/shared';
import { Alert, Badge, Button, Card, Modal } from './ui.tsx';
import { api } from '../lib/api.ts';
import { formatRelativeTime } from '../lib/format.ts';

const LEDGER_LABELS: Record<LedgerEntry['reason'], string> = {
  free_grant: 'Welcome grant',
  analysis_reserve: 'Analysis',
  analysis_refund: 'Refund',
  admin_adjust: 'Adjustment',
};

export function SettingsPanel({
  open,
  onClose,
  session,
  config,
  onChanged,
  onConnectKey,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionState;
  config: AppConfigResponse;
  onChanged: () => void;
  onConnectKey: () => void;
}) {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [byok, setByok] = useState<{
    connected: boolean;
    providerId: string | null;
    model: string | null;
    fingerprint: string | null;
  }>({ connected: false, providerId: null, model: null, fingerprint: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [credits, status] = await Promise.all([
        api.credits().catch(() => ({ balance: 0, ledger: [] })),
        api.byokStatus().catch(() => null),
      ]);
      setLedger(credits.ledger);
      if (status) {
        setByok({
          connected: status.connected,
          providerId: status.providerId,
          model: status.model,
          fingerprint: status.fingerprint,
        });
      }
    })();
  }, [open]);

  async function disconnect() {
    setBusy(true);
    try {
      await api.disconnectByok();
      setByok({ connected: false, providerId: null, model: null, fingerprint: null });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Account & settings">
      <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
        {/* ------------------------------ account ----------------------------- */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Account
          </h3>
          <Card className="p-3">
            <p className="text-sm text-[var(--text-primary)]">{session.user?.email}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {session.credits} credit{session.credits === 1 ? '' : 's'} remaining
              {!session.creditsApply && (
                <>
                  {' — '}
                  {session.aiMode === 'byok'
                    ? 'not being used while your own API key is connected'
                    : 'not being used: demo mode makes no AI provider calls'}
                </>
              )}
            </p>
          </Card>
        </section>

        {/* -------------------------------- byok ------------------------------ */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            AI provider key
          </h3>
          <Card className="space-y-2 p-3">
            {byok.connected ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-[var(--text-primary)]">
                    Connected · {byok.providerId}
                  </span>
                  <Badge tone="good">Your key pays</Badge>
                </div>
                <p className="font-mono text-xs text-[var(--text-muted)]">
                  {byok.model ? `${byok.model} · ` : ''}fingerprint {byok.fingerprint}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Held in server memory for this session only. Application credits are not
                  deducted while this is connected.
                </p>
                <Button variant="danger" size="sm" loading={busy} onClick={() => void disconnect()}>
                  Disconnect & delete key
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--text-secondary)]">
                  No key connected.{' '}
                  {config.demoMode
                    ? 'Answers come from the offline demo provider.'
                    : 'Analyses use application credits.'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Connect your own key to get real AI analysis billed to your provider account
                  instead.
                </p>
                <Button size="sm" onClick={onConnectKey}>
                  Connect an API key
                </Button>
              </>
            )}
          </Card>
        </section>

        {/* ------------------------------- ledger ----------------------------- */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Credit history
          </h3>
          <Card className="p-3">
            {ledger.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">Nothing yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {ledger.map((entry) => (
                  <li key={entry.id} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-[var(--text-secondary)]">
                      {LEDGER_LABELS[entry.reason]}
                      {entry.note && (
                        <span className="text-[var(--text-muted)]"> — {entry.note}</span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 tabular-nums">
                      <span
                        className={
                          entry.delta > 0 ? 'text-[var(--good)]' : 'text-[var(--text-secondary)]'
                        }
                      >
                        {entry.delta > 0 ? '+' : ''}
                        {entry.delta}
                      </span>
                      <span className="text-[var(--text-muted)]">→ {entry.balanceAfter}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {config.demoMode && (
          <Alert tone="warning" title="Demo mode">
            This deployment has no AI provider credentials configured. Answers are generated by
            a local rule-based stand-in and are labelled “simulated”. They are not AI output.
          </Alert>
        )}

        {/* ------------------------------- privacy ---------------------------- */}
        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Data handling
          </h3>
          <Card className="space-y-1.5 p-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            <p>
              Uploaded datasets are stored in isolated per-dataset files and deleted
              automatically after {config.limits.datasetTtlHours} hours, or immediately when you
              delete them.
            </p>
            <p>
              Only your schema (column names, types, a few example values) and the rows a query
              returns are sent to the AI provider. Your full dataset is never sent.
            </p>
            <p>Dataset contents are never written to application logs.</p>
          </Card>
        </section>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
