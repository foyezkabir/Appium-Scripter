#!/usr/bin/env node
/**
 * gate.mjs — loop gate for /qa-appium-scripter.
 *
 * Answers one question: for the declared goal, is the module ACTUALLY
 * finished? It inspects real state on disk (files, lint, last run results),
 * never a self-report, and exits non-zero naming the exact next stage while
 * anything is outstanding.
 *
 *   node tools/gate.mjs start <module>   declare the goal, open the loop
 *   node tools/gate.mjs check            what stage am I on? (exit 1 if unfinished)
 *   node tools/gate.mjs done             close the loop — REFUSES if incomplete
 *   node tools/gate.mjs status           human-readable, always exit 0
 *   node tools/gate.mjs abandon "<why>"  close with a recorded reason (a stop
 *                                        from the skill's legitimate-stop list)
 *
 * State lives in .goal.json (gitignored). No .goal.json = no active loop.
 *
 * LIMITS — read these before trusting it:
 *  - A script cannot force an agent to keep working. It makes an unfinished
 *    stop mechanically detectable and loud; the Stop hook in
 *    .claude/settings.json is what actually blocks the stop.
 *  - It checks that artefacts EXIST and that the recorded run was green. It
 *    cannot judge whether the tests are any good. Stage 9 (coverage audit) is
 *    still a judgement call that a human or the agent must make honestly.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const GOAL_FILE = '.goal.json';
const [, , cmd, ...rest] = process.argv;

const read = () => (existsSync(GOAL_FILE) ? JSON.parse(readFileSync(GOAL_FILE, 'utf8')) : null);
const write = (g) => writeFileSync(GOAL_FILE, JSON.stringify(g, null, 2) + '\n');
const exists = (p) => existsSync(p);

/** Did the module's specs actually run green? Reads the jest-junit report. */
function lastRun(module) {
  const dir = 'appium-reports';
  if (!exists(dir)) return { ran: false, reason: 'no appium-reports/ — tests never ran' };
  const xmls = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  if (!xmls.length) return { ran: false, reason: 'no junit xml in appium-reports/' };
  const newest = xmls
    .map((f) => ({ f, t: statMtime(join(dir, f)) }))
    .sort((a, b) => b.t - a.t)[0].f;
  const xml = readFileSync(join(dir, newest), 'utf8');
  const tests = +(xml.match(/tests="(\d+)"/)?.[1] ?? 0);
  const failures = +(xml.match(/failures="(\d+)"/)?.[1] ?? 0);
  const errors = +(xml.match(/errors="(\d+)"/)?.[1] ?? 0);
  const mentions = xml.includes(module);
  return { ran: true, file: newest, tests, failures, errors, mentions };
}
function statMtime(p) {
  try { return execSync(`stat -f %m "${p}"`, { encoding: 'utf8' }).trim() * 1; }
  catch { return 0; }
}

