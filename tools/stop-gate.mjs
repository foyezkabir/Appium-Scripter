#!/usr/bin/env node
/**
 * stop-gate.mjs — Stop hook for /qa-appium-scripter.
 *
 * Runs when the agent tries to end its turn. If a goal is open in .goal.json
 * and gate.mjs says stages are outstanding, it emits {"decision":"block"} with
 * the gate's output as the reason — so the agent is handed the exact next
 * stage instead of being allowed to stop mid-module.
 *
 * Silent (exit 0, no output) when there is no open goal or the goal is done,
 * so it never interferes with ordinary work in this repo.
 *
 * Escape hatch: `node tools/gate.mjs abandon "<reason>"` closes the goal for
 * one of the skill's legitimate stops. That is the intended way out — the
 * block is not meant to trap a session that genuinely cannot continue.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const GOAL = '.goal.json';

// No goal file, or already closed → nothing to enforce.
if (!existsSync(GOAL)) process.exit(0);
try {
  const g = JSON.parse(readFileSync(GOAL, 'utf8'));
  if (g.closed) process.exit(0);
} catch {
  process.exit(0); // unreadable state must never wedge the session
}

let out = '';
let incomplete = false;
try {
  out = execFileSync('node', ['tools/gate.mjs', 'check'], { encoding: 'utf8' });
} catch (e) {
  incomplete = true;
  out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
}

if (!incomplete) process.exit(0);

const reason = [
  out.trimEnd(),
  '',
  'STOPPING NOW IS PROHIBITED. The declared goal is unfinished.',
  'Continue with the NEXT stage named above — in this module only.',
  'Do not start another module, refactor unrelated code, or explore',
  'anything outside this goal.',
  '',
  'If you are blocked by one of the legitimate stops (missing credential,',
  'unreachable device, ambiguous locator with no match, ambiguous goal,',
  'destructive action, or 3 fix attempts exhausted), close the goal',
  'explicitly and say why:',
  '    node tools/gate.mjs abandon "<reason>"',
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
