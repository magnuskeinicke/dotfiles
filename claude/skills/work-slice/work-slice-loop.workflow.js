export const meta = {
  name: 'work-slice-loop',
  description:
    'Implement one PRD slice (Opus, TDD), loop targeted reviewers in parallel ⇄ fixes to a 5-round cap, then run a dedicated Playwright user-story loop (max 3) on user-facing changes. Returns a structured summary for the human gate.',
  phases: [
    { title: 'Implement', detail: 'Opus agent, test-first per acceptance criterion', model: 'opus' },
    { title: 'Review', detail: 'baseline + diff-matched area reviewers in parallel (Sonnet)', model: 'sonnet' },
    { title: 'Fix', detail: 'Opus resolves all blocking findings test-first', model: 'opus' },
    { title: 'Playwright', detail: 'dedicated post-convergence user-story loop (verify ⇄ fix), max 3', model: 'opus' },
  ],
};

// ── args (passed by the main session) ──────────────────────────────────────
// { sliceId, acceptanceCriteria, whereToLook, figma, baseBranch, prdContract, repoConfig }
// The Workflow runtime can deliver `args` as a JSON *string*, not a parsed
// object — normalise it here so A.sliceId etc. resolve (otherwise every run
// works "(unknown slice)" with no acceptance criteria).
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
const SLICE = A.sliceId || '(unknown slice)';
const BASE = A.baseBranch || CFG.integrationBranch || 'development';
const AC = Array.isArray(A.acceptanceCriteria)
  ? A.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
  : String(A.acceptanceCriteria || '(see slice ticket)');
const WHERE = A.whereToLook ? String(A.whereToLook) : '(none given — discover from the codebase)';
const FIGMA = A.figma ? String(A.figma) : '';
const PRD = A.prdContract ? String(A.prdContract) : '';
const MAX_ROUNDS = 5;
const PW_MAX_ROUNDS = 3;
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

// ── prompt builders ──────────────────────────────────────────────────────────
const CONTRACT = `Slice: ${SLICE}
Base branch: ${BASE}

WORKING DIRECTORY: operate in the CURRENT working directory — the slice's branch is already checked out in this worktree. Do NOT create a worktree, switch branches, or cd elsewhere; run every file edit, git, and pnpm/nx command here and commit on the current branch.
AVIATOR: this repo is av-managed and the branch is already adopted into the stack. Commit with \`av commit -A -m "<msg>"\` — NEVER raw \`git commit\` or \`git push\` (that skips restacking and breaks stack tracking). Do not run \`av pr\`/\`av sync\` — the main session opens the PR after review.
Acceptance criteria:
${AC}
${PRD ? `\nParent PRD contract:\n${PRD}` : ''}`;

function implPrompt(round, feedback) {
  if (round === 0) {
    return `You are the implementer for one PRD slice. Implement it TEST-FIRST.

${CONTRACT}

Where to look (starting map — mirror the named sibling): ${WHERE}
${FIGMA ? `\nDesign (fetch the screenshot fresh via the Figma MCP from this node; reuse design-system tokens/components, no magic numbers):\n${FIGMA}` : ''}

Rules:
- One tracer-bullet test → impl per acceptance criterion (vertical slice — never all-tests-then-all-impl).
- Follow CLAUDE.md and the relevant repo skills.
- Stay strictly inside THIS slice's scope. If you find it needs something a later slice owns, record it in notes — do not pull future work forward.
- Run the slice's tests + lint/typecheck green with \`pnpm nx\` before finishing.
- Commit with \`av commit -A -m "<slice-id> …"\` (message starts with the slice id). Never raw \`git commit\`/\`git push\`.

Return the structured result: summary, committed, changedFiles (run \`git diff --name-only ${BASE}...HEAD\`), touchedAreas (declare security/performance explicitly when relevant), userFacingImpact (bias true), testsGreen, diffStat (\`git diff --stat ${BASE}...HEAD\`), notes.`;
  }
  return `You are the implementer. A review round found BLOCKING problems. Resolve every one of them TEST-FIRST (RED→GREEN where behaviour changes). Do not address style nits or out-of-scope items.

${CONTRACT}

Blocking findings to resolve:
${feedback}

Rules: stay in slice scope; run tests + lint/typecheck green with \`pnpm nx\`; commit with \`av commit -A -m "<slice-id> …"\` (never raw \`git commit\`/\`git push\`).
Return the structured result (same shape as before) — recompute changedFiles/touchedAreas/userFacingImpact/diffStat from THIS fix.`;
}

