# Appium Scripter

A mobile UI test-automation suite and the agent skill that builds it.

**Stack:** Appium 3 · WebdriverIO v9 · Jest/ts-jest · TypeScript, driving a
**real USB-connected device**. No emulator by default, no Appium Cloud.

**Targets:** Android and iOS — native, React Native, Flutter, and the webview
half of hybrid apps.

This repo is unusual in that most of it is *instructions*, not code. The suite
itself is generated on first run. The durable artefacts are the skill that
knows how to build it, the templates it copies from, and the gate that refuses
to let a half-finished module be called done.

---

## What it is

`/qa-appium-scripter` is a Claude Code skill: a senior mobile-automation
engineer's method, written down in enough detail that it can be executed
rather than remembered.

Give it one goal — *"automate the Orders module from PHAR-522"* — and it runs
the whole job: inspects the live device, writes the four tiers, runs the specs
on hardware, diagnoses failures, audits coverage, and reports once at the end.
It does not stop between stages to ask whether it should continue.

| File | What it is |
|---|---|
| `.claude/skills/qa-appium-scripter/SKILL.md` | the method — ~2000 lines, the authority |
| `.claude/skills/qa-appium-scripter/templates/` | files the bootstrap copies verbatim |
| `CLAUDE.md` | the rules, always loaded, skill or no skill |
| `tools/gate.mjs` | verifies a module is actually finished |
| `tools/stop-gate.mjs` | Stop hook — blocks ending a turn mid-module |
| `.mcp.json` | Appium MCP server, for live device inspection |
| `.env.example` | every key the suite needs, documented inline |

---

## How it works — phase by phase

Every invocation runs these in order. Nothing is skipped because a task was
given up front.

### Phase −1 — Identify the target

Two answers decide almost every mechanic downstream: **which OS** and **which
UI framework**. The skill asks. If you do not know, it asks you to plug the
phone in and detects them:

- **OS** — `adb devices` for Android, `xcrun` / `idevice_id` for iOS.
- **Framework** — inspects the installed package for `libflutter.so`,
  `libhermes.so`, `index.android.bundle`, then reads the live view hierarchy.

**The hierarchy is the tiebreaker and it beats file evidence.** A Flutter app
shows a nearly-empty native tree — one `FlutterView` — because Flutter paints
its widgets instead of creating native views. If detection contradicts what
you said, the device wins and the skill says so.

The answers set the driver, the locator ladder, how `fill()` works, and how
the device is mirrored.

### Phase 0 — Bootstrap (idempotent; self-skips once done)

Seventeen steps, each safe to re-run.

**Toolchain check first** — before any npm command, because a missing
`JAVA_HOME` surfaces much later as an unrelated-looking session error:

```
node 20+ · OpenJDK 17 · appium · platform driver
[Android] adb · ANDROID_HOME · scrcpy
[iOS]     full Xcode · libimobiledevice · ios-deploy
```

> **iOS needs full Xcode, not the Command Line Tools.** With CLI tools alone,
> `xcrun simctl` and `xcrun xctrace` both fail with *"unable to find utility"* —
> iOS cannot even enumerate devices. Real devices additionally need a paid
> Apple Developer account and a signed WebDriverAgent.

**npm dependencies:**

```
webdriverio  @types/node  typescript@~5.9  ts-node
jest  @types/jest  ts-jest  jest-junit  dotenv  @faker-js/faker
eslint@9  typescript-eslint@8
```

TypeScript is pinned to `~5.9` deliberately. TypeScript 7 removed
`moduleResolution: node10` and `baseUrl`, and its replacement makes CommonJS
unable to `require` WebdriverIO at all — a cold unpinned install fails with
four errors that look like config mistakes and are actually a major-version
break. **Not** the `@wdio/*` testrunner: this suite drives `remote()` directly
from Jest, and adding the wdio runner gives you two competing test runners.

**Then it scaffolds:** `tsconfig.json`, `jest.config.ts` + `jest.setup.ts`,
the folder tree, `BasePage`, the support layer, `DataHelper`, `ErrorHelper`,
`.env` + `.env.example`, `.gitignore`, npm scripts, `tools/with-mirror.sh`,
`tools/preflight.sh`, the harness spec, the ESLint gate — and verifies the
whole thing compiles and lints clean.

