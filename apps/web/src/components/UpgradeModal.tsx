import { useEffect, useState } from 'react';
import type { BillingConfig, ProviderInfo } from '@voicequery/shared';
import { Alert, Badge, Button, Field, Modal, inputClass } from './ui.tsx';
import { api, ApiRequestError } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';

type View = 'choose' | 'byok' | 'buy';

/**
 * Shown when the free allowance is exhausted.
 *
 * The three actions the brief calls for are all here, and "Maybe later" simply
 * closes: existing results stay on screen and remain readable at zero credits.
 */
export function UpgradeModal({
  open,
  onClose,
  onByokConnected,
  billing,
  providers,
  freeCredits,
  initialView = 'choose',
  reason = 'exhausted',
}: {
  open: boolean;
  onClose: () => void;
  onByokConnected: () => void;
  billing: BillingConfig;
  providers: ProviderInfo[];
  freeCredits: number;
  /** Open straight to a step — used by the "Connect API key" entry points. */
  initialView?: View;
  /**
   * Why the dialog opened. "exhausted" is the out-of-credits path; "upgrade"
   * is a user who chose to connect a key while everything still works, and
   * must not be told they have run out of anything.
   */
  reason?: 'exhausted' | 'upgrade';
}) {
  const [view, setView] = useState<View>(initialView);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'anthropic');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Honour the requested step each time the dialog is opened.
  useEffect(() => {
    if (open) setView(initialView);
  }, [open, initialView]);

  const provider = providers.find((p) => p.id === providerId) ?? providers[0];

  function close() {
    // Never leave a key sitting in component state after the dialog closes.
    setApiKey('');
    setModel('');
    setError(null);
    setView(initialView);
    onClose();
  }

  async function connectKey(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.connectByok(providerId, apiKey, provider?.requiresModel ? model.trim() : undefined);
      setApiKey('');
      setModel('');
      onByokConnected();
      close();
    } catch (err) {
      // The provider's own failure reason is shown; we do not silently fall
      // back to the application's key.
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'That key could not be validated. Check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function buy(packageId: string) {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api.createCheckout(packageId);
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Checkout could not be started.',
      );
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        reason === 'exhausted'
          ? `You've used your ${freeCredits} free questions`
          : 'Use your own AI provider key'
      }
      description={
        reason === 'exhausted'
          ? 'Continue with your own supported AI API key, or purchase more credits. Your existing results stay available either way.'
          : 'Connect a key to get real AI analysis instead of demo answers. Your provider account is billed directly, and no application credits are used.'
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="critical">{error}</Alert>
        </div>
      )}

      {view === 'choose' && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setView('byok')}
            className="w-full rounded-lg border border-[var(--border-strong)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
          >
            <span className="block text-sm font-semibold text-[var(--text-primary)]">
              Use my API key
            </span>
            <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
              Connect your own provider key. Your provider account pays for model usage.
            </span>
          </button>

          <button
            type="button"
            onClick={() => setView('buy')}
            disabled={!billing.enabled}
            className="w-full rounded-lg border border-[var(--border-strong)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[var(--border-strong)] disabled:hover:bg-transparent"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              Buy credits
              {billing.enabled && billing.testMode && <Badge tone="warning">Test mode</Badge>}
            </span>
            <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">
              {billing.enabled
                ? 'One-time credit packages via hosted checkout.'
                : 'Not configured on this deployment yet.'}
            </span>
          </button>

          <Button variant="ghost" className="w-full" onClick={close}>
            {reason === 'exhausted' ? 'Maybe later' : 'Cancel'}
          </Button>
        </div>
      )}

      {view === 'byok' && provider && (
        <form onSubmit={connectKey} className="space-y-4">
          {providers.length > 1 && (
            <Field label="Provider" htmlFor="vq-provider">
              <select
                id="vq-provider"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  // Model ids are provider-specific; carrying one across
                  // would guarantee a confusing validation failure.
                  setModel('');
                  setError(null);
                }}
                className={inputClass}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label={`${provider.label} API key`}
            htmlFor="vq-api-key"
            hint={
              <>
                Get one at{' '}
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  {new URL(provider.keyUrl).host}
                </a>
                .
              </>
            }
          >
            <input
              id="vq-api-key"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={`${inputClass} font-mono`}
              placeholder={provider.keyPlaceholder}
            />
          </Field>

          {provider.requiresModel && (
            <Field
              label="Model"
              htmlFor="vq-model"
              hint={
                <>
                  Browse ids at{' '}
                  <a
                    href={provider.modelsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    {new URL(provider.modelsUrl).host}
                  </a>
                  . The model is checked along with the key.
                </>
              }
            >
              <input
                id="vq-model"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`${inputClass} font-mono`}
                placeholder={provider.modelPlaceholder ?? ''}
              />
            </Field>
          )}

          <div className="space-y-2 rounded-lg bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            <p>
              <strong className="text-[var(--text-primary)]">Your provider account pays</strong>{' '}
              for model usage while your key is connected. VoiceQuery credits are not deducted.
            </p>
            <p>{provider.subscriptionNote}</p>
            <p>{provider.validationNote}</p>
            <p>
              The key is held in server memory for this session only — never written to our
              database, never stored in your browser, and never written to logs. You can
              disconnect it at any time from Settings.
            </p>
            <p>
              An LLM key does not cover speech services. Voice input and spoken replies here use
              your browser's own capabilities.
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={() => setView('choose')}>
              Back
            </Button>
            <Button type="submit" className="flex-1" loading={busy}>
              Validate & connect
            </Button>
          </div>
        </form>
      )}

      {view === 'buy' && (
        <div className="space-y-3">
          {billing.testMode && (
            <Alert tone="warning" title="Test mode">
              Payments are in the provider's test mode. Use a test card — no real money moves.
            </Alert>
          )}

          <div className="space-y-2">
            {billing.packages.map((pkg) => (
              <button
                key={pkg.id}
                type="button"
                disabled={busy}
                onClick={() => void buy(pkg.id)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border-strong)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-55"
              >
                <span>
                  <span className="block text-sm font-semibold text-[var(--text-primary)]">
                    {pkg.name}
                  </span>
                  <span className="block text-xs text-[var(--text-secondary)]">
                    {pkg.credits} questions
                  </span>
                </span>
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  {formatMoney(pkg.amountMinor, pkg.currency)}
                </span>
              </button>
            ))}
            {billing.packages.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">
                No credit packages are configured on this deployment.
              </p>
            )}
          </div>

          <Button variant="secondary" onClick={() => setView('choose')}>
            Back
          </Button>
        </div>
      )}
    </Modal>
  );
}
