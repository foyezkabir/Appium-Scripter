/**
 * jest.config.ts — committed, so every clone runs with the same reporters.
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
  ],
};