### Phase 1 — Device preflight

`npm run preflight` branches on platform: device attached and authorised, full
Xcode present on iOS, Appium server answering. **Any red stops the run** — code
is never written against a device that cannot be reached.

### Phase 2 — Prove the harness, not the product

`npm run test:harness` asserts three things about the plumbing: a live session
exists, it is attached to the **right app**, and the app rendered **real
content**.

The middle one is not paranoia. With `noReset: true` Appium attaches to
whatever is in the foreground — one first probe landed on the Play Store.
Without that check a suite can go green against a different app entirely.

**A red harness means no result from this suite is trustworthy**, because you
cannot distinguish a product defect from a broken session.

### Phase 3 — The execution loop

One goal in, a finished module out. Ten stages, no check-ins between them:

```
1 crawl → 2 locators → 3 page → 4 data → 5 specs
→ 6 verify → 7 run → 8 fix → 9 audit → 10 report
```

**Stage 8 is bounded.** A failure is classified — stale locator, bad wait,
suite bug, or **real product defect** — and a given cause gets at most **three
attempts**. After that the symptom, the attempts and the hypothesis are
recorded and the loop moves on. A real defect stays red and is reported; it is
never "fixed" by weakening the test.

**Stage 9 is verified, not asserted.** `plan/<module>.md` must map every
control, state, validation message and AC to a `TC<NN>`, and the gate checks
that every TC in the specs appears there.

---

## The gate — why a module cannot be half-finished

```bash
node tools/gate.mjs start <module> "<goal>"   # first
node tools/gate.mjs check                     # after every stage
node tools/gate.mjs defect "TC03 — <what>"    # a real product defect
node tools/gate.mjs audited                   # after the coverage audit
node tools/gate.mjs done                      # refuses if incomplete
```

`check` inspects **real state on disk** — files present, `npm run verify`
clean, the junit report green, the plan covering every TC. It does not read
self-reports. While anything is outstanding it exits non-zero and names the
exact next stage.

**`tools/stop-gate.mjs` is a Stop hook.** When a turn tries to end with a goal
open and unfinished, it blocks and hands back the gate output. Stopping
mid-module is not something that can quietly happen.

It also **refuses a second `start` while one is open** — that refusal is the
anti-wandering mechanism.

The way out is `node tools/gate.mjs abandon "<reason>"`, for one of the six
legitimate stops: missing credential · unreachable device · ambiguous locator
with no confident match · genuinely ambiguous goal · destructive action ·
three attempts exhausted.

---

## Architecture — 4 tiers

| Tier | Path | Holds | Never |
|---|---|---|---|
| 1 Locators | `src/locators/<module>.locators.ts` | selector strings, expected copy | logic, actions, driver calls |
| 2 Pages | `src/pages/<module>.page.ts` | actions + `expect*` guarantees | inline selector strings |
| 3 Data | `src/data/` | fixtures, factories, boundaries | fixed literals for unique fields |
| 4 Specs | `tests/<module>.spec.ts` | test logic only | control flow, hooks, variables |

`src/support/` (driver, config, fixtures) and `src/api/` (preconditions,
teardown) are **not tiers** — infrastructure and companion. They contain no
assertions: a failing precondition is a broken setup, not a test result.

**One module, one file in each place**, mirroring each other exactly. Specs sit
**flat** under `tests/` with no numeric prefix — a prefix encodes a run order
that does not exist, and `tests/booking/01-login.spec.ts` claims login is part
of booking when it is not.

### Two helpers, scaffolded in every project

**`src/data/DataHelper.ts`** — realistic *and* unique test data, backed by
`@faker-js/faker`. Which source a value comes from depends on its job:

| The value is… | Source |
|---|---|
| the app's own vocabulary, asserted **against** | fixed literal |
| **input** the app stores, validates or shows back | `DataHelper` |
| a real account or phone the team owns | env var |

Generated rather than literal for the middle row because this suite may run
against production: a hardcoded `unknownEmail` can be registered by someone one
day, and a hardcoded `wrongPassword` can become a real one — either turns
"rejected" into a silent pass while the test reports green. Env var rather than
generated for the last row because a generated phone number belongs to a
**stranger**, and an OTP test would send them a real SMS.

