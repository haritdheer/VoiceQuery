import { useCallback, useEffect, useState } from 'react';
import type { AppConfigResponse, SessionState } from '@voicequery/shared';
import { api, ApiRequestError } from './lib/api.ts';
import { Landing } from './pages/Landing.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { AuthDialog } from './components/AuthDialog.tsx';
import { ConnectKeyModal, type ConnectKeyReason } from './components/ConnectKeyModal.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { GuestNudgeModal } from './components/GuestNudgeModal.tsx';
import { DemoIntroModal } from './components/DemoIntroModal.tsx';
import { AppFooter } from './components/AppFooter.tsx';
import { QueryField } from './components/QueryField.tsx';
import { Alert, Spinner } from './components/ui.tsx';

type Route = 'landing' | 'app';

export default function App() {
  const [config, setConfig] = useState<AppConfigResponse | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [route, setRoute] = useState<Route>(
    typeof window !== 'undefined' && window.location.pathname.startsWith('/app')
      ? 'app'
      : 'landing',
  );
  const [bootError, setBootError] = useState<string | null>(null);

  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'register' | 'login'>('register');
  const [connectKey, setConnectKey] = useState<{ open: boolean; reason: ConnectKeyReason }>({
    open: false,
    reason: 'upgrade',
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoIntroOpen, setDemoIntroOpen] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<{ open: boolean; blocking: boolean }>({
    open: false,
    blocking: false,
  });

  /* --------------------------------- boot --------------------------------- */

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, state] = await Promise.all([api.config(), api.session()]);
        setConfig(cfg);
        setSession(state);
      } catch {
        setBootError('Could not reach the VoiceQuery API. Is the server running?');
      }
    })();
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch {
      /* leave the previous state in place */
    }
  }, []);

  function navigate(next: Route) {
    setRoute(next);
    window.history.pushState({}, '', next === 'app' ? '/app' : '/');
  }

  useEffect(() => {
    const onPop = () =>
      setRoute(window.location.pathname.startsWith('/app') ? 'app' : 'landing');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /* -------------------------------- actions -------------------------------- */

  /**
   * "Try the demo" needs no account: it opens an anonymous guest session.
   * A guest is sample-dataset-only and always served by the demo provider,
   * so this cannot spend the operator's AI budget.
   */
  async function tryDemo() {
    if (session?.user) {
      navigate('app');
      /*
       * A guest coming back in gets the explainer too. It used to be raised
       * only where the session is created below, so it appeared exactly once
       * per browser, ever — and never again for anyone who already had a
       * guest session, which after a single visit is everyone. "Try the
       * demo" should always say what the demo is.
       *
       * Not for a real account: they are not in demo mode, and their button
       * says "Open VoiceQuery" anyway.
       */
      if (session.user.isGuest) setDemoIntroOpen(true);
      return;
    }
    // Guest mode switched off at the deployment: an account genuinely is the
    // only way in, so sending them to the sign-up form is the right answer.
    if (!config?.guest.enabled) {
      setAuthMode('register');
      setAuthOpen(true);
      return;
    }
    setDemoError(null);
    try {
      setSession(await api.startGuest());
      navigate('app');
      // Set expectations before the first answer, not after it.
      setDemoIntroOpen(true);
    } catch (err) {
      /*
       * Only a 403 means the server is refusing anonymous access. Anything
       * else — the API being down, a 500 — is our failure, and the old code
       * answered all of them with the sign-up dialog. That silently blames
       * the visitor for an outage and pushes them into creating an account
       * they were told they would not need.
       */
      if (err instanceof ApiRequestError && err.status === 403) {
        setAuthMode('register');
        setAuthOpen(true);
      } else {
        setDemoError(
          err instanceof ApiRequestError
            ? `The demo could not be started: ${err.message}`
            : 'Could not reach the VoiceQuery API, so the demo could not be started. If you are running this locally, check the server is up.',
        );
      }
    }
  }

  /** Converts a guest into a real account. */
  function promptSignUp() {
    setNudge({ open: false, blocking: false });
    setAuthMode('register');
    setAuthOpen(true);
  }

  async function signOut() {
    try {
      setSession(await api.logout());
    } catch {
      /* ignore */
    }
    navigate('landing');
  }

  /* -------------------------------- render --------------------------------- */

  if (bootError) {
    return (
      <>
        <AppFooter />
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md">
          <Alert tone="critical" title="Cannot connect">
            {bootError}
            <p className="mt-2 text-xs opacity-90">
              Start it with <code className="font-mono">npm run dev:api</code> from the repo
              root.
            </p>
          </Alert>
        </div>
      </div>
      </>
    );
  }

  if (!config || !session) {
    return (
      <>
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          <Spinner className="h-6 w-6" />
          <span className="sr-only">Loading</span>
        </div>
        <AppFooter />
      </>
    );
  }

  // Any session at all — a guest included — may use the dashboard.
  const signedIn = Boolean(session.user);
  // A real account. Guests have neither credentials nor credits, so the
  // landing page must keep offering them both ways in.
  const hasAccount = Boolean(session.user && !session.user.isGuest);

  return (
    <>
      {demoError && (
        <div className="fixed inset-x-0 top-0 z-50 p-3">
          <div className="mx-auto max-w-2xl">
            <Alert tone="critical">
              <div className="flex items-start justify-between gap-3">
                <p>{demoError}</p>
                <button
                  type="button"
                  onClick={() => setDemoError(null)}
                  className="shrink-0 text-xs underline"
                >
                  Dismiss
                </button>
              </div>
            </Alert>
          </div>
        </div>
      )}

      {/*
        Fixed behind everything. Fainter on the dashboard, where a busy
        backdrop would work against the one thing the app is selling —
        numbers you can check.
      */}
      <QueryField intensity={route === 'app' && signedIn ? 'app' : 'landing'} />

      {route === 'app' && signedIn ? (
        <Dashboard
          session={session}
          config={config}
          onOpenSettings={() => setSettingsOpen(true)}
          onOutOfCredits={() => setConnectKey({ open: true, reason: 'exhausted' })}
          onConnectKey={(reason) => setConnectKey({ open: true, reason: reason ?? 'upgrade' })}
          onSessionRefresh={() => void refreshSession()}
          onSignOut={() => void signOut()}
          onGuestNudge={(blocking) => setNudge({ open: true, blocking })}
          onSignUp={promptSignUp}
          onBack={() => navigate('landing')}
        />
      ) : (
        <Landing
          config={config}
          hasAccount={hasAccount}
          realAiActive={session.aiMode !== 'demo'}
          onTryDemo={() => void tryDemo()}
          onGetStarted={promptSignUp}
          onSignIn={() => {
            setAuthMode('login');
            setAuthOpen(true);
          }}
        />
      )}

      <AuthDialog
        open={authOpen}
        initialMode={authMode}
        freeCredits={config.freeCredits}
        creditsEnabled={config.creditsEnabled}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={(state) => {
          setSession(state);
          setAuthOpen(false);
          navigate('app');
        }}
      />

      {session.guest && (
        <DemoIntroModal
          open={demoIntroOpen}
          questionsLimit={session.guest.questionsLimit}
          onClose={() => setDemoIntroOpen(false)}
          onGetStarted={() => {
            setDemoIntroOpen(false);
            promptSignUp();
          }}
        />
      )}

      {session.guest && (
        <GuestNudgeModal
          open={nudge.open}
          blocking={nudge.blocking}
          questionsUsed={session.guest.questionsUsed}
          questionsLimit={session.guest.questionsLimit}
          onClose={() => setNudge({ open: false, blocking: false })}
          onSignIn={promptSignUp}
        />
      )}

      <ConnectKeyModal
        open={connectKey.open}
        reason={connectKey.reason}
        onClose={() => setConnectKey((s) => ({ ...s, open: false }))}
        providers={config.providers}
        freeCredits={config.freeCredits}
        onConnected={() => void refreshSession()}
      />

      <AppFooter />

      {session.user && (
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          session={session}
          config={config}
          onChanged={() => void refreshSession()}
          onConnectKey={() => {
            setSettingsOpen(false);
            setConnectKey({ open: true, reason: 'upgrade' });
          }}
        />
      )}
    </>
  );
}
