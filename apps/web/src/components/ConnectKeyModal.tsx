import { useState } from 'react';
import type { ProviderInfo } from '@voicequery/shared';
import { Alert, Button, Field, Modal, inputClass } from './ui.tsx';
import { api, ApiRequestError } from '../lib/api.ts';

/** Why the dialog opened. Only the heading and the first line differ. */
export type ConnectKeyReason =
  /** The free allowance funded by the operator's key is spent. */
  | 'exhausted'
  /** The user chose to connect a key while everything still works. */
  | 'upgrade'
  /** The operator's key is rejected, expired, or out of quota. */
  | 'platform_unavailable'
  /** This deployment has no provider key at all. */
  | 'demo';

function copyFor(reason: ConnectKeyReason, freeCredits: number) {
  switch (reason) {
    case 'exhausted':
      return {
        title: `You've used your ${freeCredits} free question${freeCredits === 1 ? '' : 's'}`,
        description:
          'Those were answered on our key. To keep going, connect your own — your provider bills you directly, and there is no limit from us. Your results above stay available.',
      };
    case 'platform_unavailable':
      return {
        title: 'Our shared key is unavailable',
        description:
          'It has been rejected or has run out of quota, so that question could not be answered — and you were not charged for it. Connecting your own key gets you going again immediately.',
      };
    case 'demo':
      return {
        title: 'Connect a key for real answers',
        description:
          'This deployment has no AI provider of its own, so it can only produce canned demo responses. Connect a key and every question is answered by that model.',
      };
    case 'upgrade':
    default:
      return {
        title: 'Use your own AI provider key',
        description:
          'Your provider account is billed directly for model usage, and no free questions are consumed.',
      };
  }
}

/**
 * The single way to keep using the app once the free questions are gone.
 *
 * There is deliberately nothing to buy here. Credits are a fixed grant funded
 * by the operator's key — when they run out the honest options are "bring your
 * own key" or "stop", and offering a purchase that does not exist would be
 * worse than offering nothing.
 */
export function ConnectKeyModal({
  open,
  onClose,
  onConnected,
  providers,
  freeCredits,
  reason = 'upgrade',
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
  providers: ProviderInfo[];
  freeCredits: number;
  reason?: ConnectKeyReason;
}) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 'anthropic');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const { title, description } = copyFor(reason, freeCredits);

  function close() {
    // Never leave a key sitting in component state after the dialog closes.
    setApiKey('');
    setModel('');
    setError(null);
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
      onConnected();
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

  if (!provider) return null;

  return (
    <Modal open={open} onClose={close} title={title} description={description}>
      {error && (
        <div className="mb-3">
          <Alert tone="critical">{error}</Alert>
        </div>
      )}

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
            <strong className="text-[var(--text-primary)]">Your provider account pays</strong> for
            model usage while your key is connected. Free questions are not deducted.
          </p>
          <p>{provider.subscriptionNote}</p>
          <p>{provider.validationNote}</p>
          <p>
            The key is held in server memory for this session only — never written to our
            database, never stored in your browser, and never written to logs. You can disconnect
            it at any time from Settings.
          </p>
          <p>
            An LLM key does not cover speech services. Voice input and spoken replies here use
            your browser's own capabilities.
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="ghost" type="button" onClick={close}>
            {reason === 'upgrade' ? 'Cancel' : 'Not now'}
          </Button>
          <Button type="submit" className="flex-1" loading={busy}>
            Validate &amp; connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}
