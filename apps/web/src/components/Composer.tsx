import { useEffect, useRef, useState } from 'react';
import { Button, Alert } from './ui.tsx';
import { useSpeech } from '../hooks/useSpeech.ts';

/**
 * Question input.
 *
 * Typing always works. The microphone is an addition, never a requirement —
 * when the browser has no speech recognition the control is replaced by an
 * explanatory note rather than a broken button.
 *
 * Speech fills the same textarea the user can edit, so the transcript is
 * always reviewed and correctable before anything is submitted.
 */
export function Composer({
  onSubmit,
  disabled,
  busy,
  placeholder,
  onCancel,
}: {
  onSubmit: (question: string) => void;
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [micNoticeSeen, setMicNoticeSeen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeech();

  // Speech results flow into the editable field rather than straight to submit.
  useEffect(() => {
    if (speech.transcript) {
      setValue(speech.transcript);
      textareaRef.current?.focus();
    }
  }, [speech.transcript]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value, speech.interim]);

  const listening = speech.status === 'listening';

  const submit = () => {
    const question = value.trim();
    if (!question || disabled || busy) return;
    if (listening) speech.stop();
    onSubmit(question);
    setValue('');
    speech.reset();
  };

  const toggleMic = () => {
    if (listening) {
      speech.stop();
      return;
    }
    setMicNoticeSeen(true);
    speech.reset();
    setValue('');
    speech.start();
  };

  return (
    <div className="space-y-2">
      {speech.error && <Alert tone="warning">{speech.error}</Alert>}

      {listening && !micNoticeSeen && (
        <Alert tone="accent">
          Your browser is handling speech recognition. In Chrome and Edge the audio is sent to
          Google for transcription.
        </Alert>
      )}

      <div
        className={`rounded-xl border bg-[var(--surface-raised)] transition-colors ${
          listening ? 'border-[var(--accent)]' : 'border-[var(--border-strong)]'
        }`}
      >
        <label htmlFor="vq-question" className="sr-only">
          Ask a question about your data
        </label>
        <textarea
          id="vq-question"
          ref={textareaRef}
          rows={1}
          value={value + (speech.interim ? ` ${speech.interim}` : '')}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          placeholder={placeholder ?? 'Ask a question about your data…'}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none disabled:opacity-60"
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
          <div className="flex items-center gap-2">
            {speech.supported ? (
              <button
                type="button"
                onClick={toggleMic}
                disabled={disabled}
                aria-pressed={listening}
                aria-label={listening ? 'Stop recording' : 'Ask by voice'}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  listening
                    ? 'bg-[var(--critical-soft)] text-[var(--critical)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 1.5a2 2 0 0 0-2 2v5a2 2 0 1 0 4 0v-5a2 2 0 0 0-2-2Z" />
                  <path d="M3.5 7.5a.75.75 0 0 1 1.5 0 3 3 0 1 0 6 0 .75.75 0 0 1 1.5 0 4.5 4.5 0 0 1-3.75 4.44V14h1.75a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5H7.25v-2.06A4.5 4.5 0 0 1 3.5 7.5Z" />
                </svg>
                {listening ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="vq-pulse inline-block h-1.5 w-1.5 rounded-full bg-[var(--critical)]" />
                    Listening — tap to stop
                  </span>
                ) : (
                  'Voice'
                )}
              </button>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">
                Voice input is not available in this browser — typing works everywhere.
              </span>
            )}

            {listening && (
              <span className="text-xs text-[var(--text-muted)]">
                You can edit the text before sending
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {busy && onCancel && (
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button size="sm" onClick={submit} disabled={disabled || !value.trim()} loading={busy}>
              {busy ? 'Analysing' : 'Ask'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
