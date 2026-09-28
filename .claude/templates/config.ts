import * as dotenv from 'dotenv';
import * as path from 'node:path';

// .env lives at THIS project's root (src/support/ → ../../).
// Never read it from a level above: a shared multi-project .env makes the suite
// unclonable and couples it to unrelated projects' credentials.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Read a variable that has NO safe default.
 *
 * Anything identifying an ENVIRONMENT, a TENANT or the APP UNDER TEST belongs
 * here rather than behind a `??`. A fallback turns a missing or typo'd variable
 * into a run that quietly proceeds against the wrong target and reports green —
 * measured: an API base URL defaulting to production, plus a hardcoded org id,
 * pointed a destructive UI suite at prod under someone else's tenant. Fail at
 * import instead: loud, immediate, unmissable.
 *
 * Only genuinely environment-independent values (localhost, the default Appium
 * port, timeouts) keep a `??`.
 */
function required(name: string, hint?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Set it in the project-root .env ` +
        `(copy .env.example)${hint ? `. ${hint}` : '.'}`,
    );
  }
  return value;
}

export type Platform = 'android' | 'ios';
export type Framework = 'native' | 'rn' | 'flutter' | 'hybrid';

/** android | ios. Decides every platform branch in driver.ts and BasePage. */
export const PLATFORM = required(
  'APPIUM_PLATFORM',
  "Must be 'android' or 'ios'.",
).toLowerCase() as Platform;

/** native | rn | flutter | hybrid. Decides how fill() and the tree are read. */
export const FRAMEWORK = (process.env.APPIUM_FRAMEWORK ?? 'native').toLowerCase() as Framework;

export const isAndroid = PLATFORM === 'android';
export const isIOS = PLATFORM === 'ios';

if (!isAndroid && !isIOS) {
  throw new Error(`APPIUM_PLATFORM must be 'android' or 'ios', got '${PLATFORM}'.`);
}

/**
 * The app under test. REQUIRED, never defaulted — a default app id is how a
 * suite ends up driving, and reporting green against, the wrong application.
 * [Android] package name. [iOS] bundle id.
 */
export const APP_ID = required('APPIUM_APP_ID', '[android] package name, [iOS] bundle id.');

/** [Android] only. Blank on iOS, where it has no meaning. */
export const APP_ACTIVITY = process.env.APPIUM_APP_ACTIVITY ?? '';

export const APPIUM = {
  host: process.env.APPIUM_HOST ?? '127.0.0.1',
  port: Number(process.env.APPIUM_PORT ?? 4723),
  path: '/',
} as const;

export const DEVICE = {
  udid: process.env.APPIUM_UDID,
  /** [iOS] must match the device name EXACTLY or the session never starts. */
  name: process.env.APPIUM_DEVICE_NAME ?? (isAndroid ? 'Android Device' : ''),
  /** [iOS] only, e.g. "17.4". */
  platformVersion: process.env.APPIUM_PLATFORM_VERSION,
  /** [iOS] only, Apple Developer team id — needed to sign WebDriverAgent. */
  teamId: process.env.APPIUM_TEAM_ID,
} as const;

/**
 * Credentials.
 *
 * QUOTE EVERY VALUE IN .env. dotenv treats an unquoted `#` as an inline comment
 * and silently truncates the value at it — measured: a 9-character password
 * became 8, the app gave no error on a bad password, and it presented as a
 * broken button for an hour.
 */
export const CREDS = {
  email: process.env.APP_EMAIL,
  password: process.env.APP_PASSWORD,
} as const;

/**
 * The API the app talks to, and the org the credentials belong to.
 *
 * Both REQUIRED — these are exactly the two values that decide WHICH
 * ENVIRONMENT and WHOSE DATA a run touches, so a default here is the most
 * expensive kind of convenience. `API_BASE_URL` must match the environment the
 * INSTALLED BUILD points at; seeding dev while the app reads prod creates data
 * the app can never display, and every resulting failure looks like a product
 * defect.
 *
 * Lazy getters, not eager consts: the api/ layer needs them, but a spec that
 * never seeds must not fail to import because a seeding var is unset.
 */
export function apiBaseUrl(): string {
  return required('API_BASE_URL', 'Must match the environment the installed app points at.');
}

export function orgId(): string {
  return required('ORG_ID', 'The org/tenant the QA credentials belong to.');
}

/** Timeouts, in ms. Every wait is EXPLICIT — no implicit wait is ever set. */
export const TIMEOUT = {
  /** Default element wait. */
  element: Number(process.env.APPIUM_WAIT_TIMEOUT ?? 15_000),
  /** App launch. React Native's first frame lands ~700ms after the intent returns. */
  appLaunch: 45_000,
  /** A navigation that hits the network. */
  navigation: 30_000,
  /** A form submit that round-trips to the API. */
  submit: 30_000,
} as const;

/** Fail loudly at suite start rather than mid-flow on a blank login form. */
export function requireCreds(): { email: string; password: string } {
  const missing = Object.entries(CREDS)
    .filter(([, v]) => !v)
    .map(([k]) => `APP_${k.toUpperCase()}`);
  if (missing.length) {
    throw new Error(
      `Missing credential(s): ${missing.join(', ')}. Set them in the project-root ` +
        `.env (quote any value containing '#').`,
    );
  }
  return { email: CREDS.email as string, password: CREDS.password as string };
}
