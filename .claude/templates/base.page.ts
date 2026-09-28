import type { ChainablePromiseElement } from 'webdriverio';
import { d } from '../support/driver';
import { FRAMEWORK, TIMEOUT, isAndroid } from '../support/config';

/**
 * Base page object. Every page extends this.
 *
 * TWO RULES THIS CLASS EXISTS TO ENFORCE:
 *
 * 1. Locators are exposed as METHODS THAT RE-QUERY, never as stored element
 *    handles. An Appium handle goes stale the instant the view re-renders
 *    (unlike Playwright's lazy locators), so nothing is cached.
 *
 * 2. EXPLICIT WAITS ONLY. Every helper takes a timeout and waits on a real
 *    condition. No implicit wait is configured anywhere in the suite.
 *
 * THIS IS THE ONLY FILE THAT KNOWS THE PLATFORM. Every per-OS branch lives
 * here, behind a method whose name says the intent — so page objects, specs and
 * locator files stay platform-neutral and the suite shape is identical on
 * Android and iOS.
 *
 * VERIFICATION STATUS: the Android paths are measured on-device. The iOS paths
 * are authored from the XCUITest documentation and HAVE NOT BEEN RUN ON A
 * DEVICE — each is marked `[iOS] UNVERIFIED`. Confirm one before trusting it,
 * and delete the marker when you do.
 */
export abstract class BasePage {
  /**
   * Accessibility id of a stable element in the floating bottom nav, if this app
   * has one. Set it in a subclass (or leave undefined) — it is the anchor
   * `scrollFieldIntoReach()` uses to know where the nav starts.
   *
   * Left undefined, the nudge becomes a no-op rather than guessing, and
   * `scrollFieldIntoReach()` degrades to `scrollToText()`.
   */
  protected bottomNavAnchor: string | undefined = undefined;

  // ---------------------------------------------------------------- locators

  /** By accessibility id. The PREFERRED locator on both platforms. */
  protected byA11y(name: string): ChainablePromiseElement {
    return d().$(`~${name}`);
  }

  /** By exact visible text. */
  protected byText(text: string): ChainablePromiseElement {
    return isAndroid
      ? d().$(`android=new UiSelector().text(${JSON.stringify(text)})`)
      : // [iOS] UNVERIFIED. `label` covers most controls; static text uses `name`.
        d().$(`-ios predicate string:label == ${JSON.stringify(text)} OR name == ${JSON.stringify(text)}`);
  }

  /** By text fragment — use only when the full string is dynamic. */
  protected byTextContains(fragment: string): ChainablePromiseElement {
    return isAndroid
      ? d().$(`android=new UiSelector().textContains(${JSON.stringify(fragment)})`)
      : // [iOS] UNVERIFIED.
        d().$(`-ios predicate string:label CONTAINS ${JSON.stringify(fragment)} OR name CONTAINS ${JSON.stringify(fragment)}`);
  }

  /** [Android] resource-id. [iOS] name. Rare in RN apps — little carries one. */
  protected byId(id: string): ChainablePromiseElement {
    return isAndroid
      ? d().$(`android=new UiSelector().resourceId(${JSON.stringify(id)})`)
      : // [iOS] UNVERIFIED.
        d().$(`-ios predicate string:name == ${JSON.stringify(id)}`);
  }

  /**
   * The Nth text input in document order.
   *
   * This is the documented exception to "never select by position": RN inputs
   * often carry no resource-id, and a placeholder selector matches ONLY while
   * the field is empty — once filled, the placeholder node is gone. Where a form
   * has a fixed, order-stable set of inputs, the index is the only handle that
   * works in every state. EACH CALLER MUST JUSTIFY ITS INDEX IN A COMMENT.
   */
  protected editTextAt(index: number): ChainablePromiseElement {
    return isAndroid
      ? d().$(`android=new UiSelector().className("android.widget.EditText").instance(${index})`)
      : // [iOS] UNVERIFIED.
        d().$(`-ios class chain:**/XCUIElementTypeTextField[${index + 1}]`);
  }

  // ------------------------------------------------------------------- waits

  async waitVisible(
    el: ChainablePromiseElement,
    label: string,
    timeout: number = TIMEOUT.element,
  ): Promise<void> {
    await el.waitForDisplayed({
      timeout,
      timeoutMsg: `"${label}" was not displayed within ${timeout}ms (${this.constructor.name})`,
    });
  }

  async waitGone(
    el: ChainablePromiseElement,
    label: string,
    timeout: number = TIMEOUT.element,
  ): Promise<void> {
    await el.waitForDisplayed({
      timeout,
      reverse: true,
      timeoutMsg: `"${label}" was still displayed after ${timeout}ms (${this.constructor.name})`,
    });
  }

