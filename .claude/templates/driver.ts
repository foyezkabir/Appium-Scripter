import { remote, type Browser } from 'webdriverio';
import { execFileSync } from 'node:child_process';
import { APP_ACTIVITY, APP_ID, APPIUM, DEVICE, FRAMEWORK, TIMEOUT, isAndroid } from './config';

let driver: Browser | undefined;

/** The live driver. Throws rather than returning undefined, so specs stay clean. */
export function d(): Browser {
  if (!driver) throw new Error('No Appium session. startSession() must run in beforeAll.');
  return driver;
}

/**
 * [Android] Release the UiAutomation connection.
 *
 * Android grants it to exactly ONE client. While Maestro's on-device driver
 * holds it, Appium cannot create a session at all:
 *   IllegalStateException: UiAutomation not connected
 * Stopping it is harmless — it is not the app under test, and Maestro restarts
 * it on demand. Extend this list if another automation tool is installed.
 */
function releaseUiAutomation(): void {
  if (!isAndroid) return;
  try {
    execFileSync('adb', ['shell', 'am', 'force-stop', 'dev.mobile.maestro'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    // adb missing or the other tool never installed — neither is a problem.
  }
}

/**
 * [Android] Guard against a skewed device clock.
 *
 * A wrong clock invalidates every current TLS certificate and surfaces as
 * "Trust anchor for certification path not found" app-wide — a device fault
 * that reads like a network or auth bug. Failing here with a clear message
 * beats debugging phantom failures.
 *
 * [iOS] Not implemented: there is no adb-equivalent one-liner to read the
 * device clock, and a wrong guess is worse than no check. An iOS device with a
 * skewed clock shows the same TLS symptom — check Settings › General › Date
 * & Time by hand if you see it.
 */
function assertClockSane(maxSkewSeconds = 300): void {
  if (!isAndroid) return;
  try {
    const out = execFileSync('adb', ['shell', 'date', '+%s'], { timeout: 15_000 }).toString().trim();
    const deviceEpoch = Number(out);
    if (!Number.isFinite(deviceEpoch)) return;
    const skew = Math.abs(Date.now() / 1000 - deviceEpoch);
    if (skew > maxSkewSeconds) {
      throw new Error(
        `Device clock is off by ${Math.round(skew)}s. TLS will fail app-wide with ` +
          `"Trust anchor for certification path not found". Fix the device clock before testing.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Device clock')) throw err;
    // adb unavailable — skip the check rather than blocking the run.
  }
}

/** The automationName for this platform + framework. */
function automationName(): string {
  if (process.env.APPIUM_AUTOMATION) return process.env.APPIUM_AUTOMATION;
  if (FRAMEWORK === 'flutter') return 'FlutterIntegration';
  return isAndroid ? 'UiAutomator2' : 'XCUITest';
}

function buildCapabilities(): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    'appium:automationName': automationName(),
    // Keep the app's own state so a prior login survives — the suite logs in
    // once and reuses the session. Set APPIUM_RESET=1 for a clean-state run.
    'appium:noReset': process.env.APPIUM_RESET !== '1',
    'appium:fullReset': false,
    // Session IDLE timeout, NOT an implicit wait. No implicit wait is ever set:
    // mixing implicit + explicit produces compound timeouts and is the single
    // most common cause of "flaky on CI, fine locally".
    'appium:newCommandTimeout': 600,
  };
  if (DEVICE.udid) shared['appium:udid'] = DEVICE.udid;

  if (isAndroid) {
    return {
      ...shared,
      platformName: 'Android',
      'appium:deviceName': DEVICE.name,
      'appium:appPackage': APP_ID,
      ...(APP_ACTIVITY ? { 'appium:appActivity': APP_ACTIVITY } : {}),
      'appium:autoGrantPermissions': true,
      'appium:disableWindowAnimation': true,
      'appium:uiautomator2ServerInstallTimeout': 120_000,
      'appium:adbExecTimeout': 60_000,
    };
  }

  // [iOS] UNVERIFIED ON A DEVICE — authored from the XCUITest capability docs,
  // not from a run. `deviceName` must match the device EXACTLY or the session
  // never starts, and WebDriverAgent needs a signing team id on a real device.
  return {
    ...shared,
    platformName: 'iOS',
    'appium:deviceName': DEVICE.name,
    'appium:bundleId': APP_ID,
    ...(DEVICE.platformVersion ? { 'appium:platformVersion': DEVICE.platformVersion } : {}),
    ...(DEVICE.teamId ? { 'appium:xcodeOrgId': DEVICE.teamId, 'appium:xcodeSigningId': 'iPhone Developer' } : {}),
    'appium:autoAcceptAlerts': true,
    'appium:wdaLaunchTimeout': 120_000,
    'appium:wdaConnectionTimeout': 120_000,
  };
}

/**
 * Prove the app under test is actually in the foreground.
 *
 * `noReset: true` attaches to WHATEVER IS FOREGROUND — measured: the first
 * probe of a suite landed on the Play Store. Without this a whole run can go
 * green against a different app entirely.
 *
 * The check is per-platform because the Android API THROWS on iOS rather than
 * degrading: `getCurrentPackage()` does not exist there.
 */
async function assertAppIsForeground(): Promise<void> {
  const dr = driver!;
  if (isAndroid) {
    await dr.waitUntil(async () => (await dr.getCurrentPackage()) === APP_ID, {
      timeout: TIMEOUT.appLaunch,
      interval: 750,
      timeoutMsg: `${APP_ID} did not come to the foreground within ${TIMEOUT.appLaunch}ms`,
    });
    return;
  }
  // [iOS] queryAppState returns 4 = "running in foreground".
  await dr.waitUntil(async () => (await dr.queryAppState(APP_ID)) === 4, {
    timeout: TIMEOUT.appLaunch,
    interval: 750,
    timeoutMsg: `${APP_ID} was not running in the foreground within ${TIMEOUT.appLaunch}ms`,
  });
}

export async function startSession(): Promise<Browser> {
  if (driver) return driver;

  releaseUiAutomation();
  assertClockSane();

  driver = await remote({
    hostname: APPIUM.host,
    port: APPIUM.port,
    path: APPIUM.path,
    logLevel: 'error',
    capabilities: buildCapabilities(),
  });

  await driver.activateApp(APP_ID);
  await assertAppIsForeground();

  return driver;
}

/**
 * Always tear the session down. A crashed spec that leaves a session alive locks
 * the device out of the next run.
 */
export async function endSession(): Promise<void> {
  if (!driver) return;
  try {
    await driver.deleteSession();
  } finally {
    driver = undefined;
  }
}