**`src/support/ErrorHelper.ts`** — the only sanctioned try/catch outside
`BasePage`. `warnOnFailure` for a single teardown step; **`eachWarnOnFailure`
for a loop**, isolating every item and returning the ones that failed.

That second one is load-bearing. A teardown wrapping a whole loop in one
try/catch stops at the first failure and silently abandons the rest — measured,
`clearAllUpcoming()` hit one uncancellable appointment, skipped every
appointment after it, and reported success. The suite then failed in unrelated
tests against state it believed it had cleared.

### Locator priority ladder

Accessibility id is rung 1 everywhere — it is the one handle that survives a
redesign. Below that the ladder differs by platform.

**[Android]** a11y id → resource-id → exact text → textContains → class+instance
**[iOS]** a11y id → name/label → predicate string → class chain → class+index

**Absolute XPath is banned on both.** It breaks on any tree change, and on iOS
it is pathologically slow because every query forces a full tree serialisation.

Each locator records **which rung was used, what else the node carried, and a
date** — so a broken selector can be diagnosed without re-crawling the app.

---

## Rules it follows

Twelve zero-tolerance violations. Each exists because it already cost a
debugging session or produced a false finding.

| # | Rule |
|---|---|
| 1 | No loops in specs |
| 2 | No if/else in specs |
| 3 | No try/catch or silent `.catch()` in specs |
| 4 | No coordinate swipes, ever |
| 5 | Never assume a "displayed" element is tappable |
| 6 | `let`, never `const`, at spec top scope |
| 7 | No assertions in `support/` or `api/` |
| 8 | No API call standing in for a UI action |
| 9 | Never weaken an assertion to get green |
| 10 | No variables inside a test body |
| 11 | No setup/teardown hooks in a spec — they live in a fixture |
| 12 | An object argument stays on one line |

A few worth expanding, because the reason is not obvious:

**#4 — coordinate swipes.** A swipe starting low enough to scroll *begins on
the bottom nav*, and Android delivers it as a tab tap. The app navigates away
and a half-filled form is destroyed. This cost two forms before diagnosis.

**#5 — displayed ≠ tappable.** `scrollIntoView` stops as soon as *any part* of
a node is on screen, and a floating nav covers it. A field can sit at y=2220
with the nav starting at y=2138 — Android reports `displayed=true`, the
visibility wait passes, and `click()` fails with "element wasn't found",
pointing nowhere near the cause.

**#8 — API standing in for UI.** An API submit bypasses the app's own handlers.
Doing so produced **three false findings** in one audit, including a "photo
never uploaded" defect that evaporated once the submit was done on-device.

### Always, everywhere

**Locators re-query, never cache.** Page objects expose getters — an Appium
element handle goes stale the instant the view re-renders.

**Explicit waits only.** No implicit wait is configured and none may be added;
mixing the two produces compound timeouts. Never `driver.pause()` or
`setTimeout` as a wait.

**Never fabricate.** Not a selector, not an expected string, not a device
measurement, not a credential. Author every locator from the live hierarchy or
the app's source repo, and cite it. *A guessed selector is a defect you
introduced.*

### Flake policy — no auto-retry

`jest.retryTimes` is banned and lint-enforced. Retry converts *"this fails one
in four runs"* into a green tick, and that one-in-four was telling you
something true.

**A test that passes on rerun with no code change is a defect in the test** —
a leaked sheet, an assertion before the first frame, an expired token, a
hidden assumption about device speed. Fix the cause.

---

## Quality gate

`npm run verify` = `tsc --noEmit` + `eslint .`

Nine rule groups are mechanically enforced — the typechecker sees none of them,
since `const` at spec top scope and a silent `.catch()` compile perfectly:

| Enforced | Judgement only |
|---|---|
| #1 loops · #2 if/else · #3 try/catch · #4 swipes | #5 displayed≠tappable |
| #6 `const` top scope · #7 assertions in support/api | #8 API-for-UI |
| explicit waits · Tier-1 strings-only · no retryTimes | #9 weakened assertion |

**The gate is a floor, never a substitute for the review checklist.**

Two traps if you edit `eslint.config.mjs`:

