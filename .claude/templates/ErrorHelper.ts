/**
 * Error handling lives here, because a try/catch in a spec silently swallows the
 * failure it was supposed to report (zero tolerance #3).
 *
 * The honest use is TEARDOWN: cleanup runs after the assertions have already
 * passed, so a cleanup error must warn rather than turn a correct result red.
 * Never use this to make a flaky assertion pass.
 *
 * `eachWarnOnFailure` exists because of a real bug: clearAllUpcoming() wrapped a
 * whole loop in one try/catch, so the FIRST uncancellable appointment aborted
 * the rest and the suite believed the list was empty. Per-item isolation makes
 * that shape impossible.
 */
export class ErrorHelper {
  /** Runs an action and never throws. Logs the reason so a swallowed error is
   *  still visible. */
  static async warnOnFailure(action: () => Promise<void>, description: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.warn(`[teardown] ${description} — failed, continuing: ${reasonFor(error)}`);
    }
  }

  /**
   * Runs `action` for every item, isolating each one, and returns the items that
   * failed. One failure never stops the rest.
   */
  static async eachWarnOnFailure<T>(
    items: readonly T[],
    action: (item: T) => Promise<void>,
    describe: (item: T) => string,
  ): Promise<T[]> {
    let failed: T[] = [];
    for (let item of items) {
      try {
        await action(item);
      } catch (error) {
        failed.push(item);
        console.warn(`[teardown] ${describe(item)} — failed, continuing: ${reasonFor(error)}`);
      }
    }
    return failed;
  }

  /** Tries the primary action, falls back to a second one. For the teardown
   *  ladder, where a lower rung exists. */
  static async tryOrElse(primary: () => Promise<void>, fallback: () => Promise<void>): Promise<void> {
    try {
      await primary();
    } catch {
      await fallback();
    }
  }

  /** Whether an action succeeded, without throwing either way. */
  static async succeeded(action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch {
      return false;
    }
  }
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
