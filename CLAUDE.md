# Appium Scripter — project rules

Mobile UI automation: **Appium 3 + WebdriverIO v9 + Jest/ts-jest + TypeScript**,
driving a **real USB-connected device**. Android and iOS; native, React Native,
Flutter and hybrid.

**The full method lives in [`.claude/skills/qa-appium-scripter/SKILL.md`](.claude/skills/qa-appium-scripter/SKILL.md).**
Invoke it with `/qa-appium-scripter <task>`. This file is the short list of
rules that hold whether or not the skill was invoked. Where the two overlap,
the skill is the authority and carries the reasoning; nothing here contradicts
it.

---

## Before any code

**Resolve the target first — OS and UI framework.** Ask the user. If they do
not know, ask them to connect the device by USB and detect it. Never assume:
an Android assumption applied to an iOS app produces selectors that cannot
match anything, and the failure reads as a broken app rather than a broken
suite.

Then, every invocation, in order: bootstrap → device preflight → prove the
harness (`npm run test:harness`). **A red harness means no result from this
suite is trustworthy** — you cannot tell a product defect from a broken
session. Fix it before writing anything.

---

## Loop maintenance — MANDATORY, NOT OPTIONAL

**Every module task runs under the gate. No exceptions.**

```bash
node tools/gate.mjs start <module> "<goal>"   # FIRST, before any work
node tools/gate.mjs check                     # after EVERY stage
node tools/gate.mjs defect "TC03 — <what>"    # a real product defect
node tools/gate.mjs audited                   # after the coverage audit
node tools/gate.mjs done                      # LAST — refuses if incomplete
```

`gate.mjs check` inspects real state on disk — files present, `npm run verify`
clean, the junit report green — and **exits non-zero naming the exact next
stage** while anything is outstanding. It does not read self-reports.

**A Stop hook enforces this.** `tools/stop-gate.mjs` runs when a turn ends; if
a goal is open and unfinished it **blocks the stop** and returns the gate
output. Ending a turn mid-module is therefore not a thing that can quietly
happen. Do not try to route around it — close the goal properly instead.

**One goal in, a finished module out.** crawl → locators → page → data →
specs → verify → run → fix → audit → report, once, at the end. Do not check
in between stages. Do not ask "shall I continue?". Ask every question you need
up front, in one round.

### Staying on the goal — STRONGLY PROHIBITED to wander

While a goal is open you work on **that module and nothing else**. Prohibited
unless the user asks:

- Automating a module you were not asked about — the gate refuses a second
  `start` while one is open, and that refusal is the point.
- Refactoring, renaming or "tidying" code that already passes.
- Rewriting `BasePage`, support or config beyond the minimum the goal needs.
- Dependency bumps, lint-config changes, reformatting.
- Chasing an interesting bug in another module. **Write it down, report it at
  the end, do not detour.**

**The test: does this line move the named goal forward?** If no, it is a
distraction. A finished module plus three noted observations is success; a
half-finished module because something else looked interesting is failure.

**Bounded fixing.** Re-run a failing test at most 3 times for the same cause,
then record symptom + attempts + hypothesis and move to the next failure. **A
real product defect stays red and is reported** (`gate.mjs defect`) — never
weaken a test to get green.

**The only legitimate stops:** missing credential · unreachable device ·
ambiguous locator with no confident match · genuinely ambiguous goal ·
destructive action · three attempts exhausted. Any of these →
`node tools/gate.mjs abandon "<reason>"`, which closes the goal on the record.
Everything else you resolve yourself and keep going.

---

## Architecture — 4 tiers, and nothing else

| Tier | Path | Holds | Never |
|---|---|---|---|
| 1 Locators | `src/locators/<module>.locators.ts` | selector strings, expected copy | logic, actions, driver calls |
| 2 Pages | `src/pages/<module>.page.ts` | actions + `expect*` guarantees | inline selector strings |
| 3 Data | `src/data/` | fixtures, factories, boundaries | fixed literals for unique fields |
| 4 Specs | `tests/<module>.spec.ts` | test logic only | any control flow, hooks, variables |

**One module, one file in each place — and they mirror each other exactly:**

```
src/locators/<module>.locators.ts     src/support/<module>.fixture.ts
src/pages/<module>.page.ts            tests/<module>.spec.ts
plan/<module>.md                      baselines/<module>.baseline.json
findings/<module>.txt
```