function reviewerPrompt(area, def) {
  return `You are an INDEPENDENT, READ-ONLY reviewer for the "${area}" area of one PRD slice. You MUST NOT edit any files — only report.

${CONTRACT}

Inspect the slice diff with \`git diff ${BASE}...HEAD\` (and read surrounding files as needed).
Apply the conventions from the ${def.skills} skill — consult it via the Skill tool if available, otherwise apply its known rules.
Focus on: ${def.focus}

Report ONLY:
- blockingFindings: correctness bugs, missed acceptance criteria, or convention/reuse violations in YOUR area. Each with title, file, line, detail, and a concrete suggestedFix. If none, return an empty array.
- notes: judgement-call / debatable points that should NOT block.
Set "area" to "${area}". Do not invent problems to look productive — an empty blockingFindings array is the correct result for clean code.`;
}

function playwrightPrompt() {
  return `You are the READ-ONLY Playwright user-story reviewer for one PRD slice. Verify the slice's user-facing behaviour in a real browser. You MUST NOT edit application code.

${CONTRACT}

First READ \`${BROWSER_GUIDE}\` in the repo for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. Then:
1. Start the app in the background and capture its URL: \`${DEV_SERVER}\` (wait until it serves).
2. Author a throwaway Playwright spec (reuse the \`${E2E_DIR}\` config + the \`login.spec.ts\` dev-login pattern) driving ISOLATED HEADLESS Chromium with \`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream\`, \`video: 'on'\`, baseURL = the running app.
3. Dev-login as the seeded user matching the slice, then exercise EACH acceptance-criterion user story, capturing a screenshot per criterion.
4. CLEAN UP before returning: delete the throwaway spec file you authored (and any other source files you created under apps/, libs/, or the repo root). It relies on hand-seeded DB rows and is NOT a maintainable test — it must NOT be committed or left untracked, or the pre-push lint hook (nx affected -t lint) fails on it. Keep ONLY the screenshots/video under the gitignored test-output dir for proofPaths. Then run \`git status --porcelain\` and confirm it lists ONLY the implementer's committed change set — no untracked *.spec.ts or other new source files. Remove any of your artifacts that remain.
5. Return: criteria (criterion + pass + screenshot path), blockingFindings (one per broken user story — a failed criterion is BLOCKING, include the screenshot), proofPaths (screenshots + video), notes (e.g. console errors). "Couldn't verify" counts as a failed criterion, not a pass. Set "area" to "playwright".`;
}

function fmtFeedback(blocking) {
  return blocking
    .map(
      (f, i) =>
        `${i + 1}. [${f.area}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n   ${f.detail}${f.suggestedFix ? `\n   Suggested fix: ${f.suggestedFix}` : ''}`,
    )
    .join('\n');
}

// ── run ───────────────────────────────────────────────────────────────────────
phase('Implement');
log(`Implementing slice ${SLICE} (base ${BASE})`);
let impl = await agent(implPrompt(0), { label: `impl:${SLICE}`, phase: 'Implement', model: 'opus', schema: IMPL_SCHEMA });

if (!impl) {
  return { sliceId: SLICE, converged: false, reviewRounds: 0, playwrightRounds: 0, error: 'implementation agent failed', outstanding: [], notes: [] };
}

let changedFiles = impl.changedFiles || [];
let userFacing = impl.userFacingImpact !== false; // default to running Playwright when unsure
let declaredAreas = impl.touchedAreas || [];
let diffStat = impl.diffStat || '';
const carriedNotes = [...(impl.notes || [])];
const playwrightProof = [];
const reviewersPerRound = [];
let outstanding = [];

// ── Phase 1: code review ⇄ fix loop (baseline + area reviewers, NO Playwright) ──
let reviewConverged = false;
let reviewRound = 0;

