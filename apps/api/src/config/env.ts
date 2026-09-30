import { z } from 'zod';

/**
 * All configuration is read once, validated, and frozen. Nothing else in the
 * codebase touches process.env, so every knob is discoverable from here and
 * from .env.example.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8787),
  HOST: z.string().default('0.0.0.0'),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * Postgres connection string. When absent in development/test the server
   * falls back to an embedded PGlite instance (real Postgres, WASM build) so
   * the project runs with no external services. Production requires it.
   */
  DATABASE_URL: z.string().optional(),
  /** Aliases some platforms use instead of DATABASE_URL (Vercel, Neon). */
  POSTGRES_URL: z.string().optional(),
  POSTGRESQL_URL: z.string().optional(),

  /** Signing key for session cookies. Must be set in production. */
  SESSION_SECRET: z.string().default('dev-only-insecure-session-secret-change-me'),
  SESSION_TTL_HOURS: int(24 * 14),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().optional(),

  /* ------------------------------- AI provider ------------------------------ */
  //
  // The platform provider is whichever key is set. AI_PROVIDER disambiguates
  // when more than one is present.
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'openrouter']).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  /** Model for the platform provider. Anthropic has a sensible default; the
   *  OpenAI-compatible providers require this to be set explicitly, because
   *  guessing a model id that a provider later renames is worse than asking. */
  AI_MODEL: z.string().optional(),
  AI_TIMEOUT_MS: int(60_000),
  AI_MAX_OUTPUT_TOKENS: int(4_000),

  /**
   * Directory holding the built frontend. When present, the API serves it
   * from the same origin, which is what lets the SameSite=Lax session cookie
   * work without weakening it to SameSite=None for a cross-site setup.
   * Defaults to the workspace build output.
   */
  WEB_DIST_DIR: z.string().default('../web/dist'),

  /* -------------------------------- datasets -------------------------------- */
  DATA_DIR: z.string().default('.data'),
  MAX_UPLOAD_BYTES: int(10 * 1024 * 1024),
  MAX_ROWS: int(200_000),
  MAX_COLUMNS: int(60),
  /** Rows shipped to the browser per analysis. Aggregates are computed on the full set. */
  MAX_RESULT_ROWS: int(500),
  /** Rows of the result set the model may see when writing the explanation. */
  MAX_EXPLAIN_ROWS: int(40),
  DATASET_TTL_HOURS: int(24),

  /* ------------------------------ query sandbox ----------------------------- */
  QUERY_TIMEOUT_MS: int(10_000),
  DUCKDB_MEMORY_LIMIT: z.string().default('512MB'),
  DUCKDB_THREADS: int(2),

  /* --------------------------------- credits -------------------------------- */
  FREE_CREDITS: int(2),

  /**
   * Whether the offline demo provider consumes credits.
   *
   * Default false, because demo mode makes no provider call and spends no
   * money — charging an AI credit for it would misrepresent what happened.
   * Its real cost is hosting and CPU, which the rate limits cover, exactly as
   * for BYOK.
   *
   * Set true to walk through the free-allowance and upgrade flows on a
   * deployment that has no AI credentials (useful when recording a demo).
   */
  DEMO_CONSUMES_CREDITS: bool(false),

  /* ---------------------------------- guests -------------------------------- */

  /** Let anonymous visitors try the demo without signing in. */
  GUEST_MODE_ENABLED: bool(true),
  /** Answers a guest sees before the first sign-in nudge. */
  GUEST_NUDGE_AFTER: int(2),
  /** How often the nudge repeats after the first one. */
  GUEST_NUDGE_EVERY: int(3),
  /**
   * Hard ceiling on analyses per guest session. The nudge is persuasion and
   * is dismissible; this is the abuse control and is not.
   */
  GUEST_QUESTION_LIMIT: int(15),
  /** Guest accounts and their conversations are swept after this long. */
  GUEST_TTL_HOURS: int(24),

  /* --------------------------------- billing -------------------------------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * JSON array of credit packages. Price is deliberately operator-configured:
   * it should be derived from measured model/hosting cost, not guessed here.
   * e.g. [{"id":"pack20","name":"20 questions","credits":20,"amountMinor":900,"currency":"usd"}]
   */
  CREDIT_PACKAGES: z.string().default('[]'),
  CHECKOUT_SUCCESS_URL: z.string().default('http://localhost:5173/app?checkout=success'),
  CHECKOUT_CANCEL_URL: z.string().default('http://localhost:5173/app?checkout=cancelled'),

  /* ------------------------------- rate limits ------------------------------ */
  RATE_LIMIT_ANALYSIS_PER_HOUR: int(60),
  RATE_LIMIT_UPLOAD_PER_HOUR: int(20),
  RATE_LIMIT_GLOBAL_PER_MINUTE: int(300),
});

const PackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  credits: z.number().int().positive(),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
});