/** Returns the ordered stage list with a pass/fail verdict for each. */
function evaluate(goal) {
  const m = goal.module;
  const stages = [];
  const add = (n, name, ok, detail, next) => stages.push({ n, name, ok, detail, next });

  add(1, 'crawl', exists(`baselines/${m}.baseline.json`),
      `baselines/${m}.baseline.json`,
      `Crawl the ${m} module into baselines/${m}.baseline.json — every screen and hidden surface.`);

  add(2, 'locators', exists(`src/locators/${m}.locators.ts`),
      `src/locators/${m}.locators.ts`,
      `Write src/locators/${m}.locators.ts — strings only, each cited to the crawl or the app repo.`);

  add(3, 'page', exists(`src/pages/${m}.page.ts`),
      `src/pages/${m}.page.ts`,
      `Write src/pages/${m}.page.ts — extends BasePage, getters not cached handles, expect* guarantees.`);

  // Data and hooks: the fixture owns the hooks and hands the spec its data
  // (CLAUDE.md zero tolerance #11); shared data lives in src/data/.
  add(4, 'data', exists(`src/support/${m}.fixture.ts`),
      `src/support/${m}.fixture.ts`,
      `Write src/support/${m}.fixture.ts (hooks + live objects) and its data in src/data/ — realistic, unique, namespaced. Walk the teardown ladder FIRST.`);

  // Specs sit FLAT under tests/ — one file per module, no folder, no prefix.
  const specDir = 'tests';
  const specFile = `${m}.spec.ts`;
  const specs = exists(join(specDir, specFile)) ? [specFile] : [];
  add(5, 'specs', specs.length > 0, specs.length ? `tests/${specFile}` : `missing tests/${specFile}`,
      `Write tests/${specFile} — one TC-NN per behaviour. No loops, no if/else, no try/catch.`);

  // Stage 6 — the gate must be re-proved, not remembered.
  let verifyOk = false, verifyDetail = 'not run';
  if (specs.length) {
    try {
      execSync('npm run verify', { stdio: 'pipe' });
      verifyOk = true; verifyDetail = 'typecheck + lint clean';
    } catch (e) {
      verifyDetail = (e.stdout?.toString() || e.message).split('\n').slice(-12).join('\n');
    }
  }
  add(6, 'verify', verifyOk, verifyDetail, `Run npm run verify and fix every typecheck + lint error.`);

  const run = specs.length ? lastRun(m) : { ran: false, reason: 'no specs yet' };
  const runOk = run.ran && run.failures === 0 && run.errors === 0;
  add(7, 'run', runOk,
      run.ran ? `${run.file}: ${run.tests} tests, ${run.failures} failed, ${run.errors} errors` : run.reason,
      `Run: npm run test:nomirror -- tests/${m}.spec.ts`);

  // Stage 8 — failures must be resolved or explicitly recorded as product defects.
  const unresolved = run.ran ? run.failures + run.errors : 0;
  const recorded = (goal.defects ?? []).length;
  add(8, 'fix', unresolved === 0 || recorded >= unresolved,
      unresolved ? `${unresolved} failing, ${recorded} recorded as product defects` : 'nothing failing',
      `Diagnose each failure. Fix suite issues; record real product defects with: node tools/gate.mjs defect "TC01 — <what>". Max 3 attempts per cause.`);

  // Stage 9 — verified against disk, not taken on trust. A plan file must
  // exist and every TC in the specs must appear in it, so "audited" cannot be
  // asserted over a plan that does not mention half the tests.
  const planPath = `plan/${m}.md`;
  let auditOk = false, auditDetail;
  if (!exists(planPath)) {
    auditDetail = `missing ${planPath}`;
  } else {
    const plan = readFileSync(planPath, 'utf8');
    const specTCs = new Set();
    for (const f of specs) {
      const src = readFileSync(join(specDir, f), 'utf8');
      for (const mm of src.matchAll(/\bTC-?(\d+)\b/g)) specTCs.add(mm[1]);
    }
    // A plan names a case as "TC-06" / "TC06" in prose or as "| 06 |" in its table.
    const missing = [...specTCs].filter((n) => !new RegExp(`\\bTC-?${n}\\b|^\\|\\s*${n}\\s*\\|`, 'm').test(plan)).map((n) => `TC-${n}`);
    if (!specTCs.size) auditDetail = 'no TC ids found in specs';
    else if (missing.length) auditDetail = `${planPath} does not cover: ${missing.join(', ')}`;
    else if (goal.audited !== true) auditDetail = `plan covers all ${specTCs.size} TCs — now confirm: node tools/gate.mjs audited`;
    else { auditOk = true; auditDetail = `${planPath}, all ${specTCs.size} TCs mapped`; }
  }
  add(9, 'audit', auditOk, auditDetail,
      `Write ${planPath} mapping every control, state, validation message and AC to a TC<NN> (or naming it as a gap with a reason). Every TC in the specs must appear there. Then: node tools/gate.mjs audited`);

  return stages;
}