**Specs sit FLAT under `tests/`.** No per-module folder, no numeric prefix.
`tests/booking/01-login.spec.ts` claims login is part of booking; it is not. A
prefix encodes a run order that does not exist and goes stale the moment a file
is added or split.

**Never one locator file for the whole app.** It reached 50 exports and 348
lines here — login, search, booking, appointments, prescriptions and profile
under a filename naming one of them — so every page object imported from a file
named after a different module.

`src/support/` (driver, config, fixtures) and `src/api/` (preconditions,
teardown) are **not tiers** — infrastructure and companion.

`plan/` · `findings/` · `baselines/` hold one file per module: the scope
decisions, the defects in a fixed field format, and the crawl. **Raw device
dumps never enter the repo** — capture to a scratch directory, distil into the
baseline, discard the rest. They contain **no assertions**: a
failing precondition is a broken setup, not a test result.

## Helpers — scaffolded in every project

Two files, each present because its absence has already caused a defect.

### `src/data/DataHelper.ts` — realistic + unique test data (`@faker-js/faker`)

Which source a value comes from is decided by what the value's JOB is:

| The value is… | Source | Example |
|---|---|---|
| the app's own vocabulary, asserted **against** | **fixed literal** | blood groups, column headings, expected copy, a deliberately malformed string whose shape IS the test |
| **input** the app stores, validates or shows back | **`DataHelper`** | a name typed into a form, an email that must match no account, a password that must never authenticate |
| a real account or a real phone the team owns | **env var** | the login credentials, an OTP test number |

**Why generated, not literal, for the middle row:** this suite runs against
PRODUCTION. A hardcoded `unknownEmail` can be registered by someone one day, and
a hardcoded `wrongPassword` can become a real one — either turns "rejected" into
a silent pass, and the test goes on reporting green while asserting nothing.

**Why env var, not generated, for the last row:** a `DataHelper.phone()` value is
a valid Bangladeshi number belonging to a **stranger**. An OTP test would send
them a real SMS, and bill for it.

### `src/support/ErrorHelper.ts` — the only sanctioned try/catch outside `BasePage`

`warnOnFailure` for a single teardown step. **`eachWarnOnFailure` for a loop** —
it isolates every item and returns the ones that failed.

That second one is load-bearing. A teardown that wraps a whole loop in one
try/catch stops at the first failure and silently abandons the rest: measured,
`clearAllUpcoming()` hit one uncancellable appointment, skipped every appointment
after it, and reported success. The suite then failed in unrelated tests against
state it believed it had cleared.

