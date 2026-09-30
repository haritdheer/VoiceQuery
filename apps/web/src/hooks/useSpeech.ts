import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice input via the browser's Web Speech API.
 *
 * Important honesty notes, surfaced in the UI:
 *  - This is *browser* speech recognition, not a hosted transcription service.
 *    In Chrome and Edge the audio is sent to Google's servers for recognition;
 *    the component says so before the microphone is used.
 *  - Support is genuinely partial (Firefox has none), so `supported` is
 *    checked before the control is offered and typing always works.
 *  - The transcript is editable before submission — nothing is analysed until
 *    the user presses send.
 *
 * This is press-to-talk dictation. It is not full-duplex conversation, and the
 * UI does not claim otherwise.
 */

type RecognitionStatus = 'idle' | 'listening' | 'error' | 'unsupported';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeechResult {
  supported: boolean;
  status: RecognitionStatus;
  /** Text confirmed by the recogniser. */
  transcript: string;
  /** In-progress text, shown greyed while speaking. */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

const FRIENDLY_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow it in your browser settings, or type instead.',
  'service-not-allowed': 'Speech recognition was blocked by your browser. Type your question instead.',
  'no-speech': "I didn't catch anything. Try again, or type your question.",
  'audio-capture': 'No microphone was found. Connect one, or type your question.',
  network: 'Speech recognition needs a network connection. Type your question instead.',
  aborted: '',
};

export function useSpeech(): UseSpeechResult {
  const ctorRef = useRef<RecognitionCtor | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<RecognitionStatus>('unsupported');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctor = getRecognitionCtor();
    ctorRef.current = ctor;
    setSupported(Boolean(ctor));
    setStatus(ctor ? 'idle' : 'unsupported');

    return () => {
      // Stop the microphone if the component unmounts mid-recording.
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const ctor = ctorRef.current;
    if (!ctor) return;

    recognitionRef.current?.abort();
    setError(null);
    setInterim('');

    const recognition = new ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => setStatus('listening');

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const chunk = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += chunk;
        else interimText += chunk;
      }
      if (finalText) {
        setTranscript((prev) => (prev ? `${prev} ${finalText.trim()}` : finalText.trim()));
      }
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      const message = FRIENDLY_ERRORS[event.error] ?? 'Speech recognition failed. Type instead.';
      if (message) {
        setError(message);
        setStatus('error');
      } else {
        setStatus('idle');
      }
      setInterim('');
    };

    recognition.onend = () => {
      setInterim('');
      setStatus((s) => (s === 'error' ? s : 'idle'));
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setError('Could not start the microphone. Type your question instead.');
      setStatus('error');
    }
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setStatus('idle');
  }, []);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
    if (status === 'error') setStatus('idle');
  }, [status]);

  return { supported, status, transcript, interim, error, start, stop, reset };
}

/* ------------------------------ spoken replies ----------------------------- */

/**
 * Optional spoken answers via browser speech synthesis. Off by default, and
 * the UI states that this is the browser's own voice — no hosted text-to-speech
 * service is involved and no provider key is required for it.
 */
export function useSpeechSynthesis() {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!supported) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [supported],
  );

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  return { supported, speaking, speak, cancel };
}
