#!/usr/bin/env node
/**
 * The skip guard of the image e2e flow (scripts/e2e-image.sh, `task
 * e2e:image`, the CI `e2e` job): fails when a Playwright test of the suite
 * ran in NO phase — skipped in every phase that collected it, or collected by
 * none (outside every phase's --grep or spec list). A test that needs a
 * configuration no phase provides shows up here instead of passing silently.
 *
 *   node scripts/e2e-skip-guard.mjs <listed.json> <phase.json>…
 *   node scripts/e2e-skip-guard.mjs --self-check
 *
 * <listed.json>: `playwright test --list --reporter=json` over the whole
 * suite — every test that must run. <phase.json>: the JSON report of one
 * phase (its file name names the phase). A test ran in a phase when the
 * phase reports an outcome other than `skipped` for it (expected,
 * unexpected or flaky). Exit 0 when every listed test ran somewhere, 1 with
 * the list of those that did not and the skip reasons each phase gave.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Every test of a Playwright JSON report: `file › describe… › title` → { ran, reasons }. */
function testsOf(report) {
  const out = new Map();
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const key = [spec.file, ...titles, spec.title].join(' › ');
      const tests = spec.tests ?? [];
      const reasons = tests.flatMap((t) => (t.annotations ?? []).filter((a) => a.type === 'skip' && a.description).map((a) => a.description));
      const prev = out.get(key);
      out.set(key, {
        ran: (prev?.ran ?? false) || tests.some((t) => t.status !== 'skipped'),
        reasons: [...(prev?.reasons ?? []), ...reasons],
      });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

/** The listed tests no phase ran: [{ test, phases: [{ phase, collected, reasons }] }]. */
function neverRan(listed, phases) {
  const byPhase = phases.map(({ name, report }) => ({ name, tests: testsOf(report) }));
  const missing = [];
  for (const test of testsOf(listed).keys()) {
    if (byPhase.some((p) => p.tests.get(test)?.ran)) continue;
    missing.push({
      test,
      phases: byPhase.map((p) => ({ phase: p.name, collected: p.tests.has(test), reasons: [...new Set(p.tests.get(test)?.reasons ?? [])] })),
    });
  }
  return missing;
}

function describe(missing) {
  const lines = [];
  for (const m of missing) {
    lines.push(`  ✗ ${m.test}`);
    for (const p of m.phases) {
      const why = !p.collected ? 'not collected' : p.reasons.length > 0 ? `skipped: ${p.reasons.join('; ')}` : 'skipped';
      lines.push(`      ${p.phase}: ${why}`);
    }
  }
  return lines.join('\n');
}

function selfCheck() {
  const spec = (file, title, status, reason) => ({
    file,
    title,
    tests: [{ status, annotations: reason ? [{ type: 'skip', description: reason }] : [] }],
  });
  const report = (...files) => ({ suites: files });
  const file = (name, specs, suites) => ({ title: name, file: name, specs, ...(suites ? { suites } : {}) });
  const listed = report(
    file('a.spec.ts', [spec('a.spec.ts', 'runs in phase 1', 'skipped'), spec('a.spec.ts', 'runs in phase 2', 'skipped')]),
    file('b.spec.ts', [], [{ title: 'group @local', specs: [spec('b.spec.ts', 'skipped everywhere', 'skipped'), spec('b.spec.ts', 'never collected', 'skipped')] }]),
    file('c.spec.ts', [spec('c.spec.ts', 'flaky counts as run', 'skipped'), spec('c.spec.ts', 'a failure counts as run', 'skipped')])
  );
  const phase1 = report(
    file('a.spec.ts', [spec('a.spec.ts', 'runs in phase 1', 'expected'), spec('a.spec.ts', 'runs in phase 2', 'skipped', 'needs relay')]),
    file('b.spec.ts', [], [{ title: 'group @local', specs: [spec('b.spec.ts', 'skipped everywhere', 'skipped', 'needs X')] }]),
    file('c.spec.ts', [spec('c.spec.ts', 'flaky counts as run', 'flaky'), spec('c.spec.ts', 'a failure counts as run', 'unexpected')])
  );
  const phase2 = report(
    file('a.spec.ts', [spec('a.spec.ts', 'runs in phase 2', 'expected')]),
    file('b.spec.ts', [], [{ title: 'group @local', specs: [spec('b.spec.ts', 'skipped everywhere', 'skipped', 'needs X')] }])
  );
  const got = neverRan(listed, [
    { name: 'phase-1', report: phase1 },
    { name: 'phase-2', report: phase2 },
  ]);
  const expected = [
    {
      test: 'b.spec.ts › group @local › skipped everywhere',
      phases: [
        { phase: 'phase-1', collected: true, reasons: ['needs X'] },
        { phase: 'phase-2', collected: true, reasons: ['needs X'] },
      ],
    },
    {
      test: 'b.spec.ts › group @local › never collected',
      phases: [
        { phase: 'phase-1', collected: false, reasons: [] },
        { phase: 'phase-2', collected: false, reasons: [] },
      ],
    },
  ];
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`e2e-skip-guard self-check failed:\n${JSON.stringify(got, null, 2)}`);
    process.exit(1);
  }
  if (neverRan(listed, [{ name: 'all', report: listed }]).length !== 6) {
    console.error('e2e-skip-guard self-check failed: a listed-only report must count every test as not run');
    process.exit(1);
  }
  console.log('e2e-skip-guard self-check ok');
}

function main(argv) {
  if (argv.includes('--self-check')) return selfCheck();
  const [listedPath, ...phasePaths] = argv;
  if (!listedPath || phasePaths.length === 0) {
    console.error('usage: node scripts/e2e-skip-guard.mjs <listed.json> <phase.json>…');
    process.exit(2);
  }
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const listed = read(listedPath);
  const phases = phasePaths.map((path) => ({ name: basename(path, '.json'), report: read(path) }));
  const total = testsOf(listed).size;
  const missing = neverRan(listed, phases);
  if (missing.length > 0) {
    console.error(`✗ ${missing.length} of ${total} e2e tests ran in no phase (${phases.map((p) => p.name).join(', ')}):\n${describe(missing)}`);
    process.exit(1);
  }
  const counts = phases.map((p) => `${p.name} ${[...testsOf(p.report).values()].filter((t) => t.ran).length}`).join(', ');
  console.log(`✓ every one of the ${total} e2e tests ran in at least one phase (ran: ${counts})`);
}

main(process.argv.slice(2));
