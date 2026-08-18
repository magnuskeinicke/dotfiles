export const meta = {
  name: 'solve-ready-loop',
  description:
    'Solve one agent:ready ticket, depth-scaled by a triage step: triage → implement (Opus) → review (scaled) → at most one fix round. Lighter than work-slice-loop (no slice/stack framing, cap 1, no human gate). Returns a summary for the draft PR.',
  phases: [
    { title: 'Triage', detail: 'one Sonnet agent sizes the ticket → trivial | standard | escalate', model: 'sonnet' },
    { title: 'Implement', detail: 'Opus agent; TDD for standard, lighter for trivial', model: 'opus' },
    { title: 'Review', detail: 'trivial: baseline only · standard: diff-matched reviewers (+ Playwright if user-facing)', model: 'sonnet' },
    { title: 'Fix', detail: 'Opus resolves blocking findings — at most ONE round', model: 'opus' },
  ],
};

// ── args (passed by the skill) ──────────────────────────────────────────────
// { issueId, title, acceptanceCriteria, baseBranch, worktree, repoConfig }
// The Workflow runtime delivers `args` as a JSON *string*, not a parsed object —
// normalise it here so A.issueId etc. resolve (otherwise every run escalates as
// "(unknown issue)").
let A = args || {};
if (typeof A === 'string') {
  try {
    A = JSON.parse(A);
  } catch {
    A = {};
  }
}
A = A || {};
const CFG = A.repoConfig || {}; // from ~/.claude/docs/agents/repo-config.md
const ISSUE = A.issueId || '(unknown issue)';
const TITLE = A.title ? String(A.title) : '';
const BASE = A.baseBranch || CFG.integrationBranch || 'development';
const WORKTREE = A.worktree ? String(A.worktree) : '';
const AC = Array.isArray(A.acceptanceCriteria)
  ? A.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
  : String(A.acceptanceCriteria || '(see ticket — derive from description)');
const DEV_SERVER = CFG.devServerCommand || 'DEV_LOGIN_ENABLED_SERVER=true pnpm nx portless seranote-web';
const E2E_DIR = CFG.e2eDir || 'apps/seranote-web-e2e/';
const BROWSER_GUIDE = CFG.browserGuidePath || '.claude/skills/dev-loop/browser-guide.md';

// >>> shared:reviewer-registry — generated from claude/skills/_shared/reviewer-registry.js; edit there and run `make skills-shared`
// Shared reviewer registry for the feature-dev workflow scripts
// (work-slice-loop, solve-ready-loop). Workflow scripts must be
// self-contained — they cannot import this file — so `make skills-shared`
// copies this block verbatim into each script between the
// `// >>> shared:reviewer-registry` / `// <<< shared:reviewer-registry`
// markers. Edit HERE, never in the generated blocks; `make skills-shared`
// re-syncs, `./scripts/95_skills_shared.sh --check` fails on drift.
const KNOWN_AREAS = ['frontend', 'backend', 'database', 'i18n', 'security', 'performance'];

const REVIEWERS = {
  frontend: {
    skills: 'frontend-implementation, tailwind-predefined-values, web-design-guidelines, figma-implement-design',
    focus:
      'React component structure, design-system token/component reuse (no magic numbers), Tailwind predefined values + cn() for conditionals, loading/empty/error states, Web Interface Guidelines (a11y).',
  },
  backend: {
    skills: 'backend-action-service-split',
    focus:
      'the dal/service/action three-layer split, server-action boundaries, cache invalidation, error-as-value (return error objects, never throw), createBaseRepo usage.',
  },
  database: {
    skills: 'CLAUDE.md DB conventions',
    focus:
      'Drizzle schema/relations correctness, migration generated + sequenced correctly (not hand-renumbered), createBaseRepo query patterns, no OUTER JOINs (prefer INNER or correlated scalar subqueries).',
  },
  i18n: {
    skills: 'i18n',
    focus:
      'every t()/useTranslations/getTranslations key exists in en.json, ICU placeholders/plural/select valid, Crowdin key naming, no hardcoded user-facing strings.',
  },
  security: {
    skills: 'security-review',
    focus:
      'authorization on server actions, secret/env handling, input validation, injection, file-upload safety, no secret leakage into client bundles.',
  },
  performance: {
    skills: 'vercel-react-best-practices',
    focus:
      'data-fetching waterfalls, unnecessary client components, memoization, bundle/dynamic-import, render cost on hot paths.',
  },
};