Teardown may swallow; a spec may not (zero tolerance #3).

---

## Zero tolerance

These are not style preferences. Each one is here because it already cost a
debugging session or produced a false finding.

1. **No loops in specs.** Put the loop in a page object, or write separate
   tests — with `bail: 0` you get one verdict per case instead of one for all.
2. **No if/else in specs.** A branch means the test asserts two different
   things depending on state it did not control. Seed the precondition.
3. **No try/catch or silent `.catch()` in specs.** A swallowed error is a test
   that can never fail. Legitimate only in teardown and in `BasePage` helpers
   where a throw genuinely means "not applicable".
4. **No coordinate swipes, ever.** A swipe starting low enough to scroll begins
   on the bottom nav and is delivered as a tab tap — it silently navigates away
   and destroys a half-filled form. Drive the scroll container instead.
5. **Never assume a "displayed" element is tappable.** Scroll-into-view stops
   as soon as any part of a node is on screen, and a floating nav covers it.
   Use `scrollFieldIntoReach()` before tapping or typing.
6. **`let`, never `const`, at spec top scope.** The same script is evaluated
   more than once per run.
7. **No assertions in `support/` or `api/`.**
8. **No API call standing in for a UI action.** The subject under test is
   always UI-driven; `src/api/` seeds and cleans up, nothing more. Substituting
   an API submit produced three false findings in one audit.
9. **Never weaken an assertion to get green.** A red test is a real defect or a
   stale locator. Fix the locator or file the defect. And prove a new assertion
   *can* fail — point it at an impossible string first.
10. **No variables inside a test body.** A value computed in a spec is logic: it
    reads state, derives something, and hands it to an assertion. Move the
    computation into a page object or a seeder that returns the finished result.
    A spec is a list of `await` calls and nothing else. The lint gate enforces
    this; the harness spec is the single exemption, because proving the plumbing
    means reading the raw hierarchy with no page object.
11. **No setup or teardown hooks in a spec.** `beforeAll` / `afterAll` /
    `beforeEach` / `afterEach` belong in a fixture (`src/support/*.fixture.ts`)
    that registers them and returns the live objects. A spec declares no page
    objects and no test data — it imports one fixture and one kit.
12. **An object argument stays on ONE line.** Never one property per line — a
    spec should read as a list of calls, not a list of fields. If the line is
    genuinely too long, the argument itself is wrong: pass the whole object
    (`doctor: fx.doctor`) instead of picking it apart
    (`doctorName: …, speciality: …`), and let the page object read what it needs.

    ```ts
    // BANNED — five lines for one call
    await booking.bookThroughApp({
      doctorName: doctor.fullName,
      speciality: doctor.primarySpeciality,
      type: appointmentTypes.pickup,
      chamber: chamber,
    });

    // CORRECT
    await booking.bookThroughApp({ doctor, type: appointmentTypes.pickup, chamber });
    ```

**No `: Promise<void>` in a page object.** A void method declares no return
type; TypeScript infers it. Declare one only where a real value comes back
(`Promise<boolean>`, `Promise<string[]>`).

**Locators re-query, never cache.** Page objects expose getters; an Appium
element handle goes stale the instant the view re-renders.

**Explicit waits only.** No implicit wait is configured anywhere and none may
be added — mixing the two produces compound timeouts. Never `driver.pause()` or
`setTimeout` as a wait; wait on a condition.

**Never fabricate.** Not a selector, not an expected string, not a device
measurement, not a credential, not an app id. Author every locator from the
live hierarchy or the app's source repo, and cite the source. If you did not
observe it, say so. A guessed selector is a defect you introduced.

---

## Platform

Everything platform-specific is tagged in the skill as `[Android]`, `[iOS]`,
`[RN]`, `[Flutter]` or `[Hybrid]`. Two rules hold here:

- **Every per-OS branch lives in `BasePage` or `driver.ts`** — nowhere else.
  Specs, page objects and locator files stay platform-neutral, which is what
  lets one suite shape serve every target.
- **Never call an Android API on an iOS target** (`getCurrentPackage`,
  `pressBack`, `KEYCODE_*`) — these throw rather than degrade.

**Flutter paints widgets; it does not create native views.** An empty native
dump is expected, not evidence of an untestable app. See the skill's Flutter
section before concluding anything.

---

## Config invariants

| Setting | Value | Why |
|---|---|---|
| `maxWorkers` | `1` | one physical device; two workers racing it fail like app bugs |
| `bail` | `0` | one run must surface every failure |
| `testTimeout` | `240_000` | every command is an HTTP round trip plus a driver bridge call |
| implicit wait | never set | compound timeouts |

`--experimental-vm-modules` is required on every jest script (WebdriverIO v9's
CJS build uses dynamic `import()` internally).

**Environment and tenant values are required, never defaulted.** An API base
URL or org id behind `??` turns a missing variable into a run against the wrong
target that still reports green — throw with the variable's name instead.

**`tsconfig.json` is `module: CommonJS` + `moduleResolution: node10`, and
`.vscode/settings.json` pins the editor to the project's TypeScript
(`typescript.tsdk`).** VS Code's bundled TypeScript 6 flags `node10` as
deprecated and offers fixes that break the pinned 5.9 build. Never accept an
editor quick-fix on `tsconfig.json`.

**Quote every `.env` value** — all of them, not just the risky ones. dotenv
treats an unquoted `#` as an inline comment and silently truncates the value;
quoting everything makes that impossible rather than depending on someone
noticing which values contain a `#`.

**`API_BASE_URL` must match the environment the INSTALLED APP points at.**
Seeding dev while the app reads prod creates data the app can never display,
and every resulting assertion failure looks like a product defect. A minified
bundle often contains EVERY environment's hostname, so grepping the APK/IPA does
not settle it — check the device's DNS lookups or live traffic, and confirm the
test account authenticates on that host.

**Never depend on data someone else owns.** A backend can be wiped. If the
suite needs records to exist (users, catalogue items, schedules), global setup
provisions them — idempotent and read-first, so an already-provisioned tenant
costs zero writes — and specs resolve a ROLE through a fixture, never a literal
name. Global setup also proves the credentials, so a bad login throws once,
naming the cause, instead of failing every spec at the login screen.

---

## Commands

```bash
npm run preflight      # device attached, authorised, server answering
npm run test:harness   # prove the plumbing before trusting any result
npm test               # full suite, with a read-only device mirror
npm run test:nomirror  # headless / CI
npm run mirror         # hands-on device control (NEVER during a run)
npm run verify         # typecheck + lint
```

### Reports

Every run writes two things to `appium-reports/`:

| File | For | Rule |
|---|---|---|
| `junit.xml` | `tools/gate.mjs` | **never remove or rename** — the gate parses it to decide whether stage 7 passed |
| `report.html` | humans | self-contained; failure screenshots embedded as base64 |
| `steps.jsonl` | `report.html` | per-step timings, appended by `StepRecorder` during the run |

`report.html` comes from **`tools/html-reporter.mjs`** — this project's own
reporter, committed so every clone produces the identical report with no
install step. Customise the report by editing that file.

Every test row opens to **Steps → What went wrong → Full error & stack trace →
Media**, each colour-coded so they are distinguishable at a glance.

**Per-step timings come from `src/support/StepRecorder.ts`, not from Jest.**
Jest hands a reporter only a total duration per test, so `BasePage` actions
wrap themselves in `StepRecorder.step()` and the timings are appended to
`appium-reports/steps.jsonl`. It always re-throws, and a recording failure is
swallowed — instrumentation must never fail a test.

**The plain-language diagnosis never replaces the raw error.** It classifies
known failure shapes only; an unrecognised error gets no explanation rather
than a wrong one, and the full trace is always one click away.

**`slug()` in `tools/html-reporter.mjs` must stay identical to `slug()` in
`jest.setup.ts`.** The setup file names artefacts `<stamp>__<slug>.png`; the
reporter pairs them to tests by that slug. Change one and screenshots silently
stop appearing — the report still builds, just without images. The same applies
to the test name `StepRecorder` records: it pairs steps by `fullName`, so a
change there silently empties the Steps section.

**A reporting failure must never fail a run.** The reporter wraps its write and
warns; the tests already ran and `junit.xml` is what the gate reads.

**The mirror is read-only during a run.** A human click races Appium for the
same screen and reddens a passing test. `npm run mirror` is for hands-on work
between runs.

**`--stay-awake` and `--no-control` cannot be combined.** scrcpy refuses to
start — *"Cannot request to stay awake if control is disabled"*. So the run
mirror uses `--no-control` alone, and only `npm run mirror` (which allows
control) keeps `--stay-awake`. Keeping the screen on during a run is the
device's display setting, not the mirror's job.

**The mirror's stderr goes to `appium-reports/scrcpy.log`, never `/dev/null`.**
With both flags set and output discarded, the mirror failed silently on every
single run: tests passed, no window ever appeared, and nothing said why. A
support tool that can fail invisibly is worse than one that is absent.

---

## Setup

1. `cp .env.example .env` and fill every value — every key is documented in
   place. `.env` is gitignored and must stay that way.
2. Appium MCP is configured in `.mcp.json` (device inspection). It needs
   `appium-mcp` on `PATH`; paths in `env` are machine-specific — adjust them if
   yours differ.
3. Run the Appium server in its own terminal: `npm run appium`.

**One automation client per device.** Android grants the UiAutomation
connection to exactly one client; iOS lets WebDriverAgent hold its port. Never
run this suite alongside another UI-automation tool on the same device.

---

## Teardown

Walk the ladder **before** writing a fixture, not after: hard delete → soft
delete → UI delete → unique-data namespacing → backend reset → log the leak. If
every rung fails, each create is permanent — make the fixture reuse an existing
seeded row instead.

Namespace every fixture `QA-AUTO` (made through the UI) or `QA-SEED` (seeded
via API) so anything teardown misses stays greppable.

**Teardown must never fail a green test**, and **never fake a teardown you do
not have** — a `cleanup()` that silently does nothing is worse than none. The
swallow-and-warn belongs in `src/api/`, **never in a spec**: a silent `.catch()`
inside a spec is zero-tolerance violation #3, and the lint gate will reject it.

If the product's state machine makes a create permanent (a record that can no
longer be deleted or cancelled once it reaches a final state), name it in the
plan's "known leaks" section. Never write a `cleanup()` that pretends to remove
it.

---

## Reporting

Report what happened, not what was hoped. If a test is red, say so with the
output. If you could not reach a state, say which one and why. **An honest "I
could not reach the error state, so TC07 is unwritten" is worth more than a
test that asserts something easier and reports green.**