function banner(goal, stages) {
  const first = stages.find((s) => !s.ok);
  const doneN = stages.filter((s) => s.ok).length;
  const lines = [
    '',
    `  GOAL: ${goal.module}${goal.note ? ` — ${goal.note}` : ''}`,
    `  started ${goal.started}`,
    '',
    ...stages.map((s) => `   ${s.ok ? '✔' : '✗'}  ${s.n}. ${s.name.padEnd(9)} ${s.detail}`),
    '',
    `  ${doneN}/${stages.length} stages complete`,
  ];
  if (first) {
    lines.push('',
      '  ──────────────────────────────────────────────────────────────',
      `  NEXT — stage ${first.n} (${first.name}):`,
      `  ${first.next}`,
      '  ──────────────────────────────────────────────────────────────',
      '  The goal is NOT finished. Do not stop. Do not start anything',
      '  outside this module. Continue with the stage above.', '');
  }
  return lines.join('\n');
}

switch (cmd) {
  case 'start': {
    const module = rest[0];
    if (!module) { console.error('usage: gate.mjs start <module> ["note"]'); process.exit(2); }
    const existing = read();
    if (existing && !existing.closed) {
      console.error(`\n  A goal is already open: "${existing.module}".\n` +
        `  Finish it, or close it: node tools/gate.mjs abandon "<reason>"\n` +
        `  Starting a second goal mid-loop is the wandering this gate exists to prevent.\n`);
      process.exit(2);
    }
    write({ module, note: rest.slice(1).join(' ') || null, started: new Date().toISOString(),
            audited: false, defects: [], closed: false });
    console.log(`\n  Goal opened: ${module}\n  Work ONLY on this module until the gate passes.\n`);
    break;
  }

  case 'defect': {
    const g = read();
    if (!g) { console.error('no open goal'); process.exit(2); }
    const text = rest.join(' ');
    if (!text) { console.error('usage: gate.mjs defect "TC01 — what is wrong"'); process.exit(2); }
    g.defects.push({ text, at: new Date().toISOString() });
    write(g);
    console.log(`  recorded product defect: ${text}`);
    break;
  }

  case 'audited': {
    const g = read();
    if (!g) { console.error('no open goal'); process.exit(2); }
    g.audited = true; write(g);
    console.log('  coverage audit confirmed.');
    break;
  }

  case 'check':
  case 'status': {
    const g = read();
    if (!g || g.closed) {
      console.log('  no open goal.');
      process.exit(0);
    }
    const stages = evaluate(g);
    const out = banner(g, stages);
    const incomplete = stages.some((s) => !s.ok);
    if (cmd === 'status') { console.log(out); process.exit(0); }
    console.log(out);
    process.exit(incomplete ? 1 : 0);
  }

  case 'done': {
    const g = read();
    if (!g || g.closed) { console.log('  no open goal.'); process.exit(0); }
    const stages = evaluate(g);
    const incomplete = stages.filter((s) => !s.ok);
    if (incomplete.length) {
      console.error(banner(g, stages));
      console.error(`  REFUSED: ${incomplete.length} stage(s) outstanding. The goal is not done.\n`);
      process.exit(1);
    }
    g.closed = true; g.finished = new Date().toISOString(); write(g);
    console.log(`\n  ✔ ${g.module} complete — all 9 stages passed.` +
                (g.defects.length ? `  (${g.defects.length} product defect(s) reported)` : '') + '\n');
    break;
  }

  case 'abandon': {
    const g = read();
    if (!g) { console.log('  no open goal.'); process.exit(0); }
    const why = rest.join(' ');
    if (!why) {
      console.error('\n  A reason is required. Legitimate stops (skill Phase 3):\n' +
        '   missing credential · unreachable device · ambiguous locator ·\n' +
        '   ambiguous goal · destructive action · 3 attempts exhausted\n');
      process.exit(2);
    }
    g.closed = true; g.abandoned = why; g.finished = new Date().toISOString(); write(g);
    console.log(`  goal closed with reason: ${why}`);
    break;
  }

  default:
    console.log(`usage: gate.mjs start <module> | check | status | defect "<text>" | audited | done | abandon "<why>"`);
    process.exit(2);
}
