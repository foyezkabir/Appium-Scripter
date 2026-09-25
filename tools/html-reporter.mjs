/**
 * html-reporter.mjs — this project's own Jest reporter.
 *
 * Renders the dashboard design in "Appium HTML Report design/screen.png" from
 * real run data: KPI cards, a per-test duration chart, a pass-ratio donut, and
 * an expandable suite tree. Every failure carries its device screenshot and the
 * screenshot at the moment it failed, base64-embedded.
 *
 * SELF-CONTAINED BY CONTRACT. The mockup used Tailwind, Font Awesome and Google
 * Fonts over CDN; none of that is here. A report that needs the network is
 * unstyled offline, on a locked-down network, and inside some attachment
 * viewers — which defeats the point of attaching it to a ticket. All CSS is
 * inline, icons are inline SVG, fonts fall back to the system stack.
 *
 * NEVER replaces jest-junit: tools/gate.mjs parses junit.xml to decide whether
 * stage 7 passed. This reporter is additive and purely human-facing.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const OUT_DIR = 'appium-reports';
const FAIL_DIR = join(OUT_DIR, 'failures');

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Must match slug() in jest.setup.ts, or artefacts never pair with tests. */
const slug = (s) => String(s).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s = '') => String(s).replace(/\u001b\[[0-9;]*m/g, '');

const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(3)}s`);
const clock = (ms) => {
  if (ms == null) return '—';
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
};
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(2) : '0.00');

/** Inline SVG — no icon font, so the report renders with no network. */
const I = {
  suites: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v4h-7zM3 14h7v7H3zM14 17h7v4h-7z"/>',
  tests: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
  pass: '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>',
  failSuite: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  failTest: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  tree: '<path d="M3 5h18M3 12h18M3 19h18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  folder: '<path d="M4 20h16a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.7-.9l-.9-1.3A2 2 0 007.8 3H4a2 2 0 00-2 2v13a2 2 0 002 2z"/>',
};
const icon = (d, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/** Steps recorded by StepRecorder during the run, grouped by full test name. */
/**
 * Turn a raw failure into one plain sentence plus a concrete next step.
 *
 * Every rule here matches a failure shape this stack actually produces — the
 * strings come from the skill's documented failure modes, not from guesswork.
 * The raw trace is ALWAYS still shown underneath: this explains, it never
 * replaces. When nothing matches we say so rather than inventing a cause,
 * because a confidently wrong diagnosis costs more than none.
 */
/** Colour a stack trace: the message, your frames, and noise. */
function highlight(raw = '') {
  return esc(raw).split('\n').map((l) => {
    if (/^\s*at /.test(l)) {
      if (/node_modules|internal\//.test(l)) return `<span class="dim">${l}</span>`;
      return `<span class="own">${l}</span>`;
    }
    if (/^(Error|.*Error:|expect\()/.test(l.trim())) return `<span class="hl">${l}</span>`;
    return l;
  }).join('\n');
}

function explain(raw = '') {
  const m = stripAnsi(raw);
  const first = m.split('\n').find((l) => l.trim()) ?? '';

  // Jest assertion: expected X, received Y.
  const unent = (t) => (t ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const exp = unent(m.match(/Expected:?\s*(.+)/)?.[1]?.trim());
  const got = unent(m.match(/Received:?\s*(.+)/)?.[1]?.trim());

  const quoted = (t) => (t.match(/"([^"]+)"/) || t.match(/'([^']+)'/) || [])[1];

  // --- waits ------------------------------------------------------------
  if (/waitForText[\s\S]*timed out|timed out[\s\S]*waitForText/i.test(m)) {
    const txt = quoted(first);
    return {
      why: `The app never showed the text ${txt ? `“${txt}”` : 'that was expected'} within the wait.`,
      next: 'Either the app did not produce that message — a real defect — or the copy changed. Check the screenshot below against the expected string in the locator file.',
    };
  }
  if (/waitVisible|still displayed|never became visible/i.test(m) && /timed out|timeout/i.test(m)) {
    return {
      why: 'An element that the test waited for never appeared on screen.',
      next: 'Confirm on the screenshot whether the screen even reached the right state. If it did, the locator is stale — re-inspect the live hierarchy.',
    };
  }
  if (/waitGone/i.test(m) && /timed out|timeout/i.test(m)) {
    return {
      why: 'An element that should have disappeared was still on screen when the wait expired.',
      next: 'Usually a dialog, sheet or spinner that did not dismiss. Check whether the preceding action actually completed.',
    };
  }

  // --- locators ---------------------------------------------------------
  if (/no such element|NoSuchElement|element wasn'?t found|Can'?t call .* on element/i.test(m)) {
    return {
      why: 'The locator matched nothing on the current screen.',
      next: 'Either the app is on a different screen than expected, or the selector drifted. Note that an element behind the floating bottom nav reports as displayed but is not tappable — use scrollFieldIntoReach() before tapping.',
    };
  }
  if (/stale element|StaleElementReference/i.test(m)) {
    return {
      why: 'The element handle went stale — the view re-rendered between finding it and using it.',
      next: 'A page object cached a handle instead of exposing a getter. Locators must re-query on every access.',
    };
  }

  // --- session / device -------------------------------------------------
  if (/UiAutomation not connected|IllegalStateException/i.test(m)) {
    return {
      why: 'Appium could not take control of the device: another automation client already holds it.',
      next: 'Android grants the UiAutomation connection to exactly one client. Close the other tool and re-run preflight — this is not a test defect.',
    };
  }
  if (/Trust anchor|NSURLErrorDomain|certificate|SSL|CERT_/i.test(m)) {
    return {
      why: 'The app could not reach its API because the TLS certificate was rejected.',
      next: 'Usually device clock skew, which invalidates every current certificate. Check the device date and time before treating this as an API bug.',
    };
  }
  if (/ECONNREFUSED|socket hang up|connect ETIMEDOUT|Failed to create session/i.test(m)) {
    return {
      why: 'The Appium server could not be reached, or refused to start a session.',
      next: 'Check the server is running (npm run appium) and that the device is attached and authorised (npm run preflight).',
    };
  }
  if (/Exceeded timeout of|Async callback was not invoked/i.test(m)) {
    return {
      why: 'The test hit the Jest timeout before it finished.',
      next: 'A step is hanging rather than failing. The step timings below show which one stalled.',
    };
  }

  // --- plain assertion --------------------------------------------------
  if (exp && got) {
    return {
      why: `The app produced ${got} where the test required ${exp}.`,
      next: 'If the app is right, the expected value is stale — re-pin it to the app source. If the test is right, this is a product defect worth reporting.',
    };
  }

  return null;
}

function indexSteps() {
  const idx = new Map();
  const f = join(OUT_DIR, 'steps.jsonl');
  if (!existsSync(f)) return idx;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!idx.has(r.test)) idx.set(r.test, []);
      idx.get(r.test).push(r);
    } catch { /* a truncated line must not lose the whole file */ }
  }
  return idx;
}

function indexArtifacts() {
  const idx = new Map();
  if (!existsSync(FAIL_DIR)) return idx;
  for (const f of readdirSync(FAIL_DIR).sort()) {
    const m = basename(f).match(/^(.+?)__(.+)\.(png|xml)$/);
    if (!m) continue;
    const [, , name, ext] = m;
    const e = idx.get(name) ?? {};
    e[ext] = join(FAIL_DIR, f);
    idx.set(name, e);
  }
  return idx;
}

function collectTests(results) {
  const out = [];
  for (const s of results.testResults) {
    const file = relative(process.cwd(), s.testFilePath);
    for (const t of s.testResults) out.push({ ...t, file });
  }
  return out;
}

/** Duration bars, scaled to the slowest test. Pure CSS — no chart library. */
function barChart(tests) {
  if (!tests.length) return '<p class="empty">No tests ran.</p>';
  const max = Math.max(...tests.map((t) => t.duration ?? 0), 1);
  const bars = tests.slice(0, 24).map((t) => {
    const d = t.duration ?? 0;
    const h = Math.max(2, Math.round((d / max) * 100));
    const label = (t.title.match(/^(TC\d+)/) || [, t.title])[1];
    return `<div class="bar-col" title="${esc(t.title)} — ${secs(d)}">
      <span class="bar-val">${secs(d)}</span>
      <div class="bar-wrap"><div class="bar ${t.status}" style="height:${h}%"></div></div>
      <span class="bar-lbl">${esc(label.slice(0, 8))}</span>
    </div>`;
  }).join('');
  return `<div class="chart"><div class="grid-lines"><span></span><span></span><span></span><span></span></div>
    <div class="bars">${bars}</div></div>`;
}

/** Pass-ratio donut. r=40 → circumference 251.2, matching the mockup. */
function donut(passed, total) {
  const C = 251.2;
  const off = total ? C - (passed / total) * C : C;
  return `<svg viewBox="0 0 100 100" class="donut">
    <circle cx="50" cy="50" r="40" stroke="#12233f" stroke-width="12" fill="none"/>
    <circle cx="50" cy="50" r="40" stroke="url(#dg)" stroke-width="12" fill="none"
      stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 50 50)"/>
    <defs><linearGradient id="dg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#10b981"/>
    </linearGradient></defs></svg>`;
}

function kpi(label, value, sub, note, tone, ic) {
  return `<article class="kpi ${tone}">
    <header><span>${esc(label)}</span>${icon(ic)}</header>
    <div class="kpi-v"><b>${esc(value)}</b>${sub ? `<span class="kpi-s">${sub}</span>` : ''}</div>
    <p>${esc(note)}</p></article>`;
}

function renderTest(t, artifacts, steps) {
  const failed = t.status === 'failed';
  const art = failed ? artifacts.get(slug(t.title)) : undefined;
  // The group header already names the describe block; repeating it on every
  // row wastes the width the test name needs.
  const tcTag = (t.title.match(/^(TC\d+)/) || [])[1] ?? '';
  const titleRest = tcTag ? t.title.slice(tcTag.length).replace(/^[:\s]+/, '') : t.title;
  const mySteps = steps.get(t.fullName) ?? [];

  // Attachments live in a collapsed section — a full-height device screenshot
  // expanded by default buries the assertion diff, which is read first.
  const items = [];
  if (art?.png) {
    try {
      const b64 = readFileSync(art.png).toString('base64');
      const kb = ((b64.length * 3) / 4 / 1024).toFixed(0);
      items.push(`<figure class="shot"><img alt="device at failure" loading="lazy" src="data:image/png;base64,${b64}"><figcaption>device at failure · ${kb} KB</figcaption></figure>`);
    } catch { /* unreadable artefact must not break the report */ }
  }
  const media = items.length
    ? `<details class="sec media"><summary>${icon(I.image)}Media &amp; attachments
        <span class="cnt">${items.length}</span></summary><div class="sec-body">${items.join('')}</div></details>`
    : '';

  // Steps, with the slowest highlighted so a stall is findable at a glance.
  let stepsHtml = '';
  if (mySteps.length) {
    const maxMs = Math.max(...mySteps.map((x) => x.ms), 1);
    const total = mySteps.reduce((a, x) => a + x.ms, 0);
    const rows = mySteps.map((x, i) => `<li class="${x.status}">
      <span class="n">${i + 1}</span>
      <span class="st">${esc(x.title)}${x.error ? `<em>${esc(x.error)}</em>` : ''}</span>
      <span class="sbar"><i style="width:${Math.max(2, Math.round((x.ms / maxMs) * 100))}%"></i></span>
      <span class="sms">${x.ms} ms</span></li>`).join('');
    stepsHtml = `<details class="sec steps" open><summary>${icon(I.tree)}Steps
      <span class="cnt">${mySteps.length}</span><b>${total} ms</b></summary>
      <div class="sec-body"><ol>${rows}</ol></div></details>`;
  }

  // Diagnosis and trace are built separately so STEPS can sit between the
  // row and them: you read what the test did before why it broke.
  const why = (t.failureMessages ?? []).map((m) => {
    const e = explain(m);
    return e
      ? `<details class="sec why" open><summary>${icon(I.info)}What went wrong</summary>
          <div class="sec-body"><p>${esc(e.why)}</p><p class="next">${esc(e.next)}</p></div></details>`
      : '';
  }).join('');
  const traces = (t.failureMessages ?? []).map((m) =>
    `<details class="sec raw"><summary>${icon(I.code)}Full error &amp; stack trace</summary>
      <div class="sec-body"><pre class="err">${highlight(stripAnsi(m))}</pre></div></details>`).join('');
  const badge = { passed: '✓ Passed', failed: '✕ Failed', pending: '○ Skipped', skipped: '○ Skipped', todo: '○ Todo' }[t.status] ?? t.status;
  const body = `${stepsHtml}${why}${traces}${media}`;

  // A test with nothing to show is a plain row — a disclosure arrow that opens
  // an empty panel is worse than no arrow.
  if (!body) {
    return `<div class="trow ${t.status} flat">
      <span class="caret"></span>
      <div class="tmain">${tcTag ? `<span class="tc">${esc(tcTag)}</span>` : ''}<span class="ttitle">${esc(titleRest)}</span></div>
      <span class="ttime">${icon(I.clock)}${clock(t.duration)}</span>
      <span class="tstatus">${badge}</span></div>`;
  }

  // Every test starts COLLAPSED: the page is a clean list of rows, and you
  // open the one you care about. Inside, diagnosis and steps are open so a
  // single click gets you the answer.
  return `<details class="tdet ${t.status}">
    <summary class="trow ${t.status}">
      <span class="caret">▸</span>
      <div class="tmain">${tcTag ? `<span class="tc">${esc(tcTag)}</span>` : ''}<span class="ttitle">${esc(titleRest)}</span></div>
      <span class="ttime">${icon(I.clock)}${clock(t.duration)}</span>
      <span class="tstatus">${badge}</span>
    </summary><div class="tdetail">${body}</div></details>`;
}

export default class HtmlReporter {
  constructor(_globalConfig, options = {}) { this._o = options; }

  onRunComplete(_contexts, results) {
    try { this._write(results); }
    catch (e) {
      // Reporting must never fail a run: the tests already ran and junit.xml
      // is what the gate reads.
      console.warn(`[html-reporter] report not written: ${e.message}`);
    }
  }

  _write(r) {
    const artifacts = indexArtifacts();
    const steps = indexSteps();
    const tests = collectTests(r);
    const {
      numTotalTests: total = 0, numPassedTests: passed = 0, numFailedTests: failed = 0,
      numPendingTests: skipped = 0, numTotalTestSuites: suites = 0,
      numFailedTestSuites: failedSuites = 0,
    } = r;
    const duration = Date.now() - r.startTime;

    // Group each suite's tests by their describe block, the way the report
    // reads: one rail per group, its own counts and timing.
    const suiteCards = r.testResults.map((sres) => {
      const file = relative(process.cwd(), sres.testFilePath);
      const crashed = !sres.testResults.length && (sres.failureMessage || sres.testExecError);
      if (crashed) {
        return `<section class="grp bad"><div class="ghead">${icon(I.folder, 'gicon bad')}
          <span class="gname">${esc(file)}</span><span class="pill fail">suite failed to run</span></div>
          <div class="tdetail"><pre class="err">${esc(stripAnsi(sres.failureMessage || String(sres.testExecError)))}</pre></div></section>`;
      }
      const groups = new Map();
      for (const t of sres.testResults) {
        const key = (t.ancestorTitles ?? []).join(' › ') || file;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      return [...groups.entries()].map(([name, list]) => {
        const nFail = list.filter((t) => t.status === 'failed').length;
        const ms = list.reduce((a, t) => a + (t.duration ?? 0), 0);
        const tag = nFail
          ? `<span class="pill fail">${nFail} failing test${nFail > 1 ? 's' : ''}</span>`
          : `<span class="pill ok">${list.length} test${list.length > 1 ? 's' : ''}</span>`;
        return `<section class="grp ${nFail ? 'bad' : 'ok'}">
          <div class="ghead">${icon(I.folder, nFail ? 'gicon bad' : 'gicon ok')}
            <span class="gname">${esc(name)}</span>${tag}
            <span class="gtime">Suite time: ${clock(ms)}</span></div>
          ${list.map((t) => renderTest(t, artifacts, steps)).join('')}</section>`;
      }).join('');
    }).join('');

    const ctx = [
      ['Platform', process.env.APPIUM_PLATFORM], ['Framework', process.env.APPIUM_FRAMEWORK],
      ['Device', process.env.APPIUM_DEVICE_NAME], ['App', process.env.APPIUM_APP_ID],
    ].filter(([, v]) => v).map(([k, v]) => `<span><i>${esc(k)}</i> ${esc(v)}</span>`).join('<em>•</em>');

    const title = this._o.pageTitle ?? 'Appium Automation Report';
    const allGreen = failed === 0 && failedSuites === 0;

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--dark:#081325;--surface:#0f1d32;--card:#162844;--border:#1f385c;--line:#12233f;
--fg:#e2e8f0;--mut:#7f93b0;--accent:#06b6d4;--sky:#38bdf8;--pass:#10b981;--fail:#f43f5e;--warn:#f59e0b;--purple:#a78bfa;
--mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace;
--sans:"Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{background:radial-gradient(circle at 10% 20%,#0a182f 0%,#060e1d 90%);background-attachment:fixed;
color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.5;min-height:100vh}
.wrap{max-width:1600px;margin:0 auto;padding:24px 16px 48px}
/* header */
header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;
padding-bottom:20px;border-bottom:1px solid var(--border);margin-bottom:24px}
.brand h1{font-size:24px;font-weight:800;color:#fbbf24;font-style:italic;letter-spacing:-.02em}
.brand .meta{color:var(--mut);font-size:12px;font-family:var(--mono);margin-top:6px}
.brand .meta b{color:var(--fg);font-weight:600}
.brand .meta i{color:var(--mut);font-style:normal;opacity:.75}
.brand .meta em{color:var(--border);font-style:normal;margin:0 9px}
.status-pill{display:inline-flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);
border-radius:999px;padding:8px 16px;font-size:12px;font-family:var(--mono)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--pass);box-shadow:0 0 8px var(--pass)}
.dot.red{background:var(--fail);box-shadow:0 0 8px var(--fail)}
/* kpi */
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-bottom:24px}
@media(max-width:1250px){.kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px}
.kpi header{display:flex;align-items:center;justify-content:space-between;color:var(--mut);
font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px}
.kpi .i{width:18px;height:18px;opacity:.9}
.kpi-v{display:flex;align-items:baseline;gap:10px}
.kpi-v b{font-size:34px;font-weight:800;font-family:var(--mono);letter-spacing:-.03em}
.kpi-s{font-size:12px;color:var(--mut)}
.kpi p{color:var(--mut);font-size:12px;margin-top:8px}
.kpi.ok{border-color:rgba(16,185,129,.35);box-shadow:0 0 20px -3px rgba(16,185,129,.2)}
.kpi.ok .kpi-v b,.kpi.ok header{color:var(--pass)}
.kpi.bad{border-color:rgba(244,63,94,.35);box-shadow:0 0 20px -3px rgba(244,63,94,.18)}
.kpi.bad .kpi-v b,.kpi.bad header{color:var(--fail)}
.kpi.info .kpi-v b{color:var(--sky)}.kpi.info header{color:var(--sky)}
.kpi.time .kpi-v b{color:var(--purple)}.kpi.time header{color:var(--purple)}
.pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;font-family:var(--mono);white-space:nowrap}
.pill.ok{background:rgba(16,185,129,.15);color:var(--pass)}
.pill.fail{background:rgba(244,63,94,.15);color:var(--fail)}
/* panels */
.panels{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:1000px){.panels{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px}
.panel h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px;margin-bottom:4px}
.panel h2 .i{width:18px;height:18px;color:var(--accent)}
.panel .sub{color:var(--mut);font-size:12px;margin-bottom:20px}
/* chart */
.chart{position:relative;height:250px;padding:20px 0 2px}
.grid-lines{position:absolute;inset:20px 0 30px 0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.grid-lines span{border-top:1px dashed rgba(31,56,92,.7);display:block}
.bars{position:absolute;inset:0;display:flex;align-items:stretch;gap:14px;overflow-x:auto;overflow-y:hidden}
.bar-col{flex:1 0 50px;max-width:86px;display:grid;grid-template-rows:16px 1fr 26px;justify-items:center}
.bar-val{font-family:var(--mono);font-size:10px;color:var(--mut);white-space:nowrap;align-self:end}
.bar-wrap{width:100%;display:flex;align-items:flex-end}
.bar{width:100%;border-radius:6px 6px 0 0;background:linear-gradient(180deg,#22d3ee,#0891b2);min-height:2px}
.bar.failed{background:linear-gradient(180deg,#fb7185,#e11d48)}
.bar.pending,.bar.skipped,.bar.todo{background:linear-gradient(180deg,#fbbf24,#d97706)}
.bar-lbl{font-family:var(--mono);font-size:10px;color:var(--mut);white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;max-width:100%;align-self:center;padding-top:8px}
/* donut */
.donut-wrap{position:relative;display:grid;place-items:center;margin:10px 0 22px}
.donut{width:210px;height:210px}
.donut-mid{position:absolute;text-align:center}
.donut-mid b{font-size:32px;font-weight:800;font-family:var(--mono);display:block;letter-spacing:-.02em}
.donut-mid span{font-size:11px;color:var(--mut);letter-spacing:.1em;text-transform:uppercase}
.donut-mid small{display:block;color:var(--mut);font-size:11px;margin-top:4px;font-family:var(--mono)}
.legend{border-top:1px solid var(--line);padding-top:14px}
.legend div{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:13px}
.legend .k{display:flex;align-items:center;gap:9px;color:var(--mut)}
.legend .k i{width:8px;height:8px;border-radius:50%;background:var(--accent);display:block}
.legend .v{font-family:var(--mono);font-weight:600}
/* toolbar */
.toolbar{display:flex;gap:14px;justify-content:space-between;align-items:flex-start;
flex-wrap:wrap;padding:13px 0 17px;margin-bottom:6px;border-bottom:1px solid var(--line)}
.tb-left{display:flex;gap:9px;flex-wrap:wrap}
.tb-right{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-left:auto}
.chip{background:rgba(6,182,212,.09);border:1px solid rgba(6,182,212,.25);color:var(--mut);
border-radius:7px;padding:5px 11px;font-family:var(--mono);font-size:11px}
.chip b{color:var(--accent);font-weight:600}
.search{background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--fg);
padding:7px 13px;font-family:var(--sans);font-size:12.5px;min-width:215px;outline:none}
.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(6,182,212,.13)}
.filters{display:flex;gap:5px;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:3px}
.fb{background:transparent;border:0;color:var(--mut);font-family:var(--sans);font-size:12px;font-weight:600;
padding:6px 12px;border-radius:7px;cursor:pointer;display:flex;align-items:center;gap:6px}
.fb i{font-style:normal;font-family:var(--mono);font-size:10px;background:var(--line);
border-radius:999px;padding:1px 7px}
.fb:hover{color:var(--fg)}
.fb.on{background:rgba(6,182,212,.16);color:var(--accent);box-shadow:0 0 12px rgba(6,182,212,.15)}
.fb.wide{border:1px solid var(--border);background:var(--card)}
/* groups */
.grp{border:1px solid var(--border);border-radius:11px;
margin-bottom:11px;overflow:hidden;background:rgba(15,29,50,.55)}
.ghead{display:flex;align-items:center;gap:11px;padding:11px 15px;background:rgba(22,40,68,.8);
border-bottom:1px solid var(--border);flex-wrap:wrap}
.gicon{width:16px;height:16px;flex:none;opacity:.55;color:var(--mut)}
.gicon.bad{color:#fb7185;opacity:.75}
.gname{font-weight:700;font-size:13.5px}
.gtime{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--mut)}
/* suites */
.suite{border:1px solid var(--border);border-radius:14px;margin-bottom:12px;overflow:hidden;background:rgba(15,29,50,.6)}
.shead{display:flex;align-items:center;gap:12px;padding:14px 16px;background:rgba(22,40,68,.75);border-bottom:1px solid var(--border);flex-wrap:wrap}
.sfile{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--sky);flex:1;min-width:0;word-break:break-all}
.sdur{font-family:var(--mono);font-size:12px;color:var(--mut);display:inline-flex;align-items:center;gap:6px}
.sdur .i,.ttime .i{width:13px;height:13px}
.tdet{border-bottom:1px solid var(--line)}
.tdet:last-child,.trow.flat:last-child{border-bottom:0}
.tdet>summary{list-style:none;cursor:pointer}
.tdet>summary::-webkit-details-marker{display:none}
.tdet>summary:hover{background:rgba(31,56,92,.3)}
.caret{width:28px;height:28px;flex:none;color:var(--pass);font-size:22px;line-height:26px;text-align:center;
transition:transform .15s,background .15s;display:inline-block;border-radius:7px;
border:1px solid rgba(16,185,129,.25);background:rgba(16,185,129,.08)}
.tdet>summary:hover .caret{background:rgba(16,185,129,.22);border-color:rgba(16,185,129,.55)}
.pending>summary .caret,.skipped>summary .caret,.todo>summary .caret{
color:var(--warn);border-color:rgba(245,158,11,.28);background:rgba(245,158,11,.08)}
.pending>summary:hover .caret,.skipped>summary:hover .caret,.todo>summary:hover .caret{
background:rgba(245,158,11,.2);border-color:rgba(245,158,11,.55)}
.failed>summary .caret{color:#fb7185;border-color:rgba(244,63,94,.28);background:rgba(244,63,94,.08)}
.failed>summary:hover .caret{background:rgba(244,63,94,.2);border-color:rgba(244,63,94,.55)}
.trow.flat .caret{border-color:transparent;background:transparent;opacity:.25}
.tdet[open]>summary .caret{transform:rotate(90deg)}
.trow{display:flex;align-items:center;gap:12px;padding:13px 16px 13px 22px;
border-bottom:1px solid var(--line);flex-wrap:wrap;position:relative}
/* per-row rail: inset top and bottom so consecutive rows show a clear gap */
.trow::before{content:'';position:absolute;left:9px;top:7px;bottom:7px;width:4px;
border-radius:3px;background:var(--mut);opacity:.85}
.passed>.trow::before,.trow.passed::before{background:var(--pass)}
.failed>.trow::before,.trow.failed::before{background:var(--fail)}
.pending>.trow::before,.trow.pending::before,
.skipped>.trow::before,.trow.skipped::before,
.todo>.trow::before,.trow.todo::before{background:var(--warn)}
.trow:last-child{border-bottom:0}
.tmain{flex:1;min-width:220px}
.tc{color:var(--pass);font-family:var(--mono);font-size:12px;font-weight:600;
background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.24);border-radius:5px;
padding:1px 7px;margin-right:9px}
.pending .tc,.skipped .tc,.todo .tc{color:var(--warn);background:rgba(245,158,11,.1);
border-color:rgba(245,158,11,.24)}
.failed .tc{color:#fb7185;background:rgba(244,63,94,.1);border-color:rgba(244,63,94,.24)}
.ttitle{font-size:13.5px}
.ttime{font-family:var(--mono);font-size:12px;color:var(--mut);display:inline-flex;align-items:center;gap:6px}
.tstatus{font-family:var(--mono);font-size:12px;font-weight:600;min-width:86px;text-align:right}
.passed .tstatus{color:var(--pass)}.failed .tstatus{color:var(--fail)}
.pending .tstatus,.skipped .tstatus,.todo .tstatus{color:var(--warn)}
.trow.failed{background:rgba(244,63,94,.06)}
.tdetail{padding:4px 16px 18px 22px;border-bottom:1px solid var(--line);background:rgba(8,19,37,.5)}
pre{background:#0b1728;border:1px solid var(--border);border-radius:8px;padding:13px;overflow-x:auto;
font-family:var(--mono);font-size:12px;line-height:1.55;margin:12px 0}
pre.err{white-space:pre-wrap;word-break:break-word;color:#fecdd3;border-color:rgba(244,63,94,.3)}
/* ── failure sub-sections: each has its OWN accent colour, so the eye can
      tell diagnosis from steps from raw trace at a glance ───────────────── */
.sec{border-radius:10px;margin:10px 0;overflow:hidden;border:1px solid var(--border);
background:rgba(13,26,46,.7)}
.sec>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:9px;
padding:11px 14px;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;user-select:none}
.sec>summary::-webkit-details-marker{display:none}
.sec>summary::after{content:'▸';margin-left:auto;font-size:15px;opacity:.65;transition:transform .15s}
.sec[open]>summary::after{transform:rotate(90deg)}
.sec>summary .i{width:15px;height:15px;flex:none}
.sec>summary .cnt{background:rgba(255,255,255,.1);border-radius:999px;padding:1px 9px;
font-size:10px;letter-spacing:0;font-weight:700}
.sec>summary b{margin-left:auto;font-family:var(--mono);font-size:11px;font-weight:600;
letter-spacing:0;text-transform:none;opacity:.8}
.sec>summary b+::after{margin-left:9px}
.sec-body{padding:13px 14px;border-top:1px solid var(--border)}

/* diagnosis — cyan */
.sec.why{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.06)}
.sec.why>summary{color:var(--accent);background:rgba(6,182,212,.1)}
.sec.why .sec-body{border-top-color:rgba(6,182,212,.25)}
.sec.why p{font-size:13.5px;line-height:1.65;text-transform:none;letter-spacing:0}
.sec.why p.next{color:var(--mut);font-size:12.5px;margin-top:9px;padding-top:10px;
border-top:1px dashed rgba(6,182,212,.3)}
/* raw trace — red */
.sec.raw{border-color:rgba(244,63,94,.35);background:rgba(244,63,94,.05)}
.sec.raw>summary{color:#fb7185;background:rgba(244,63,94,.1)}
.sec.raw .sec-body{border-top-color:rgba(244,63,94,.22)}
.sec.raw pre{background:rgba(8,19,37,.75);border-color:rgba(244,63,94,.2)}
.sec.raw pre .hl{color:#fb7185;font-weight:600}
.sec.raw pre .dim{color:#5b6b85}
.sec.raw pre .own{color:#22d3ee}
/* steps — violet */
.sec.steps{border-color:rgba(167,139,250,.35);background:rgba(167,139,250,.05)}
.sec.steps>summary{color:var(--purple);background:rgba(167,139,250,.1)}
.sec.steps .sec-body{border-top-color:rgba(167,139,250,.22)}
/* media — amber */
.sec.media{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.05)}
.sec.media>summary{color:var(--warn);background:rgba(245,158,11,.1)}
.sec.media .sec-body{border-top-color:rgba(245,158,11,.22)}

.steps ol{list-style:none}
.steps li{display:flex;align-items:center;gap:11px;padding:7px 11px;border-radius:7px;
border:1px solid transparent;font-size:12.5px}
.steps li:nth-child(odd){background:rgba(8,19,37,.5)}
.steps li.failed{background:rgba(244,63,94,.1);border-color:rgba(244,63,94,.3)}
.steps .n{font-family:var(--mono);font-size:10px;color:var(--mut);min-width:17px;text-align:right;flex:none}
.steps .st{flex:1;min-width:140px}
.steps .st em{display:block;font-style:normal;color:#fda4af;font-family:var(--mono);font-size:11px;margin-top:3px}
.steps li.failed .st{color:#fecdd3}
.steps .sbar{flex:0 0 100px;height:5px;background:rgba(31,56,92,.9);border-radius:3px;overflow:hidden}
.steps .sbar i{display:block;height:100%;background:linear-gradient(90deg,#a78bfa,#7c3aed);border-radius:3px}
.steps li.failed .sbar i{background:linear-gradient(90deg,#fb7185,#e11d48)}
.steps .sms{font-family:var(--mono);font-size:11px;color:var(--mut);min-width:56px;text-align:right;flex:none}
@media(max-width:620px){.steps .sbar{display:none}}

.shot{margin:0}
.shot img{max-width:260px;max-height:440px;border:1px solid var(--border);border-radius:9px;display:block}
.shot figcaption{color:var(--mut);font-size:11px;margin-top:8px;font-family:var(--mono)}
.empty{color:var(--mut);padding:24px;text-align:center}
footer{margin-top:28px;padding-top:18px;border-top:1px solid var(--border);color:var(--mut);
font-size:12px;font-family:var(--mono);display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
@media(max-width:640px){.wrap{padding:16px 12px}.brand h1{font-size:19px}.kpi-v b{font-size:28px}
.donut{width:170px;height:170px}.shot img{max-width:100%}}
</style></head><body><div class="wrap">

<header class="top">
  <div class="brand"><h1>${esc(title)}</h1>
    <div class="meta">${ctx || '<span><i>Run</i> local</span>'}</div></div>
  <div class="status-pill"><span class="dot ${allGreen ? '' : 'red'}"></span>
    ${allGreen ? 'All green' : `${failed} failing`} &nbsp;·&nbsp; ${new Date(r.startTime).toLocaleString()}</div>
</header>

<div class="kpis">
  ${kpi('Suites total', String(suites), '', `${r.testResults.length} executed`, 'info', I.suites)}
  ${kpi('Tests total', String(total), '', `${skipped} skipped / pending`, 'info', I.tests)}
  ${kpi('Passed tests', String(passed), `<span class="pill ok">${pct(passed, total)}%</span>`, passed === total && total ? 'All assertions green' : 'Some assertions failed', 'ok', I.pass)}
  ${kpi('Failed tests', String(failed), `<span class="pill ${failed ? 'fail' : 'ok'}">${pct(failed, total)}%</span>`, failed ? 'See failures below' : 'Zero regression detected', failed ? 'bad' : 'ok', I.failTest)}
  ${kpi('Duration', secs(duration), '', '1 worker thread used', 'time', I.clock)}
</div>

<div class="panels">
  <section class="panel"><h2>${icon(I.chart)}Test duration profile</h2>
    <p class="sub">Per-test execution time${tests.length > 24 ? ' — first 24 shown' : ''}</p>
    ${barChart(tests)}</section>
  <section class="panel"><h2>${icon(I.pass)}Pass ratio</h2>
    <p class="sub">Across every spec in this run</p>
    <div class="donut-wrap">${donut(passed, total)}
      <div class="donut-mid"><b>${passed} / ${total}</b><span>passed</span>
        <small>${failed} fail · ${skipped} skip</small></div></div>
    <div class="legend">
      <div><span class="k"><i></i>Pass rate</span><span class="v">${pct(passed, total)}%</span></div>
      <div><span class="k"><i style="background:var(--pass)"></i>Total duration</span><span class="v">${secs(duration)}</span></div>
      <div><span class="k"><i style="background:var(--purple)"></i>Suites</span><span class="v">${suites}</span></div>
    </div></section>
</div>

<section class="panel"><h2>${icon(I.tree)}Test suite details</h2>
  <p class="sub">Click any test case row or caret to view execution steps, timings, the plain-language diagnosis and failure media</p>
  <div class="toolbar">
    <div class="tb-left">
      <span class="chip">Target spec: <b>${esc(r.testResults.map((x) => relative(process.cwd(), x.testFilePath)).join(', ').slice(0, 80))}</b></span>
      <span class="chip">Worker: <b>1</b>${process.env.APPIUM_DEVICE_NAME ? ` · <b>${esc(process.env.APPIUM_DEVICE_NAME)}</b>` : ''}</span>
    </div>
    <div class="tb-right">
      <input id="q" class="search" type="search" placeholder="Search test case or error…" autocomplete="off">
      <div class="filters">
        <button class="fb on" data-f="all">All <i>${total}</i></button>
        <button class="fb" data-f="failed">Failed <i>${failed}</i></button>
        <button class="fb" data-f="passed">Passed <i>${passed}</i></button>
        <button class="fb" data-f="pending">Skipped <i>${skipped}</i></button>
      </div>
      <button id="xa" class="fb wide">Expand all</button>
    </div>
  </div>
  ${suiteCards || '<p class="empty">No test results.</p>'}</section>

<script>
(function(){
  var rows=[].slice.call(document.querySelectorAll('.tdet,.trow.flat'));
  var q=document.getElementById('q'), xa=document.getElementById('xa'), f='all';
  function statusOf(el){var c=el.className;return /failed/.test(c)?'failed':/passed/.test(c)?'passed':'pending';}
  function apply(){
    var term=(q.value||'').toLowerCase();
    rows.forEach(function(el){
      var okF = f==='all' || statusOf(el)===f;
      var okQ = !term || el.textContent.toLowerCase().indexOf(term)>-1;
      el.style.display = (okF&&okQ) ? '' : 'none';
    });
    // hide a group whose rows are all filtered out
    [].forEach.call(document.querySelectorAll('.grp'), function(g){
      var any=[].slice.call(g.querySelectorAll('.tdet,.trow.flat')).some(function(r){return r.style.display!=='none';});
      g.style.display = any ? '' : 'none';
    });
  }
  [].forEach.call(document.querySelectorAll('.fb[data-f]'), function(b){
    b.addEventListener('click', function(){
      [].forEach.call(document.querySelectorAll('.fb[data-f]'),function(x){x.classList.remove('on');});
      b.classList.add('on'); f=b.dataset.f; apply();
    });
  });
  q.addEventListener('input', apply);
  xa.addEventListener('click', function(){
    var open = xa.textContent.trim()==='Expand all';
    rows.forEach(function(el){ if(el.tagName==='DETAILS') el.open=open; });
    xa.textContent = open ? 'Collapse all' : 'Expand all';
  });
})();
</script>
<footer><span>Generated by tools/html-reporter.mjs</span>
  <span>Self-contained — screenshots embedded, no external assets</span></footer>
</div></body></html>`;

    mkdirSync(OUT_DIR, { recursive: true });
    const file = join(OUT_DIR, this._o.filename ?? 'report.html');
    writeFileSync(file, html);
    console.log(`\n  report: ${file}`);
  }
}
