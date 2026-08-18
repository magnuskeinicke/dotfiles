export const meta = {
  name: 'solve-ready-loop',
  description:
    'Solve one agent:ready ticket, depth-scaled by a triage step: triage → implement (Opus) → review (scaled) → at most one fix round. Lighter than work-slice-loop (no slice/stack framing, cap 1, no human gate). Returns a summary for the draft PR.',
  phases: [
    { title: 'Triage', detail: 'one Sonnet agent sizes the ticket → trivial | standard | escalate', model: 'sonnet' },
    { title: 'Implement', detail: 'Opus agent; TDD for standard, lighter for trivial', model: 'opus' },
    { title: 'Review', detail: 'trivial: baseline only · standard: diff-matched web/server lanes (+ Opus Playwright if user-facing) · reuse reviewer whenever files were added', model: 'sonnet' },
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
const LIB_MAP = CFG.libMap
  ? Object.entries(CFG.libMap)
      .map(([lib, purpose]) => `- ${lib}: ${purpose}`)
      .join('\n')
  : '';

// >>> shared:reviewer-registry — generated from claude/skills/_shared/reviewer-registry.js; edit there and run `make skills-shared`
// Shared reviewer registry for the feature-dev workflow scripts
// (work-slice-loop, solve-ready-loop, review-code). Workflow scripts must be
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
      'the dal/service/action three-layer split, server-action boundaries, cache invalidation, error-as-value (return error objects, never throw), createBaseRepo usage. Plus server performance: N+1 query patterns, sequential awaits where Promise.all fits, over-fetching, query volume on hot paths.',
  },
  database: {
    skills: 'CLAUDE.md DB conventions',
    focus:
      'Drizzle schema/relations correctness, migration generated + sequenced correctly (not hand-renumbered), createBaseRepo query patterns, no OUTER JOINs (prefer INNER or correlated scalar subqueries). Plus query performance: indexes matching new query patterns, join/subquery cost on large tables.',
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
  // client/React lens only — server-side performance (N+1, indexes, over-fetching)
  // is baked into the backend + database focus above, where the queries live.
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

// The reuse/consolidation reviewer — always its OWN agent (never merged into a
// lane), gated on the diff ADDING files (IMPL_SCHEMA.addedFiles), not on paths.
// Verdict split: duplicate-of-existing-lib = BLOCKING (use the lib, delete the
// copy); generalizable-new-code = a `consolidations` entry, never blocking —
// the orchestrator files it as a follow-up ticket instead of letting the slice
// scope-creep into a refactor.
const REUSE = {
  skills: 'CLAUDE.md conventions',
  focus:
    "every ADDED function/component/hook/util/type in the diff: search libs/** and the design system for an existing equivalent BEFORE accepting it (use repoConfig.libMap as the search index when provided). An equivalent exists → BLOCKING finding: use it and delete the copy. New code that is genuinely generalizable → a `consolidations` entry naming the target lib — NOT a blocking finding. Also audit the implementer's provenance table: every added file must cite a real `mirroredFrom` exemplar (verify it exists and is actually mirrored) or an explicit `deviation` reason — a missing, false, or hand-wavy row is a BLOCKING finding.",
};

// Injected by the tests gate: reviewers never see red code. When an implement/
// fix pass reports testsGreen=false, the loop spends the round on fixing this
// instead of running reviewers.
const TESTS_GATE_FINDING = {
  area: 'tests',
  title: 'Tests/lint not green',
  detail:
    'The implementer reported testsGreen=false. Run the affected tests + lint/typecheck with `pnpm nx`, fix every failure until they ACTUALLY pass in this session, and report the commands + final summary lines in testEvidence. Nothing goes to review red.',
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

// Consolidation: triggered areas group into two composite review LANES so a
// round runs at most baseline + 2 reviewers. A lane's prompt merges its
// triggered member areas' skills + focus — same coverage, fewer agents,
// less finding churn.
const AREA_LANES = {
  frontend: 'web',
  i18n: 'web',
  performance: 'web',
  backend: 'server',
  database: 'server',
  security: 'server',
};

// triggered areas → [[lane, memberAreas]]. Defensive enrichment: frontend work
// always gets the performance lens, backend work always the security lens
// (those two areas rarely trigger by path alone).
function groupAreasByLane(areas) {
  const set = new Set(areas);
  if (set.has('frontend')) set.add('performance');
  if (set.has('backend')) set.add('security');
  const lanes = {};
  for (const a of set) {
    const lane = AREA_LANES[a];
    if (!lane) continue;
    (lanes[lane] = lanes[lane] || []).push(a);
  }
  return Object.entries(lanes);
}

// composite reviewer def for a lane's triggered member areas
function laneDef(memberAreas) {
  return {
    skills: [...new Set(memberAreas.flatMap((a) => REVIEWERS[a].skills.split(', ')))].join(', '),
    focus: memberAreas.map((a) => `\n- ${a}: ${REVIEWERS[a].focus}`).join(''),
  };
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'One-line description of what was implemented/fixed.' },
    committed: { type: 'boolean' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths touched.' },
    addedFiles: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Repo-relative paths ADDED vs base (`git diff --name-only --diff-filter=A <base>...HEAD`). Empty array when nothing was added. Gates the reuse reviewer.',
    },
    provenance: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'The added file.' },
          mirroredFrom: { type: 'string', description: 'Exemplar file whose shape this file mirrors.' },
          deviation: {
            type: 'string',
            description: 'Why no exemplar was mirrored — required when mirroredFrom is absent.',
          },
        },
        required: ['file'],
      },
      description:
        'One row per ADDED file: mirroredFrom (the exemplar followed) OR deviation (why none exists/fits). Silent deviation is forbidden — the reuse reviewer blocks on missing or false rows. Empty array when no files were added.',
    },
    touchedAreas: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_AREAS },
      description: 'Semantic areas this change affects (declare security/performance even when paths look neutral).',
    },
    userFacingImpact: {
      type: 'boolean',
      description: 'Does this change plausibly alter user-visible behaviour? Bias toward true when unsure.',
    },
    testsGreen: {
      type: 'boolean',
      description: 'True ONLY if tests + lint/typecheck were RUN in this session and seen passing — never assumed.',
    },
    testEvidence: {
      type: 'string',
      description: 'Exact test/lint commands run this session + their final summary lines. Proof behind testsGreen.',
    },
    disputed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Verbatim title of the finding being disputed.' },
          area: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'Concrete proof the finding is factually wrong (file:line, test output, spec text).',
          },
        },
        required: ['title', 'evidence'],
      },
      description:
        'Findings NOT fixed because they are factually wrong. Dispute only with concrete evidence — when torn, fix instead. Disputed findings go to the human, not back into the loop.',
    },
    diffStat: { type: 'string', description: 'Output of `git diff --stat <base>...HEAD`.' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'committed',
    'changedFiles',
    'addedFiles',
    'provenance',
    'touchedAreas',
    'userFacingImpact',
    'testsGreen',
    'testEvidence',
  ],
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
    consolidations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          detail: {
            type: 'string',
            description: 'What is generalizable, and which existing call sites would adopt it.',
          },
          targetLib: { type: 'string', description: 'The existing lib the code should be consolidated into.' },
        },
        required: ['title', 'detail'],
      },
      description:
        'Reuse reviewer only: generalizable-new-code that belongs in an existing lib as FOLLOW-UP work. Never blocking — the orchestrator files these as tickets, keeping the slice diff small.',
    },
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
- Follow CLAUDE.md and the relevant repo skills (backend-action-service-split, frontend-implementation, i18n, tailwind-predefined-values, sentry-logging, etc.). Mirroring the named sibling is BINDING — a deviation is allowed only when declared in the provenance table with a concrete reason, never silently.
- NO new helper/util/hook/component without first searching libs/** (and the design system) for an existing equivalent. Found one → use it.${LIB_MAP ? `\n  Existing libs (search index):\n${LIB_MAP}` : ''}
- For UI, reuse design-system tokens/components — no magic numbers.
- Run the affected tests + lint/typecheck with \`pnpm nx\` before finishing and make them PASS. Set testsGreen=true ONLY if you ran them in THIS session and saw them pass — never assume or claim green without running. Report the exact commands + final summary lines in testEvidence.
- Commit on the current branch with a message starting with the ticket id (${ISSUE}).

Return the structured result: summary, committed, changedFiles (\`git diff --name-only ${BASE}...HEAD\`), addedFiles (\`git diff --name-only --diff-filter=A ${BASE}...HEAD\`), provenance (one row per added file: mirroredFrom = the exemplar you actually followed, or deviation = why none fits — never both blank), touchedAreas (declare security/performance explicitly when relevant), userFacingImpact (bias true), testsGreen, testEvidence (commands + summary lines), diffStat (\`git diff --stat ${BASE}...HEAD\`), notes.`;
}

function fixPrompt(feedback) {
  return `You are the Opus implementer. A review round found BLOCKING problems. Resolve every one of them TEST-FIRST (RED→GREEN where behaviour changes). Do not address style nits or out-of-scope items, and do not pull in new scope.

If a finding is FACTUALLY WRONG, do not code around it — return it in \`disputed\` with concrete evidence (file:line, test output, spec text). Dispute only what you can prove; when torn, fix. Everything not disputed must be resolved. Disputed findings surface to the human on the draft PR.

${CONTRACT}

Blocking findings to resolve:
${feedback}

Rules: stay in scope; sibling-mirroring stays BINDING (declare any deviation in provenance, never silently); no new helper without a libs/** search; run affected tests + lint/typecheck with \`pnpm nx\` and make them PASS (testsGreen=true only if you ran them THIS session and saw them pass — report commands + summary lines in testEvidence); commit with a message starting with ${ISSUE}.
Return the structured result (same shape as before) — recompute changedFiles/addedFiles/provenance/touchedAreas/userFacingImpact/diffStat vs ${BASE} (whole change, not just this fix).`;
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

function reusePrompt(addedFiles, provenance) {
  const provRows = (provenance || [])
    .map((p) => `- ${p.file} → ${p.mirroredFrom ? `mirrors ${p.mirroredFrom}` : `[deviation: ${p.deviation || 'MISSING'}]`}`)
    .join('\n');
  return `You are the INDEPENDENT, READ-ONLY reuse/consolidation reviewer for one agent:ready ticket. You MUST NOT edit any files — only report.

${CONTRACT}

Files ADDED by this change (your scope — inspect them via \`git diff ${BASE}...HEAD\`):
${addedFiles.map((f) => `- ${f}`).join('\n')}

Provenance the implementer attested (VERIFY it — open each cited exemplar and check the file actually mirrors it):
${provRows || '(none attested — every added file below is missing a provenance row: that is a blocking finding per file)'}
${LIB_MAP ? `\nExisting libs (search index for equivalents):\n${LIB_MAP}` : ''}

Focus on: ${REUSE.focus}

Report ONLY:
- blockingFindings: (a) an added function/component/hook/util/type that duplicates an existing lib/design-system equivalent — name the equivalent, the fix is "use it, delete the copy"; (b) a provenance row that is missing, cites a non-existent exemplar, or claims a mirror the code visibly doesn't follow. Each with title, file, line, detail, concrete suggestedFix.
- consolidations: genuinely generalizable NEW code that belongs in an existing lib as follow-up work — title, detail (what + which call sites would adopt it), targetLib. NEVER put these in blockingFindings; they surface as notes for the human, not in-PR scope.
- notes: judgement-call points that should not block.
Set "area" to "reuse". Do not invent problems to look productive — empty arrays are the correct result for clean code.`;
}

function playwrightPrompt() {
  return `You are the READ-ONLY Playwright user-story reviewer for one agent:ready ticket. Verify the user-facing behaviour in a real browser. You MUST NOT edit application code.

${CONTRACT}

First READ \`${BROWSER_GUIDE}\` in the repo for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. Then:
1. Start the app in the background and capture its URL: \`${DEV_SERVER}\` (wait until it serves).
2. Author a throwaway Playwright spec (reuse the \`${E2E_DIR}\` config + the \`login.spec.ts\` dev-login pattern) driving ISOLATED HEADLESS Chromium with \`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream\`, \`video: 'on'\`, baseURL = the running app.
3. Dev-login as the seeded user matching the ticket, then exercise EACH acceptance-criterion user story. Capture a screenshot for EVERY criterion — PASS and FAIL alike — under the gitignored test-output dir, named \`ac-<n>-<pass|fail>.png\`. These are QA evidence: they get uploaded to the ticket after the run, so each screenshot must actually show the behaviour it proves (or the breakage), plus keep the run video.
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
let addedFiles = impl.addedFiles || [];
let provenance = impl.provenance || [];
const userFacing = impl.userFacingImpact !== false || triage.userFacing === true;
const declaredAreas = [...new Set([...(impl.touchedAreas || []), ...(triage.touchedAreas || [])])];
let diffStat = impl.diffStat || '';
const carriedNotes = [...(impl.notes || [])];
const consolidations = []; // reuse reviewer's follow-up candidates for the human
const playwrightProof = [];

// ── Tests gate: reviewers never see red code ─────────────────────────────────
// One dedicated tests-fix pass; if still red after it, skip review entirely and
// hand back to the human — the orchestrator surfaces testsGreen=false on the PR.
let testsGreen = impl.testsGreen !== false;
if (!testsGreen) {
  phase('Fix');
  log(`${ISSUE}: tests not green after implementation — tests-fix pass before review.`);
  const tf = await agent(
    fixPrompt(`1. [${TESTS_GATE_FINDING.area}] ${TESTS_GATE_FINDING.title}\n   ${TESTS_GATE_FINDING.detail}`),
    { label: `tests-fix:${ISSUE}`, phase: 'Fix', model: 'opus', schema: IMPL_SCHEMA },
  );
  if (tf) {
    changedFiles = tf.changedFiles || changedFiles;
    addedFiles = tf.addedFiles || addedFiles;
    provenance = tf.provenance || provenance;
    diffStat = tf.diffStat || diffStat;
    testsGreen = tf.testsGreen !== false;
    if (tf.notes) carriedNotes.push(...tf.notes);
  }
  if (!testsGreen) {
    carriedNotes.push('[tests] Still red after a dedicated tests-fix pass — review skipped, shipped=false for human triage.');
    return {
      issueId: ISSUE,
      escalate: false,
      tier: TIER,
      triageReason: triage.reason,
      summary: impl.summary,
      shipped: false,
      testsGreen: false,
      diffStat,
      reviewersRun: [],
      blockingFound: 0,
      fixedCount: 0,
      notes: [...new Set(carriedNotes)],
      provenance,
      consolidations: [],
      playwrightProof,
      playwrightCriteria: [],
    };
  }
}

// ── Review (scaled by tier) ──────────────────────────────────────────────────
// trivial → baseline reviewer only, no Playwright.
// standard → baseline + diff-matched area reviewers (+ Playwright if user-facing).
phase('Review');
const areas = TIER === 'trivial' ? [] : selectAreas(AREA_COMPILED, changedFiles, declaredAreas);
const laneEntries = TIER === 'trivial' ? [] : groupAreasByLane(areas);
const runPlaywright = TIER === 'standard' && userFacing;
const runReuse = addedFiles.length > 0; // both tiers — an ADDED file always earns the reuse check
const reviewersRun = [
  'baseline',
  ...laneEntries.map(([lane, members]) => `${lane}[${members.join('+')}]`),
  ...(runReuse ? ['reuse'] : []),
  ...(runPlaywright ? ['playwright'] : []),
];
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
for (const [lane, members] of laneEntries) {
  thunks.push(() =>
    agent(reviewerPrompt(lane, laneDef(members)), {
      label: `review:${lane}`,
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    }),
  );
}
if (runReuse) {
  thunks.push(() =>
    agent(reusePrompt(addedFiles, provenance), {
      label: 'review:reuse',
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
      model: 'opus',
      schema: PLAYWRIGHT_SCHEMA,
    }),
  );
}

const reviews = (await parallel(thunks)).filter(Boolean);
let playwrightCriteria = [];
for (const r of reviews) {
  if (r.proofPaths) playwrightProof.push(...r.proofPaths);
  if (r.criteria) playwrightCriteria = r.criteria; // per-AC verdicts from the Playwright reviewer = QA evidence
  if (r.notes) carriedNotes.push(...r.notes.map((n) => `[${r.area}] ${n}`));
  if (r.consolidations) consolidations.push(...r.consolidations);
}
const blocking = reviews.flatMap((r) => (r.blockingFindings || []).map((f) => ({ ...f, area: r.area })));

// ── Fix (at most ONE round — the cap-1 the loop is built around) ─────────────
let fixedCount = 0;
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
    const disputed = fix.disputed || [];
    fixedCount = blocking.length - disputed.length;
    for (const d of disputed) {
      carriedNotes.push(`[disputed:${d.area || '?'}] ${d.title} — ${d.evidence}`);
    }
    changedFiles = fix.changedFiles || changedFiles;
    addedFiles = fix.addedFiles || addedFiles;
    provenance = fix.provenance || provenance;
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
  notes: [...new Set(carriedNotes)], // judgement-call / disputed / agent-flagged points for the PR comment, deduped
  provenance, // final attested provenance table (added file → mirroredFrom | deviation) — goes on the PR
  consolidations: [...new Map(consolidations.map((c) => [c.title, c])).values()], // reuse follow-up candidates for the human, deduped by title
  playwrightProof,
  playwrightCriteria, // per-AC PASS/FAIL + screenshot paths — the QA evidence table
};
