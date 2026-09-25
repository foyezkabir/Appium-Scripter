/**
 * StepRecorder.ts — per-step timings for the HTML report.
 *
 * Jest hands a reporter only a TOTAL duration per test; there is no step
 * breakdown to read. So steps must be recorded as they happen. Every
 * `BasePage` action wraps itself in `StepRecorder.step()`, which times the
 * call and appends one line to appium-reports/steps.jsonl. The reporter reads
 * that file and renders the steps under each test.
 *
 * Rules:
 *  - Recording NEVER changes behaviour. The wrapped call's result is returned
 *    untouched and a thrown error is re-thrown after being recorded.
 *  - A recording failure is swallowed. Losing a report line must never fail a
 *    test — that would make the reporter a source of false findings.
 *  - Steps carry no assertions. This is instrumentation, not a test tier.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'appium-reports';
const FILE = join(OUT, 'steps.jsonl');

export type StepStatus = 'passed' | 'failed';

export interface StepRecord {
  /** Full test name, used to pair a step back to its test. */
  test: string;
  /** What the step did, e.g. 'tap Save button'. */
  title: string;
  /** Milliseconds the step took. */
  ms: number;
  status: StepStatus;
  /** First line of the error, when the step threw. */
  error?: string;
}

export class StepRecorder {
  /** Set by the fixture/setup before each test so steps pair to the right one. */
  private static current = '';

  static setTest(name: string) {
    StepRecorder.current = name;
  }

  /**
   * Time `fn`, record it, return whatever it returned. On a throw, record the
   * failure and RE-THROW — swallowing here would hide a real defect.
   */
  static async step<T>(title: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await fn();
      StepRecorder.write({ test: StepRecorder.current, title, ms: Date.now() - started, status: 'passed' });
      return out;
    } catch (e) {
      StepRecorder.write({
        test: StepRecorder.current,
        title,
        ms: Date.now() - started,
        status: 'failed',
        error: String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300),
      });
      throw e;
    }
  }

  private static write(rec: StepRecord) {
    try {
      mkdirSync(OUT, { recursive: true });
      appendFileSync(FILE, `${JSON.stringify(rec)}\n`);
    } catch {
      // Instrumentation must never fail a run.
    }
  }
}