for (reviewRound = 1; reviewRound <= MAX_ROUNDS; reviewRound++) {
  const areas = selectAreas(AREA_COMPILED, changedFiles, declaredAreas);
  const ran = ['baseline', ...areas];
  reviewersPerRound.push({ round: reviewRound, reviewers: ran });
  log(`Review round ${reviewRound}: reviewers = ${ran.join(', ')}`);

  const thunks = [
    () =>
      agent(reviewerPrompt('baseline', BASELINE), {
        label: `review:baseline`,
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

  const reviews = (await parallel(thunks)).filter(Boolean);

  for (const r of reviews) {
    if (r.notes) carriedNotes.push(...r.notes.map((n) => `[${r.area}] ${n}`));
  }
  const blocking = reviews.flatMap((r) =>
    (r.blockingFindings || []).map((f) => ({ ...f, area: r.area })),
  );

  if (blocking.length === 0) {
    reviewConverged = true;
    log(`Review round ${reviewRound}: no blocking findings — converged.`);
    break;
  }

  if (reviewRound === MAX_ROUNDS) {
    outstanding = blocking;
    log(`Hit ${MAX_ROUNDS}-round review cap with ${blocking.length} blocking finding(s) unresolved — escalating to human.`);
    break;
  }

  phase('Fix');
  log(`Review round ${reviewRound}: ${blocking.length} blocking finding(s) — fix pass.`);
  const fix = await agent(implPrompt(reviewRound, fmtFeedback(blocking)), {
    label: `fix:r${reviewRound}`,
    phase: 'Fix',
    model: 'opus',
    schema: IMPL_SCHEMA,
  });
  if (!fix) {
    outstanding = blocking;
    log(`Fix agent failed on review round ${reviewRound} — escalating with the unresolved findings.`);
    break;
  }
  changedFiles = fix.changedFiles || [];
  declaredAreas = fix.touchedAreas || [];
  userFacing = fix.userFacingImpact !== false;
  diffStat = fix.diffStat || diffStat;
  if (fix.notes) carriedNotes.push(...fix.notes);
  phase('Review');
}

// ── Phase 2: dedicated Playwright user-story loop ⇄ fix, capped at PW_MAX_ROUNDS.
//    Runs ONLY after the code-review loop converged AND the change is user-facing
//    (skip pure refactors / internal utils / no-behaviour-change migrations). ──
let playwrightRan = false;
let playwrightConverged = false;
let playwrightRound = 0;

if (reviewConverged && userFacing) {
  playwrightRan = true;
  for (playwrightRound = 1; playwrightRound <= PW_MAX_ROUNDS; playwrightRound++) {
    phase('Playwright');
    log(`Playwright round ${playwrightRound}: verifying user-facing behaviour.`);
    const pw = await agent(playwrightPrompt(), {
      label: `playwright:r${playwrightRound}`,
      phase: 'Playwright',
      model: 'opus',
      schema: PLAYWRIGHT_SCHEMA,
    });

    if (!pw) {
      log(`Playwright reviewer failed on round ${playwrightRound} — stopping Playwright loop.`);
      break;
    }
    if (pw.proofPaths) playwrightProof.push(...pw.proofPaths);
    if (pw.notes) carriedNotes.push(...pw.notes.map((n) => `[playwright] ${n}`));

    const blocking = (pw.blockingFindings || []).map((f) => ({ ...f, area: 'playwright' }));

    if (blocking.length === 0) {
      playwrightConverged = true;
      log(`Playwright round ${playwrightRound}: all user stories pass — converged.`);
      break;
    }

    if (playwrightRound === PW_MAX_ROUNDS) {
      outstanding = [...outstanding, ...blocking];
      log(`Hit ${PW_MAX_ROUNDS}-round Playwright cap with ${blocking.length} broken user story(ies) — escalating to human.`);
      break;
    }

    phase('Fix');
    log(`Playwright round ${playwrightRound}: ${blocking.length} broken user story(ies) — fix pass.`);
    const fix = await agent(implPrompt(playwrightRound, fmtFeedback(blocking)), {
      label: `pw-fix:r${playwrightRound}`,
      phase: 'Fix',
      model: 'opus',
      schema: IMPL_SCHEMA,
    });
    if (!fix) {
      outstanding = [...outstanding, ...blocking];
      log(`Fix agent failed on Playwright round ${playwrightRound} — escalating with the unresolved findings.`);
      break;
    }
    changedFiles = fix.changedFiles || [];
    declaredAreas = fix.touchedAreas || [];
    userFacing = fix.userFacingImpact !== false;
    diffStat = fix.diffStat || diffStat;
    if (fix.notes) carriedNotes.push(...fix.notes);
  }
}

const converged = reviewConverged && (!playwrightRan || playwrightConverged);

return {
  sliceId: SLICE,
  baseBranch: BASE,
  summary: impl.summary,
  converged,
  hitCap: !converged && outstanding.length > 0,
  reviewConverged,
  reviewRounds: reviewRound > MAX_ROUNDS ? MAX_ROUNDS : reviewRound,
  playwrightRan,
  playwrightConverged,
  playwrightRounds: playwrightRan ? (playwrightRound > PW_MAX_ROUNDS ? PW_MAX_ROUNDS : playwrightRound) : 0,
  reviewersPerRound,
  outstanding, // blocking findings still unresolved if either cap was hit
  notes: [...new Set(carriedNotes)], // judgement-call points for the human, deduped
  diffStat,
  playwrightProof,
};
