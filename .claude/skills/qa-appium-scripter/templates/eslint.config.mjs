import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'crawl/**', 'appium-reports/**', 'tools/**'] },

  // Parser ONLY — no rule presets. This block is REQUIRED: we deliberately
  // skip tseslint.configs.recommended (see the note below), and without a
  // parser ESLint reads .ts as JavaScript and dies on the first type
  // annotation with "Parsing error: Unexpected token :" — while silently
  // catching none of the violations. Verified: removing it drops the gate to
  // zero rules fired.
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
  },

  // ── TIER 4: specs are DETERMINISTIC ────────────────────────────────────
  {
    files: ['tests/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'ForStatement',   message: 'Violation #1: no loops in specs. Move the loop into a page object, or split into separate tests.' },
        { selector: 'ForOfStatement', message: 'Violation #1: no loops in specs. Move the loop into a page object, or split into separate tests.' },
        { selector: 'ForInStatement', message: 'Violation #1: no loops in specs.' },
        { selector: 'WhileStatement', message: 'Violation #1: no loops in specs.' },
        { selector: 'IfStatement',    message: 'Violation #2: no if/else in specs. Seed the precondition so exactly one path is correct.' },
        { selector: 'ConditionalExpression', message: 'Violation #2: no conditionals in specs.' },
        { selector: 'TryStatement',   message: 'Violation #3: no try/catch in specs. Let errors surface.' },
        { selector: "CallExpression[callee.property.name='catch']", message: 'Violation #3: no silent .catch() in specs — the test can never fail.' },
        // [declare!=true] exempts `declare const`, which is a type-only
        // ambient and never re-evaluated. Without it the rule false-positives.
        { selector: "Program > VariableDeclaration[kind='const'][declare!=true]", message: 'Violation #6: use let, never const, at spec top scope — the script is evaluated more than once per run.' },
        { selector: "CallExpression[callee.property.name='retryTimes']", message: 'Flake policy: jest.retryTimes is banned. A test that passes on rerun is a defect in the test — fix the cause.' },
        { selector: "CallExpression[callee.property.name='performActions']", message: 'Violation #4: no coordinate swipes. Drive the scroll container: scrollToText / scrollFieldIntoReach.' },
        { selector: "CallExpression[callee.property.name='touchAction']", message: 'Violation #4: no coordinate swipes. Drive the scroll container instead.' },
      ],
    },
  },

  // ── Violation #4: no coordinate swipes in page objects either ─────────
  {
    files: ['src/pages/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name='performActions']", message: 'Violation #4: no coordinate swipes. A swipe starting low enough to scroll begins ON the bottom nav and is delivered as a TAB TAP — it destroys a half-filled form.' },
        { selector: "CallExpression[callee.property.name='touchAction']", message: 'Violation #4: no coordinate swipes. Drive the scroll container instead.' },
      ],
    },
  },

  // ── Explicit waits only, suite-wide ────────────────────────────────────
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'driver', property: 'pause', message: 'Explicit waits only: waitVisible / waitGone / waitForText, or driver.waitUntil with a timeoutMsg naming what failed.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'setTimeout', message: 'Never sleep as a wait. Wait on a condition.' },
      ],
    },
  },

  // ── Violation #7: support/ and api/ build state, they never assert ─────
  {
    files: ['src/support/**/*.ts', 'src/api/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'expect', message: 'Violation #7: no assertions in support/ or api/. A failing precondition is a broken setup, not a test result.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='expect']", message: 'Violation #7: no assertions in support/ or api/. A failing precondition is a broken setup, not a test result.' },
      ],
    },
  },

  // ── TIER 1: locator files hold STRINGS ONLY ────────────────────────────
  {
    files: ['src/locators/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: 'FunctionDeclaration',     message: 'Locator files hold strings only — no logic, no actions, no assertions.' },
        { selector: 'ArrowFunctionExpression', message: 'Locator files hold strings only — no parameterised error helpers.' },
        { selector: "CallExpression[callee.name='d']", message: 'Locator files must never touch the driver.' },
      ],
    },
  },
);
