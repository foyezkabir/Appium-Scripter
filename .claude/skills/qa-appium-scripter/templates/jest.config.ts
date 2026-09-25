/**
 * jest.config.ts — committed, so every clone runs with the same reporters.
 * Customise the HTML report by editing tools/html-reporter.mjs; the change
 * travels with the repo and nobody has to install or configure anything.
 */

export default {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // ── Invariants. See the skill's "Jest configuration invariants". ────────
  maxWorkers: 1,        // one physical device
  bail: 0,              // one run must surface EVERY failure
  testTimeout: 240_000, // every command is an HTTP round trip + a bridge call
  // NO jest.retryTimes — see the flake policy. A test that passes on rerun
  // with no code change is a defect in the test.

  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  reporters: [
    'default',

    // Machine-readable. tools/gate.mjs PARSES THIS to decide whether stage 7
    // passed — never remove it, and never change outputDirectory/outputName
    // without updating the gate.
    ['jest-junit', {
      outputDirectory: 'appium-reports',
      outputName: 'junit.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
    }],

    // Human-readable, this project's own — tools/html-reporter.mjs. Produces
    // ONE self-contained report.html with failure screenshots and the view
    // hierarchy embedded as base64, so it can be attached to a ticket and
    // still render. Edit that file to change the report.
    ['<rootDir>/tools/html-reporter.mjs', {
      pageTitle: '<App name> — Appium Automation Report',
      filename: 'report.html',
    }],
  ],
};