const BASELINE = {
  skills: 'CLAUDE.md conventions',
  focus:
    'correctness bugs, missed acceptance criteria, convention/reuse misses, and test quality — NOT style nits.',
};

// area → path patterns (regex sources; object form `{re, flags}` carries flags).
// The repo-specific default below is overridable per repo via
// `repoConfig.areaPaths` from ~/.claude/docs/agents/repo-config.md.
const DEFAULT_AREA_PATHS = {
  frontend: ['^libs/ui/web/', '^apps/seranote-web/.*\\.tsx$', '\\.stories\\.tsx$'],
  backend: ['^libs/backend/'],
  database: ['^drizzle/', 'libs/backend/db/.*schemas/', '/relations/', 'drizzle\\.config\\.ts$'],
  i18n: ['apps/seranote-web/src/i18n/', '(^|/)en\\.json$'],
  security: ['^libs/backend/actions/', { re: 'auth', flags: 'i' }, '\\.env'],
};

function compileAreaPaths(map) {
  return Object.entries(map || {}).map(([area, patterns]) => [
    area,
    (patterns || []).map((p) => (typeof p === 'string' ? new RegExp(p) : new RegExp(p.re, p.flags || ''))),
  ]);
}

// deterministic path → area mapping, unioned with agent-declared areas
function selectAreas(compiledAreaPaths, changedFiles, declaredAreas) {
  const set = new Set();
  for (const f of changedFiles || [])
    for (const [area, regexes] of compiledAreaPaths) if (regexes.some((r) => r.test(f))) set.add(area);
  for (const a of declaredAreas || []) if (KNOWN_AREAS.includes(a)) set.add(a);
  return [...set];
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'One-line description of what was implemented/fixed.' },
    committed: { type: 'boolean' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths touched.' },
    touchedAreas: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_AREAS },
      description: 'Semantic areas this change affects (declare security/performance even when paths look neutral).',
    },
    userFacingImpact: {
      type: 'boolean',
      description: 'Does this change plausibly alter user-visible behaviour? Bias toward true when unsure.',
    },
    testsGreen: { type: 'boolean' },
    diffStat: { type: 'string', description: 'Output of `git diff --stat <base>...HEAD`.' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'committed', 'changedFiles', 'touchedAreas', 'userFacingImpact', 'testsGreen'],
};

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'number' },
    detail: { type: 'string' },
    suggestedFix: { type: 'string' },
  },
  required: ['title', 'detail'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    blockingFindings: { type: 'array', items: FINDING },
    notes: { type: 'array', items: { type: 'string' }, description: 'Judgement-call / debatable points; never block.' },
  },
  required: ['area', 'blockingFindings', 'notes'],
};

const PLAYWRIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          screenshot: { type: 'string' },
        },
        required: ['criterion', 'pass'],
      },
    },
    blockingFindings: { type: 'array', items: FINDING },
    proofPaths: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'criteria', 'blockingFindings', 'notes'],
};
// <<< shared:reviewer-registry

const AREA_COMPILED = compileAreaPaths(CFG.areaPaths || DEFAULT_AREA_PATHS);