  /** One of the two legitimate try/catch sites: a throw here means "not present". */
  async isVisible(el: ChainablePromiseElement, timeout = 4_000): Promise<boolean> {
    try {
      await el.waitForDisplayed({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** Wait until a given text is on screen. */
  async waitForText(text: string, timeout: number = TIMEOUT.element): Promise<void> {
    await this.waitVisible(this.byText(text), `text "${text}"`, timeout);
  }

  // ----------------------------------------------------------------- actions

  async tap(
    el: ChainablePromiseElement,
    label: string,
    timeout: number = TIMEOUT.element,
  ): Promise<void> {
    await this.waitVisible(el, label, timeout);
    await el.click();
  }

  /**
   * Fill a text input so BOTH the native view and the framework's state agree.
   *
   * [RN] Neither half is optional:
   *  - `setValue()` sets the native field atomically and PRESERVES SYMBOLS.
   *    `driver.keys()` routes through the IME and drops characters that need a
   *    symbol page — a '#' vanished this way and produced a silent auth failure.
   *  - `setValue()` alone can leave RN's `onChangeText` unfired, so RN's form
   *    state stays empty while the native tree shows the text. The submit button
   *    then reads enabled but its handler no-ops.
   *
   * The throwaway keystroke + backspace forces one real change event carrying
   * the full string. It is [Android] only — `pressKeyCode` does not exist on
   * iOS and THROWS rather than degrading.
   */
  async fill(el: ChainablePromiseElement, value: string, label: string): Promise<void> {
    await this.waitVisible(el, label);
    await el.click();
    await el.clearValue();
    await el.setValue(value);
    if (isAndroid && FRAMEWORK === 'rn') {
      await d().keys(['x']);
      await d().pressKeyCode(67); // KEYCODE_DEL
    }
    await this.hideKeyboard();
  }

  /**
   * Dismiss the keyboard.
   *
   * The second legitimate try/catch site. [Android] reliable. [iOS] throws when
   * no keyboard is up, and often needs a Done/Return tap instead — so a throw
   * here genuinely means "not applicable", not "failed".
   */
  async hideKeyboard(): Promise<void> {
    try {
      if (await d().isKeyboardShown()) await d().hideKeyboard();
    } catch {
      // No keyboard up, or the driver throws rather than no-opping. Not a failure.
    }
  }

  /**
   * Go back one screen.
   *
   * NEVER call this `pressBack()` — that name bakes in an Android assumption
   * that has no iOS meaning. [Android] the hardware back button. [iOS] there is
   * NO back button at all, so it swipes from the left edge.
   */
  async goBack(): Promise<void> {
    if (isAndroid) {
      await d().pressKeyCode(4);
      return;
    }
    // [iOS] UNVERIFIED. Prefer tapping the nav bar's back control from the page
    // object when the screen has one — this edge swipe is the fallback.
    const { width, height } = await d().getWindowSize();
    await d()
      .action('pointer')
      .move({ x: 2, y: Math.round(height / 2) })
      .down()
      .move({ x: Math.round(width * 0.6), y: Math.round(height / 2), duration: 300 })
      .up()
      .perform();
  }

  // --------------------------------------------------------------- scrolling

  /**
   * Scroll an element into view by driving the SCROLL CONTAINER, not by swiping
   * at screen coordinates.
   *
   * This is not a style preference. A coordinate swipe low enough to scroll a
   * long form starts on the bottom nav, and the OS delivers it as a TAB TAP —
   * the app silently navigates away and the half-filled form is lost. It
   * destroyed two forms before being diagnosed. Driving the scrollable node
   * directly cannot stray onto the nav bar.
   *
   * The keyboard is dismissed first because an open IME shrinks the viewport,
   * which is what defeats a raised-start-point workaround.
   */
  async scrollToText(text: string, maxSwipes = 12): Promise<ChainablePromiseElement> {
    await this.hideKeyboard();
    if (isAndroid) {
      const selector =
        `android=new UiScrollable(new UiSelector().scrollable(true))` +
        `.setMaxSearchSwipes(${maxSwipes})` +
        `.scrollIntoView(new UiSelector().text(${JSON.stringify(text)}))`;
      await d().$(selector);
    } else {
      // [iOS] UNVERIFIED. `mobile: scroll` with a predicate drives the scroll
      // view rather than the screen, which is the property that matters here.
      await d().execute('mobile: scroll', {
        predicateString: `label == ${JSON.stringify(text)} OR name == ${JSON.stringify(text)}`,
        toVisible: true,
      });
    }
    return this.byText(text);
  }

  /** As `scrollToText`, but targeting an accessibility id. */
  async scrollToA11y(name: string, maxSwipes = 12): Promise<ChainablePromiseElement> {
    await this.hideKeyboard();
    if (isAndroid) {
      const selector =
        `android=new UiScrollable(new UiSelector().scrollable(true))` +
        `.setMaxSearchSwipes(${maxSwipes})` +
        `.scrollIntoView(new UiSelector().description(${JSON.stringify(name)}))`;
      await d().$(selector);
    } else {
      // [iOS] UNVERIFIED.
      await d().execute('mobile: scroll', {
        predicateString: `name == ${JSON.stringify(name)}`,
        toVisible: true,
      });
    }
    return this.byA11y(name);
  }

  /**
   * Scroll a FORM FIELD into a genuinely TAPPABLE position.
   *
   * Only forms need this, and only page objects that fill fields should call it.
   * `scrollToText` deliberately does NOT nudge: doing it on every text lookup
   * made a 15-row menu enumeration take 447 seconds, because it re-measured and
   * re-scrolled for every row. Reserve this for inputs.
   */
  async scrollFieldIntoReach(text: string, maxSwipes = 12): Promise<ChainablePromiseElement> {
    const el = await this.scrollToText(text, maxSwipes);
    await this.nudgeAboveBottomNav(el);
    return this.byText(text);
  }

  /**
   * Scroll a node clear of the floating bottom navigation bar.
   *
   * Scroll-into-view stops as soon as ANY part of the node is on screen, and a
   * floating nav sits OVER the scroll view. So a field can end up "scrolled into
   * view" at y=2220 while the nav starts at y=2138 — fully behind it. The OS
   * still reports displayed=true and the visibility wait passes, but the tap is
   * intercepted by the nav and click()/clearValue() fail with "element wasn't
   * found", an error pointing nowhere near the real cause.
   *
   * Measured on a Pixel 7 Pro (height 2340): nav top y=2138, field y=2220.
   *
   * No-ops when `bottomNavAnchor` is unset — better than guessing at the nav.
   */
  private async nudgeAboveBottomNav(el: ChainablePromiseElement): Promise<void> {
    try {
      const navTop = await this.bottomNavTopY();
      if (navTop === undefined) return;
      for (let i = 0; i < 3; i++) {
        if (!(await el.isExisting())) return;
        const { y } = await el.getLocation();
        const { height } = await el.getSize();
        if (y + height <= navTop) return; // fully clear of the nav
        await this.scrollDown();
      }
    } catch {
      // Nothing scrollable, or the node vanished — leave it to the caller's wait.
    }
  }

  /** Top edge of the floating bottom nav, or undefined when there is none. */
  private async bottomNavTopY(): Promise<number | undefined> {
    if (!this.bottomNavAnchor) return undefined;
    const tab = this.byA11y(this.bottomNavAnchor);
    if (!(await tab.isExisting())) return undefined;
    return (await tab.getLocation()).y;
  }

  /** Scroll down by one viewport, via the scroll container — never a swipe. */
  async scrollDown(): Promise<void> {
    await this.hideKeyboard();
    try {
      if (isAndroid) {
        await d().$('android=new UiScrollable(new UiSelector().scrollable(true)).scrollForward()');
      } else {
        // [iOS] UNVERIFIED.
        await d().execute('mobile: scroll', { direction: 'down' });
      }
    } catch {
      // Already at the end, or nothing scrollable here.
    }
  }

  /** Scroll back to the top. A nav tap does NOT reset scroll position. */
  async scrollToTop(): Promise<void> {
    await this.hideKeyboard();
    try {
      if (isAndroid) {
        await d().$('android=new UiScrollable(new UiSelector().scrollable(true)).flingToBeginning(20)');
      } else {
        // [iOS] UNVERIFIED.
        await d().execute('mobile: scroll', { direction: 'up' });
      }
    } catch {
      // Nothing scrollable on this screen — already at the top.
    }
  }

  // -------------------------------------------------------------------- read

  async textOf(
    el: ChainablePromiseElement,
    label: string,
    timeout: number = TIMEOUT.element,
  ): Promise<string> {
    await this.waitVisible(el, label, timeout);
    return (await el.getText()).trim();
  }

  /**
   * Every visible text node on screen. For whole-screen assertions.
   *
   * ALWAYS `waitForText()` on something first: reading the tree without a wait
   * can return in a few hundred ms against a screen that has not finished
   * rendering, failing a test while the app is perfectly correct.
   */
  async visibleTexts(): Promise<string[]> {
    const source = await d().getPageSource();
    // [Android] text="…"  [iOS] value="…" carries the rendered string.
    const attr = isAndroid ? 'text' : 'value';
    return [...source.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))]
      .map((m) => m[1])
      .filter((t) => t.length > 0);
  }

  /** Every accessibility name on screen. */
  async a11yNames(): Promise<string[]> {
    const source = await d().getPageSource();
    // [Android] content-desc="…"  [iOS] name="…"
    const attr = isAndroid ? 'content-desc' : 'name';
    return [...source.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))]
      .map((m) => m[1])
      .filter((t) => t.length > 0);
  }
}
