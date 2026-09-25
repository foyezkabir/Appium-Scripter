/**
 * jest.setup.ts — standing infrastructure, loaded via setupFilesAfterEnv.
 *
 * On a physical device you cannot see what the screen looked like when a test
 * failed, and the stack trace rarely says. This captures a screenshot plus the
 * page source at the moment of failure, named after the test, into
 * appium-reports/failures/.
 *
 * It wraps the global `it`/`test` rather than using an afterEach, because an
 * afterEach runs AFTER teardown has already navigated away — by then the
 * screen no longer shows the failure.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('appium-reports', 'failures');

/** Filesystem-safe name from a test title. */
const slug = (s: string) =>
  s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);

/** Only what this file needs — NOT ReturnType<typeof d>: if d()'s signature
 *  is `never` (it throws when there is no session) that collapses to `never`
 *  and every property access below becomes a compile error, failing the whole
 *  suite before a single test runs. */
type Capturable = {
  takeScreenshot(): Promise<string>;
  getPageSource(): Promise<string>;
};

async function capture(testName: string) {
  // Imported lazily: at module load the driver does not exist yet.
  let driver: Capturable;
  try {
    const { d } = await import('./src/support/driver');
    driver = d() as unknown as Capturable;
  } catch {
    return; // no live session — nothing to capture, and that is not an error
  }

  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(OUT, `${stamp}__${slug(testName)}`);

  // Each capture is independent: a failure to grab the screenshot must not
  // prevent the page source, and neither must ever mask the real test failure.
  try {
    const png = await driver.takeScreenshot();
    // tools/html-reporter.mjs reads this directory after the run and embeds
    // the image in report.html, pairing it to the test by the slugged name.
    // Keep that slug() in step with this one or artefacts stop pairing.
    writeFileSync(`${base}.png`, Buffer.from(png, 'base64'));
  } catch (e) {
    console.warn(`[setup] screenshot failed: ${(e as Error).message}`);
  }

  try {
    writeFileSync(`${base}.xml`, await driver.getPageSource());
  } catch (e) {
    console.warn(`[setup] page source failed: ${(e as Error).message}`);
  }
}

/**
 * Wrap the global test fn so a throwing body is captured, then RE-THROWN.
 * Swallowing here would turn every failure green — the exact thing violation
 * #3 exists to prevent.
 */
function wrap(original: jest.It): jest.It {
  const wrapped = ((name: string, fn?: jest.ProvidesCallback, timeout?: number) => {
    if (!fn) return original(name, fn as never, timeout);
    const inner = async (...args: unknown[]) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (fn as any)(...args);
      } catch (err) {
        await capture(name);
        throw err; // ALWAYS re-throw
      }
    };
    return original(name, inner as jest.ProvidesCallback, timeout);
  }) as jest.It;

  // Preserve .each / .only / .skip / .todo / .failing.
  return Object.assign(wrapped, original);
}

/**
 * Tell StepRecorder which test is running, so the steps it records pair back
 * to the right test in the report. WITHOUT THIS every step is written with an
 * empty test name and the report's Steps section is silently empty — verified
 * against a fresh clone.
 */
beforeEach(() => {
  try {
    // Required lazily: a project that has not scaffolded StepRecorder yet
    // must still run.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { StepRecorder } = require('./src/support/StepRecorder');
    StepRecorder.setTest(expect.getState().currentTestName ?? '');
  } catch {
    /* recorder absent — steps simply are not recorded */
  }
});

global.it = wrap(global.it);
global.test = wrap(global.test);

export {};
