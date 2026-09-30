import { useCallback, useEffect, useState } from 'react';
import type { AppConfigResponse, SessionState } from '@voicequery/shared';
import { api } from './lib/api.ts';
import { Landing } from './pages/Landing.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { AuthDialog } from './components/AuthDialog.tsx';
import { UpgradeModal } from './components/UpgradeModal.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { GuestNudgeModal } from './components/GuestNudgeModal.tsx';
import { AppFooter } from './components/AppFooter.tsx';
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
  const [upgrade, setUpgrade] = useState<{
    open: boolean;
    view: 'choose' | 'byok' | 'buy';
    reason: 'exhausted' | 'upgrade';
  }>({ open: false, view: 'choose', reason: 'exhausted' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
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

  /**
   * A checkout redirect is navigation only — it is never treated as proof of
   * payment. Credits appear once the signed webhook has been verified, so we
   * just re-read the authoritative balance from the server.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (!checkout) return;

    if (checkout === 'success') {
      setCheckoutNotice(
        'Payment received. Credits are added once the payment provider confirms it — this is usually instant, so refresh if the balance has not updated yet.',
      );
      void refreshSession();
    } else if (checkout === 'cancelled') {
      setCheckoutNotice('Checkout was cancelled. No payment was taken.');
    }
    window.history.replaceState({}, '', window.location.pathname);
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
      return;
    }
    if (!config?.guest.enabled) {
      setAuthMode('register');
      setAuthOpen(true);
      return;
    }
    try {
      setSession(await api.startGuest());
      navigate('app');
    } catch {
      // Guest mode unavailable — fall back to the sign-up path.
      setAuthMode('register');
      setAuthOpen(true);
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

  const signedIn = Boolean(session.user);

  return (
    <>
      {checkoutNotice && (
        <div className="fixed inset-x-0 top-0 z-50 p-3">
          <div className="mx-auto max-w-2xl">
            <Alert tone="accent">
              <div className="flex items-start justify-between gap-3">
                <p>{checkoutNotice}</p>
                <button
                  type="button"
                  onClick={() => setCheckoutNotice(null)}
                  className="shrink-0 text-xs underline"
                >
                  Dismiss
                </button>
              </div>
            </Alert>
          </div>
        </div>
      )}

      {route === 'app' && signedIn ? (
        <Dashboard
          session={session}
          config={config}
          onOpenSettings={() => setSettingsOpen(true)}
          onOutOfCredits={() =>
            setUpgrade({ open: true, view: 'choose', reason: 'exhausted' })
          }
          onConnectKey={() => setUpgrade({ open: true, view: 'byok', reason: 'upgrade' })}
          onSessionRefresh={() => void refreshSession()}
          onSignOut={() => void signOut()}
          onGuestNudge={(blocking) => setNudge({ open: true, blocking })}
          onSignUp={promptSignUp}
        />
      ) : (
        <Landing
          config={config}
          signedIn={signedIn}
          realAiActive={session.aiMode !== 'demo'}
          onTryDemo={() => void tryDemo()}
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
        <GuestNudgeModal
          open={nudge.open}
          blocking={nudge.blocking}
          questionsUsed={session.guest.questionsUsed}
          questionsLimit={session.guest.questionsLimit}
          onClose={() => setNudge({ open: false, blocking: false })}
          onSignIn={promptSignUp}
        />
      )}

      <UpgradeModal
        open={upgrade.open}
        initialView={upgrade.view}
        reason={upgrade.reason}
        onClose={() => setUpgrade((u) => ({ ...u, open: false }))}
        billing={config.billing}
        providers={config.providers}
        freeCredits={config.freeCredits}
        onByokConnected={() => void refreshSession()}
      />

      <AppFooter />

      {session.user && (
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          session={session}
          config={config}
          onChanged={() => void refreshSession()}
          onBuyCredits={() => {
            setSettingsOpen(false);
            setUpgrade({ open: true, view: 'buy', reason: 'upgrade' });
          }}
          onConnectKey={() => {
            setSettingsOpen(false);
            setUpgrade({ open: true, view: 'byok', reason: 'upgrade' });
          }}
        />
      )}
    </>
  );
}
