import { useEffect, useState } from 'react';
import type { AppConfigResponse, LedgerEntry, PurchaseRecord, SessionState } from '@voicequery/shared';
import { Alert, Badge, Button, Card, Modal } from './ui.tsx';
import { api } from '../lib/api.ts';
import { formatMoney, formatRelativeTime } from '../lib/format.ts';

const LEDGER_LABELS: Record<LedgerEntry['reason'], string> = {
  free_grant: 'Welcome grant',
  analysis_reserve: 'Analysis',
  analysis_refund: 'Refund',
  purchase: 'Credit purchase',
  admin_adjust: 'Adjustment',
};

export function SettingsPanel({
  open,
  onClose,
  session,
  config,
  onChanged,
  onBuyCredits,
  onConnectKey,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionState;
  config: AppConfigResponse;
  onChanged: () => void;
  onBuyCredits: () => void;
  onConnectKey: () => void;
}) {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
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
      if (config.billing.enabled) {
        setPurchases(await api.purchases().catch(() => []));
      }
    })();
  }, [open, config.billing.enabled]);

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

        {/* ------------------------------ billing ----------------------------- */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            Billing
            {config.billing.enabled && config.billing.testMode && (
              <Badge tone="warning">Test mode</Badge>
            )}
          </h3>
          <Card className="space-y-2 p-3">
            {config.billing.enabled ? (
              <>
                <Button size="sm" variant="secondary" onClick={onBuyCredits}>
                  Buy credits
                </Button>
                {purchases.length > 0 ? (
                  <ul className="space-y-1">
                    {purchases.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 text-xs text-[var(--text-secondary)]"
                      >
                        <span>
                          {p.credits} credits · {formatMoney(p.amountMinor, p.currency)}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge tone={p.status === 'paid' ? 'good' : p.status === 'pending' ? 'neutral' : 'critical'}>
                            {p.status}
                          </Badge>
                          <span className="text-[var(--text-muted)]">
                            {formatRelativeTime(p.createdAt)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">No purchases yet.</p>
                )}
                <p className="text-xs text-[var(--text-muted)]">
                  Credits are granted only after the payment provider confirms the payment via a
                  signed webhook. For a refund, contact support — refunded credits are removed
                  from the balance.
                </p>
              </>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">
                Credit purchases are not configured on this deployment.
              </p>
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