// ── schemas (loop-specific; shared ones live in the registry block) ──────────
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tier: {
      type: 'string',
      enum: ['trivial', 'standard', 'escalate'],
      description:
        'trivial = copy/constant/dep-bump/lint/single-file mechanical, no real logic. standard = small bounded feature/bugfix with real logic in one or few areas. escalate = bigger / multi-area / ambiguous / migration- or auth-touching than an agent:ready ticket should be — kick back to a human.',
    },
    reason: { type: 'string', description: 'One or two sentences justifying the tier.' },
    whereToLook: { type: 'string', description: 'Discovered code-layer pointers — files/dirs/sibling to mirror.' },
    touchedAreas: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_AREAS },
      description: 'Best guess at the semantic areas this will touch.',
    },
    userFacing: {
      type: 'boolean',
      description: 'Will this plausibly change user-visible behaviour? Bias true when unsure.',
    },
  },
  required: ['tier', 'reason', 'touchedAreas', 'userFacing'],
};

// ── prompt builders ──────────────────────────────────────────────────────────
const CONTRACT = `Ticket: ${ISSUE}${TITLE ? ` — ${TITLE}` : ''}
Base branch: ${BASE}${
  WORKTREE
    ? `
Working directory: ${WORKTREE} — \`cd\` into this git worktree before ANY file read/edit, test, \`pnpm nx\`, or git command. All implementation, tests, commits, and diffs happen HERE on the current branch, NEVER in the main checkout. Run \`git diff ${BASE}...HEAD\` from inside the worktree.`
    : ''
}

Acceptance criteria:
${AC}`;

function triagePrompt() {
  return `You are sizing one Linear ticket that was already labelled \`agent:ready\` (a triage step judged it low-risk and single-PR). Your job is to pick the EFFORT TIER for solving it, and to bail if the label looks wrong.

${CONTRACT}

Do a QUICK read-only scan of the repo to ground your call (grep/glob/read a few files near the change — do NOT implement anything). Then classify:

- "trivial": copy/text/constant change, dependency bump, lint/format fix, a single-file mechanical edit, or a small isolated test — no real branching logic, one area at most.
- "standard": a small bounded feature or bug fix with real logic, in one or a few areas. Still single-PR.
- "escalate": on inspection this is BIGGER or riskier than an agent:ready ticket should be — multiple unrelated areas, ambiguous/underspecified acceptance criteria, a DB migration with schema change, auth/billing/security/clinical-data surface, or anything needing product/architecture judgement. Choose this to kick the ticket back to a human rather than ship a bad PR.

Return: tier, reason (1–2 sentences), whereToLook (concrete files/dirs/sibling to mirror), touchedAreas (best guess), userFacing (bias true when unsure). When torn between two tiers, pick the heavier one.`;
}

function implPrompt(tier, where) {
  const tdd =
    tier === 'trivial'
      ? '- This is a trivial change. Keep it minimal. Add or adjust a test only where a `jest.config` already exists for the touched lib; do not scaffold new test infrastructure.'
      : '- Work TEST-FIRST: one tracer-bullet test → impl per acceptance criterion (vertical slice — never all-tests-then-all-impl).';
  return `You are the Opus implementer for one agent:ready ticket. Implement EXACTLY what the acceptance criteria require — no more, no less (scope creep becomes a review/compliance problem later).

${CONTRACT}

Where to look (starting map — mirror the named sibling): ${where || '(discover from the codebase)'}

Rules:
${tdd}
- Follow CLAUDE.md and the relevant repo skills (backend-action-service-split, frontend-implementation, i18n, tailwind-predefined-values, sentry-logging, etc.).
- For UI, reuse design-system tokens/components — no magic numbers.
- Run the affected tests + lint/typecheck green with \`pnpm nx\` before finishing.
- Commit on the current branch with a message starting with the ticket id (${ISSUE}).

Return the structured result: summary, committed, changedFiles (\`git diff --name-only ${BASE}...HEAD\`), touchedAreas (declare security/performance explicitly when relevant), userFacingImpact (bias true), testsGreen, diffStat (\`git diff --stat ${BASE}...HEAD\`), notes.`;
}

