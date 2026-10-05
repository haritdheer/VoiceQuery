import { useEffect, useState } from 'react';
import type { SessionState } from '@voicequery/shared';
import { Alert, Button, Field, Modal, inputClass } from './ui.tsx';
import { api, ApiRequestError } from '../lib/api.ts';

export function AuthDialog({
  open,
  onClose,
  onAuthenticated,
  freeCredits,
  creditsEnabled,
  initialMode = 'register',
}: {
  open: boolean;
  onClose: () => void;
  /** `mode` lets the caller tell a new account from a returning one. */
  onAuthenticated: (state: SessionState, mode: 'register' | 'login') => void;
  freeCredits: number;
  /** False on a free demo deployment — do not promise a credit allowance. */
  creditsEnabled: boolean;
  initialMode?: 'register' | 'login';
}) {
  const [mode, setMode] = useState<'register' | 'login'>(initialMode);

  /*
   * useState reads initialMode once, and this dialog is always mounted —
   * `open` only controls whether it paints. So the prop was captured at
   * first render and never looked at again: "Sign in" in the header set the
   * mode to login, the dialog stayed on the register side it had mounted
   * with, and every returning user was shown "Create your account". The only
   * way to the sign-in form was the switch link inside it.
   */
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError(null);
    }
  }, [open, initialMode]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const state =
        mode === 'register' ? await api.register(email, password) : await api.login(email, password);
      onAuthenticated(state, mode);
      setEmail('');
      setPassword('');
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'register' ? 'Create your account' : 'Welcome back'}
      description={
        mode === 'login'
          ? 'Sign in to continue with your datasets and conversations.'
          : creditsEnabled
            ? `New accounts get ${freeCredits} free questions. No card required.`
            : 'An account keeps your datasets and conversations. No card required.'
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="critical">{error}</Alert>}

        {/*
          type="text", not type="email": the browser would otherwise block
          anything without an @ before the request is even sent, which is the
          whole thing being removed here. Nothing is mailed to this address.
        */}
        <Field
          label="Username"
          htmlFor="vq-email"
          hint={mode === 'register' ? 'Anything you like — no email needed.' : undefined}
        >
          <input
            id="vq-email"
            type="text"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="demo"
          />
        </Field>

        <Field label="Password" htmlFor="vq-password">
          <input
            id="vq-password"
            type="password"
            required
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            placeholder="••••••••"
          />
        </Field>

        <Button type="submit" className="w-full" loading={busy}>
          {mode === 'login'
            ? 'Sign in'
            : creditsEnabled
              ? `Create account & get ${freeCredits} free questions`
              : 'Create account'}
        </Button>

        <p className="text-center text-sm text-[var(--text-secondary)]">
          {mode === 'register' ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'register' ? 'login' : 'register');
              setError(null);
            }}
            className="font-medium text-[var(--accent)] hover:underline"
          >
            {mode === 'register' ? 'Sign in' : 'Create an account'}
          </button>
        </p>

        <p className="text-center text-xs text-[var(--text-muted)]">
          This is a portfolio demo. Please do not upload confidential data or reuse a password
          from another service.
        </p>
      </form>
    </Modal>
  );
}