function load() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  let packages: z.infer<typeof PackageSchema>[] = [];
  try {
    const raw: unknown = JSON.parse(e.CREDIT_PACKAGES);
    packages = z.array(PackageSchema).parse(raw);
  } catch (err) {
    throw new Error(
      `CREDIT_PACKAGES must be a JSON array of {id,name,credits,amountMinor,currency}: ${
        (err as Error).message
      }`,
    );
  }

  // Accept the common aliases so the app works on platforms that name the
  // variable differently. Does not help where the value simply is not set.
  const databaseUrl = e.DATABASE_URL || e.POSTGRES_URL || e.POSTGRESQL_URL || undefined;

  const isProd = e.NODE_ENV === 'production';
  if (isProd) {
    // These are the two things every first deployment gets wrong, so the
    // messages say how to fix them rather than only naming the variable —
    // this text is the whole of what someone sees in a crashed deploy log.
    if (!databaseUrl) {
      throw new Error(
        [
          'DATABASE_URL is required in production, and no value was found.',
          '',
          '  This is almost always an unset variable rather than a bad one.',
          '  Most platforms do NOT inject a database URL into other services',
          '  automatically — it has to be referenced explicitly:',
          '',
          '    Railway   add a variable to THIS service:',
          '                DATABASE_URL = ${{ Postgres.DATABASE_URL }}',
          '              using the database service name from the sidebar',
          '    Fly.io    fly postgres attach <db-app-name>',
          '    Docker    see docker-compose.yml',
          '',
          '  Refusing to start on purpose: without it the server would fall',
          '  back to an embedded database and silently lose every signup and',
          '  upload on the next deploy.',
        ].join('\n'),
      );
    }
    if (e.SESSION_SECRET.startsWith('dev-only-')) {
      throw new Error(
        [
          'SESSION_SECRET is still the insecure development default.',
          '',
          '  Generate one and set it as an environment variable:',
          '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
          '',
          '  It signs session cookies. A known value means anyone can forge',
          '  a session for any account.',
        ].join('\n'),
      );
    }
  }

  /* ------------------------ platform provider selection --------------------- */

  const platformKeys = {
    anthropic: e.ANTHROPIC_API_KEY,
    openai: e.OPENAI_API_KEY,
    openrouter: e.OPENROUTER_API_KEY,
  } as const;

  const configured = (Object.keys(platformKeys) as (keyof typeof platformKeys)[]).filter(
    (id) => Boolean(platformKeys[id]),
  );

  let platformProvider: { id: 'anthropic' | 'openai' | 'openrouter'; apiKey: string; model: string | null } | null =
    null;

  if (e.AI_PROVIDER) {
    const key = platformKeys[e.AI_PROVIDER];
    if (!key) {
      throw new Error(
        `AI_PROVIDER is "${e.AI_PROVIDER}" but ${e.AI_PROVIDER.toUpperCase()}_API_KEY is not set.`,
      );
    }
    platformProvider = { id: e.AI_PROVIDER, apiKey: key, model: e.AI_MODEL ?? null };
  } else if (configured.length === 1) {
    const id = configured[0]!;
    platformProvider = { id, apiKey: platformKeys[id]!, model: e.AI_MODEL ?? null };
  } else if (configured.length > 1) {
    throw new Error(
      `Several provider keys are set (${configured.join(', ')}). Set AI_PROVIDER to choose which one the platform uses.`,
    );
  }

  // Anthropic has a stable default model; the OpenAI-compatible providers do
  // not, so an explicit AI_MODEL is required rather than guessed.
  if (platformProvider) {
    if (platformProvider.id === 'anthropic') {
      platformProvider.model ??= 'claude-opus-5';
    } else if (!platformProvider.model) {
      throw new Error(
        `AI_MODEL must be set when AI_PROVIDER is "${platformProvider.id}" (for example gpt-6.1-sol, or anthropic/claude-sonnet-4.5 on OpenRouter).`,
      );
    }
  }

  /** No platform AI key => the app answers with the clearly-labelled demo provider. */
  const demoMode = !platformProvider;

  /** Stripe test keys are prefixed sk_test_; anything else is live. */
  const billingEnabled = Boolean(e.STRIPE_SECRET_KEY) && packages.length > 0;
  const billingTestMode = !e.STRIPE_SECRET_KEY?.startsWith('sk_live_');

  if (isProd && billingEnabled && !e.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required when billing is enabled in production.');
  }

  return Object.freeze({
    ...e,
    DATABASE_URL: databaseUrl,
    isProd,
    isTest: e.NODE_ENV === 'test',
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    packages,
    demoMode,
    platformProvider,
    billingEnabled,
    billingTestMode,
  });
}

export type AppConfig = ReturnType<typeof load>;

let cached: AppConfig | null = null;

export function config(): AppConfig {
  cached ??= load();
  return cached;
}

/** Test helper — forces re-read of process.env. */
export function resetConfigForTests(): void {
  cached = null;
}