function fixPrompt(feedback) {
  return `You are the Opus implementer. A review round found BLOCKING problems. Resolve every one of them TEST-FIRST (RED→GREEN where behaviour changes). Do not address style nits or out-of-scope items, and do not pull in new scope.

${CONTRACT}

Blocking findings to resolve:
${feedback}

Rules: stay in scope; run affected tests + lint/typecheck green with \`pnpm nx\`; commit with a message starting with ${ISSUE}.
Return the structured result (same shape as before) — recompute changedFiles/touchedAreas/userFacingImpact/diffStat from THIS fix.`;
}

function reviewerPrompt(area, def) {
  return `You are an INDEPENDENT, READ-ONLY reviewer for the "${area}" area of one agent:ready ticket. You MUST NOT edit any files — only report.

${CONTRACT}

Inspect the diff with \`git diff ${BASE}...HEAD\` (and read surrounding files as needed).
Apply the conventions from the ${def.skills} skill — consult it via the Skill tool if available, otherwise apply its known rules.
Focus on: ${def.focus}

Report ONLY:
- blockingFindings: correctness bugs, missed acceptance criteria, or convention/reuse violations in YOUR area. Each with title, file, line, detail, and a concrete suggestedFix. If none, return an empty array.
- notes: judgement-call / debatable points that should NOT block.
Set "area" to "${area}". Do not invent problems to look productive — an empty blockingFindings array is the correct result for clean code.`;
}

function playwrightPrompt() {
  return `You are the READ-ONLY Playwright user-story reviewer for one agent:ready ticket. Verify the user-facing behaviour in a real browser. You MUST NOT edit application code.

${CONTRACT}

First READ \`${BROWSER_GUIDE}\` in the repo for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. Then:
1. Start the app in the background and capture its URL: \`${DEV_SERVER}\` (wait until it serves).
2. Author a throwaway Playwright spec (reuse the \`${E2E_DIR}\` config + the \`login.spec.ts\` dev-login pattern) driving ISOLATED HEADLESS Chromium with \`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream\`, \`video: 'on'\`, baseURL = the running app.
3. Dev-login as the seeded user matching the ticket, then exercise EACH acceptance-criterion user story, capturing a screenshot per criterion.
4. CLEAN UP before returning: delete the throwaway spec file you authored (and any other source files you created under apps/, libs/, or the repo root). It relies on hand-seeded DB rows and is NOT a maintainable test — it must NOT be committed or left untracked, or the pre-push lint hook (nx affected -t lint) fails on it. Keep ONLY the screenshots/video under the gitignored test-output dir for proofPaths. Then run \`git -C <worktree> status --porcelain\` and confirm it lists ONLY the implementer's committed change set — no untracked *.spec.ts or other new source files. Remove any of your artifacts that remain.
5. Return: criteria (criterion + pass + screenshot path), blockingFindings (one per broken user story — a failed criterion is BLOCKING, include the screenshot), proofPaths (screenshots + video), notes (e.g. console errors). "Couldn't verify" counts as a failed criterion, not a pass. Set "area" to "playwright".`;
}

// ── run ───────────────────────────────────────────────────────────────────────
phase('Triage');
log(`Triaging ${ISSUE}`);
const triage = await agent(triagePrompt(), {
  label: `triage:${ISSUE}`,
  phase: 'Triage',
  model: 'sonnet',
  schema: TRIAGE_SCHEMA,
});

if (!triage) {
  return { issueId: ISSUE, escalate: true, tier: 'escalate', reason: 'triage agent failed', shipped: false };
}

if (triage.tier === 'escalate') {
  log(`${ISSUE}: triage → escalate. ${triage.reason}`);
  return { issueId: ISSUE, escalate: true, tier: 'escalate', reason: triage.reason, shipped: false };
}

const TIER = triage.tier; // 'trivial' | 'standard'

phase('Implement');
log(`Implementing ${ISSUE} (tier: ${TIER})`);
const impl = await agent(implPrompt(TIER, triage.whereToLook), {
  label: `impl:${ISSUE}`,
  phase: 'Implement',
  model: 'opus',
  schema: IMPL_SCHEMA,
});