- **The parser block is required.** The config deliberately skips
  `tseslint.configs.recommended` (its `no-explicit-any` fires constantly on
  correct suite code, and a gate that shouts on clean files gets switched off).
  Without an explicit parser, ESLint reads `.ts` as JavaScript and catches
  **zero** violations while still looking configured.
- **Flat config replaces an array rule, it does not merge.** Two blocks both
  matching a file and both setting `no-restricted-syntax` → the later wins
  silently. This once dropped a known-bad fixture from 5 errors to 0. After any
  edit, re-run against a bad fixture and confirm the count did not fall.

---

## Running it

```bash
npm run preflight      # device attached, authorised, server answering
npm run appium         # Appium server — its own terminal, must stay up
npm run test:harness   # prove the plumbing first
npm test               # full suite, with a read-only device mirror
npm run test:nomirror  # headless / CI
npm run mirror         # hands-on device control (NEVER during a run)
npm run verify         # typecheck + lint
```

### The mirror

Every test run mirrors the device **read-only** (`scrcpy --no-control`). You
are driving a phone you cannot see; watching is how you catch the stray tap
that destroyed a form.

Read-only is not negotiable during a run: a human click lands on the same
screen Appium is driving and the two race — your tap fires mid-`fillForm`, the
form loses focus, and the spec goes red on a defect that does not exist.
`npm run mirror` is for hands-on work between runs.

**[Android] only.** scrcpy speaks `adb` and cannot mirror an iPhone; on iOS the
run proceeds unmirrored and you start QuickTime by hand.

### Reports

Each run writes `appium-reports/junit.xml` (machine-readable; the gate parses
it) and `appium-reports/report.html` — one **self-contained** file where every
failure shows its device screenshot and the view hierarchy at the moment it
failed, both base64-embedded. Copy that single file anywhere and it still
renders, so it can go straight onto a ticket.

It is produced by `tools/html-reporter.mjs`, this project's own Jest reporter,
**committed** — so every clone generates the identical report with no install
step and no version drift. To change the report, edit that file.

> `jest-html-reporters` was evaluated and rejected: no template override, and
> its `inlineSource` option inlines JS/CSS but leaves screenshots as external
> files — a 1.5 MB `report.html` that still loses its images when moved. Ours
> is ~7 KB and genuinely standalone.

### Failure capture

`jest.setup.ts` wraps the global `it` — not an `afterEach`, which would run
after teardown has already navigated away — and writes a screenshot plus the
page source to `appium-reports/failures/` at the moment of failure. It always
re-throws; a capture hook that swallowed the error would turn every failure
green.

---

## Setup

1. `cp .env.example .env` and fill every value. Every key is documented inline;
   **quote every value** — dotenv treats an unquoted `#` as a comment and
   silently truncates. `.env` is gitignored and must stay that way.
2. `.mcp.json` configures the Appium MCP server for device inspection. It needs
   `appium-mcp` on `PATH`; the `env` paths are machine-specific.
3. Start the Appium server in its own terminal: `npm run appium`.

> **One automation client per device.** Android grants the UiAutomation
> connection to exactly one client; iOS lets WebDriverAgent hold its port.
> Never run this suite alongside another UI-automation tool on the same device.

> **`API_BASE_URL` must match the environment the installed app points at.**
> Seeding dev while the app reads prod creates data the app can never display,
> and every resulting failure looks like a product defect. A minified bundle
> often contains every environment's hostname, so grepping the binary does not
> settle it — check the device's live traffic.

---

## Teardown

Walk the ladder **before** writing a fixture, not after:

```
hard delete → soft delete → UI delete → unique-data namespacing
→ backend reset → log the leak
```

If every rung fails, each create is permanent — make the fixture reuse an
existing seeded row instead. Skipping this check once grew a tenant to 30
branches.

Namespace every fixture `QA-AUTO` (made through the UI) or `QA-SEED` (seeded
via API), so anything teardown misses stays greppable.

**Teardown must never fail a green test**, and **never fake a teardown you do
not have** — a `cleanup()` that silently does nothing is worse than none,
because the next reader assumes the suite is self-cleaning.

---

## Reporting

Report what happened, not what was hoped. If a test is red, say so with the
output. If a state could not be reached, say which and why.

**An honest "I could not reach the error state, so TC07 is unwritten" is worth
more than a test that asserts something easier and reports green.**