if (!impl) {
  return { issueId: ISSUE, escalate: false, tier: TIER, reason: 'implementation agent failed', shipped: false };
}

let changedFiles = impl.changedFiles || [];
const userFacing = impl.userFacingImpact !== false || triage.userFacing === true;
const declaredAreas = [...new Set([...(impl.touchedAreas || []), ...(triage.touchedAreas || [])])];
let diffStat = impl.diffStat || '';
const carriedNotes = [...(impl.notes || [])];
const playwrightProof = [];

// ── Review (scaled by tier) ──────────────────────────────────────────────────
// trivial → baseline reviewer only, no Playwright.
// standard → baseline + diff-matched area reviewers (+ Playwright if user-facing).
phase('Review');
const areas = TIER === 'trivial' ? [] : selectAreas(AREA_COMPILED, changedFiles, declaredAreas);
const runPlaywright = TIER === 'standard' && userFacing;
const reviewersRun = ['baseline', ...areas, ...(runPlaywright ? ['playwright'] : [])];
log(`${ISSUE}: reviewers = ${reviewersRun.join(', ')}`);

const thunks = [
  () =>
    agent(reviewerPrompt('baseline', BASELINE), {
      label: 'review:baseline',
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    }),
];
for (const area of areas) {
  thunks.push(() =>
    agent(reviewerPrompt(area, REVIEWERS[area]), {
      label: `review:${area}`,
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    }),
  );
}
if (runPlaywright) {
  thunks.push(() =>
    agent(playwrightPrompt(), {
      label: 'review:playwright',
      phase: 'Review',
      model: 'sonnet',
      schema: PLAYWRIGHT_SCHEMA,
    }),
  );
}

const reviews = (await parallel(thunks)).filter(Boolean);
for (const r of reviews) {
  if (r.proofPaths) playwrightProof.push(...r.proofPaths);
  if (r.notes) carriedNotes.push(...r.notes.map((n) => `[${r.area}] ${n}`));
}
const blocking = reviews.flatMap((r) => (r.blockingFindings || []).map((f) => ({ ...f, area: r.area })));

// ── Fix (at most ONE round — the cap-1 the loop is built around) ─────────────
let fixedCount = 0;
let testsGreen = impl.testsGreen !== false;
if (blocking.length > 0) {
  const feedback = blocking
    .map(
      (f, i) =>
        `${i + 1}. [${f.area}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n   ${f.detail}${f.suggestedFix ? `\n   Suggested fix: ${f.suggestedFix}` : ''}`,
    )
    .join('\n');

  phase('Fix');
  log(`${ISSUE}: ${blocking.length} blocking finding(s) — single Opus fix round.`);
  const fix = await agent(fixPrompt(feedback), {
    label: `fix:${ISSUE}`,
    phase: 'Fix',
    model: 'opus',
    schema: IMPL_SCHEMA,
  });
  if (fix) {
    fixedCount = blocking.length;
    changedFiles = fix.changedFiles || changedFiles;
    diffStat = fix.diffStat || diffStat;
    testsGreen = fix.testsGreen !== false;
    if (fix.notes) carriedNotes.push(...fix.notes);
  } else {
    // Fix agent died — carry the findings out as residual notes; don't loop.
    carriedNotes.push(
      ...blocking.map((f) => `[unresolved:${f.area}] ${f.title} — ${f.detail}`),
    );
  }
}
// Cap is 1: we do NOT re-review after the fix. The draft PR is where the human
// verifies — residual/judgement-call points ride out as notes, not another loop.

return {
  issueId: ISSUE,
  escalate: false,
  tier: TIER,
  triageReason: triage.reason,
  summary: impl.summary,
  shipped: (impl.committed !== false) && testsGreen,
  testsGreen,
  diffStat,
  reviewersRun,
  blockingFound: blocking.length,
  fixedCount,
  notes: [...new Set(carriedNotes)], // judgement-call / agent-flagged points for the PR comment, deduped
  playwrightProof,
};
