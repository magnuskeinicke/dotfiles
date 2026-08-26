export const meta = {
  name: 'work-slice-loop',
  description:
    'Implement one PRD slice (Opus, TDD), loop targeted reviewers in parallel ⇄ fixes to a 5-round cap, then run a dedicated Playwright user-story loop (max 3) on user-facing changes. Returns a structured summary for the human gate.',
  phases: [
    { title: 'Implement', detail: 'Opus agent, test-first per acceptance criterion', model: 'opus' },
    { title: 'Review', detail: 'baseline + diff-matched web/server lanes + reuse reviewer in parallel (Sonnet)', model: 'sonnet' },
    { title: 'Fix', detail: 'Opus resolves all blocking findings test-first', model: 'opus' },
    { title: 'Playwright', detail: 'dedicated post-convergence user-story loop (verify ⇄ fix), max 3', model: 'opus' },
  ],
};

// ── args (passed by the main session) ──────────────────────────────────────
// { sliceId, sliceKind, acceptanceCriteria, whereToLook, conventionContract,
//   figma, baseBranch, prdContract, repoConfig }
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
// 'skeleton' (foundation walking skeleton — makes the cross-layer decisions) or
// 'delta' (behaviour delta — mirrors the skeleton, adds ≤1 novel decision).
const SLICE_KIND = A.sliceKind === 'skeleton' ? 'skeleton' : 'delta';
// The slice's "Convention contract" section: exemplar per layer, must-use libs.
const CONVENTION = A.conventionContract ? String(A.conventionContract) : '';
// How implement/fix agents commit. Stacking is gh-stack: branches are plain git
// locally and only linked into the stack at PR time, so plain git commits are
// correct. Overridable via args for a repo whose stack tool wraps commit.
const COMMIT_CMD = A.commitCmd ? String(A.commitCmd) : 'git add -A && git commit -m';
const COMMIT_LINE = `STACKING: commit with \`${COMMIT_CMD} "<msg>"\`. NEVER \`git push\` and never open a PR — the main session owns push/PR/stack linkage after review.`;
const LIB_MAP = CFG.libMap
  ? Object.entries(CFG.libMap)
      .map(([lib, purpose]) => `- ${lib}: ${purpose}`)
      .join('\n')
  : '';
const MAX_ROUNDS = 5;
const PW_MAX_ROUNDS = 3;
const DEV_SERVER = CFG.devServerCommand || 'DEV_LOGIN_ENABLED_SERVER=true pnpm nx portless seranote-web';
const E2E_DIR = CFG.e2eDir || 'apps/seranote-web-e2e/';
const BROWSER_GUIDE = CFG.browserGuidePath || '.claude/skills/dev-loop/browser-guide.md';

// >>> shared:reviewer-registry — generated from claude/skills/_shared/reviewer-registry.js; edit there and run `make skills-shared`
// Shared reviewer registry for the feature-dev workflow scripts
// (work-slice-loop, review-code). Workflow scripts must be
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
    'correctness bugs, missed acceptance criteria, convention/reuse misses, and test quality — NOT style nits. Comment hygiene IS in scope (CLAUDE.md comment rules, not a style nit): flag comments that restate the code, narrate the change, or compensate for an unclear name — the fix is deleting the comment or renaming so the code self-documents; a comment that survives states a non-obvious why in one line. Dead code and leftovers are in scope too: commented-out code, unused exports/params/variables, stray console.log/debug artifacts, and code orphaned by the change itself.',
};

// The reuse/consolidation reviewer — always its OWN agent (never merged into a
// lane), gated on the diff adding OR modifying files, not on paths.
// Verdict split: duplicate-of-existing-lib = BLOCKING (use the lib, delete the
// copy); generalizable-new-code = a `consolidations` entry, never blocking —
// the orchestrator files it as a follow-up ticket instead of letting the slice
// scope-creep into a refactor.
const REUSE = {
  skills: 'CLAUDE.md conventions',
  focus:
    "every function/component/hook/util/type ADDED by the diff — in new files OR added to modified files: search libs/** and the design system for an existing equivalent BEFORE accepting it (use repoConfig.libMap as the search index when provided). An equivalent exists → BLOCKING finding: use it and delete the copy. New code that is genuinely generalizable → a `consolidations` entry naming the target lib — NOT a blocking finding. Also DRY within the change itself (added AND modified files): the same logic/markup/query shape repeated across the diff → BLOCKING when a small local helper/component would remove it, a `consolidations` entry when the extraction is big enough to be follow-up work. Only flag real duplication (same reason to change) — never force an abstraction over incidental similarity. Also YAGNI/speculative abstraction: options/params/config no call site passes, wrapper layers with a single caller, generality no current caller needs → BLOCKING when the fix is inlining/deleting the speculation; a note when debatable. Also audit the implementer's provenance table: every added file must cite a real `mirroredFrom` exemplar (verify it exists and is actually mirrored) or an explicit `deviation` reason — a missing, false, or hand-wavy row is a BLOCKING finding.",
};

// The CodeRabbit reviewer — wraps the CodeRabbit CLI (`coderabbit review
// --agent`) as one extra reviewer agent. It runs ONCE per workflow run, in the
// FIRST reviewer round only (rate-limited external service; one round of
// external signal is enough) — fix rounds re-run only our own lanes. The
// wrapper agent verifies CodeRabbit's findings against the actual code before
// reporting, so hallucinated or stale findings don't enter the fix loop.
function coderabbitPrompt(contractText, crCmd) {
  return `You are the CodeRabbit reviewer for this change — a READ-ONLY wrapper around the CodeRabbit CLI. You MUST NOT edit any files — only report.

${contractText}

Run the CodeRabbit CLI review via Bash (long-running — use a generous timeout, up to 10 minutes):
\`${crCmd}\`

Then translate its output into the structured report:
- VERIFY each CodeRabbit finding against the actual code (open the cited file/line) before reporting it — drop anything that does not hold up.
- blockingFindings: verified correctness bugs, security vulnerabilities, data-loss/race/resource-leak risks, or broken error handling. Each with title, file, line, detail, and a concrete suggestedFix.
- notes: style/naming/docs/nit-level suggestions worth a human glance — never blocking.
- If the CLI is missing, unauthenticated, rate-limited, or errors out: return an empty blockingFindings array plus a single note "CodeRabbit CLI unavailable: <reason>". Do NOT fall back to reviewing the code yourself — the other reviewer lanes cover that.
Set "area" to "coderabbit". Do not pad findings to look productive — empty arrays are the correct result for a clean run.`;
}

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

// ── prompt builders ──────────────────────────────────────────────────────────
const CONTRACT = `Slice: ${SLICE}
Base branch: ${BASE}

WORKING DIRECTORY: operate in the CURRENT working directory — the slice's branch is already checked out in this worktree. Do NOT create a worktree, switch branches, or cd elsewhere; run every file edit, git, and pnpm/nx command here and commit on the current branch.
${COMMIT_LINE}
Acceptance criteria:
${AC}
${PRD ? `\nParent PRD contract:\n${PRD}` : ''}
${CONVENTION ? `\nConvention contract (BINDING — the named exemplars/libs are not advisory):\n${CONVENTION}` : ''}`;

function implPrompt(round, feedback) {
  if (round === 0) {
    const kindGuidance =
      SLICE_KIND === 'skeleton'
        ? `This is the stack's WALKING SKELETON: the full end-to-end path with the REAL contract (schema, types, API shape, UI shell, one happy-path behaviour, tests wired) and stubbed/minimal behaviour elsewhere. Every cross-layer decision lands HERE — downstream delta slices mirror this code, so its shape IS the feature's convention. Clone the exemplar's shape from the convention contract / "Where to look"; do not invent structure an exemplar already settles.`
        : `This is a BEHAVIOUR DELTA on the stack's walking skeleton: the skeleton (this feature's own earlier slices, already on the base branch) is the primary pattern to mirror — sibling features are the fallback. Prefer APPENDING onto the skeleton (new handler branch, new component, new test) over modifying it, and introduce at most the one novel decision the slice ticket names.`;
    return `You are the implementer for one PRD slice. Implement it TEST-FIRST.

${CONTRACT}

${kindGuidance}

Where to look (starting map — mirror it): ${WHERE}
${FIGMA ? `\nDesign (fetch the screenshot fresh via the Figma MCP from this node; reuse design-system tokens/components, no magic numbers):\n${FIGMA}` : ''}
${LIB_MAP ? `\nExisting libs (check here BEFORE writing any new helper/util/component):\n${LIB_MAP}` : ''}

Rules:
- One tracer-bullet test → impl per acceptance criterion (vertical slice — never all-tests-then-all-impl).
- Follow CLAUDE.md and the relevant repo skills. The convention contract's exemplars are BINDING: mirror them; a deviation is allowed only when declared in the provenance table with a concrete reason — silent deviation is a review-blocking offence.
- NO new helper/util/hook/component without first searching libs/** (and the design system) for an existing equivalent. Found one → use it.
- Consolidation scope: extracting shared code into a lib is in-scope ONLY when it stays within this slice's own new code plus at most ONE existing call site. Anything wider → record it in notes as a consolidation candidate; do not refactor other features in this slice.
- Stay strictly inside THIS slice's scope. If you find it needs something a later slice owns, record it in notes — do not pull future work forward.${SLICE_KIND === 'delta' ? "\n- CONTRACT FREEZE: never alter the skeleton's published contract (schema, types, API shape). If this delta genuinely requires a contract change, STOP implementing that part and record it in notes as a contract-freeze violation for the human — the stack needs restructuring, not a quiet edit." : ''}
- Run the slice's tests + lint/typecheck with \`pnpm nx\` before finishing and make them PASS. Set testsGreen=true ONLY if you ran them in THIS session and saw them pass — never assume or claim green without running. Report the exact commands + final summary lines in testEvidence.
- Commit with \`${COMMIT_CMD} "<slice-id> …"\` (message starts with the slice id). Never \`git push\`.

Return the structured result: summary, committed, changedFiles (run \`git diff --name-only ${BASE}...HEAD\`), addedFiles (\`git diff --name-only --diff-filter=A ${BASE}...HEAD\`), provenance (one row per added file: mirroredFrom = the exemplar you actually followed, or deviation = why none fits — never both blank), touchedAreas (declare security/performance explicitly when relevant), userFacingImpact (bias true), testsGreen, testEvidence (commands + summary lines), diffStat (\`git diff --stat ${BASE}...HEAD\`), notes.`;
  }
  return `You are the implementer. A review round found BLOCKING problems. Resolve every one of them TEST-FIRST (RED→GREEN where behaviour changes). Do not address style nits or out-of-scope items.

If a finding is FACTUALLY WRONG, do not code around it — return it in \`disputed\` with concrete evidence (file:line, test output, spec text). Dispute only what you can prove; when torn, fix. Everything not disputed must be resolved. Disputed findings go to the human on the PR, not back into the loop.

${CONTRACT}

Blocking findings to resolve:
${feedback}

Rules: stay in slice scope; the convention contract's exemplars stay BINDING (declare any deviation in provenance, never silently); no new helper without a libs/** search; run tests + lint/typecheck with \`pnpm nx\` and make them PASS (testsGreen=true only if you ran them THIS session and saw them pass — report commands + summary lines in testEvidence); commit with \`${COMMIT_CMD} "<slice-id> …"\` (never \`git push\`).
Return the structured result (same shape as before) — recompute changedFiles/addedFiles/provenance/touchedAreas/userFacingImpact/diffStat vs ${BASE} (whole slice, not just this fix).`;
}

function fmtHistory(findingLog) {
  if (!findingLog.length) return '';
  const lines = findingLog.map((f) => `- [${f.status}] (${f.area}) ${f.title}`).join('\n');
  return `

Prior review rounds already flagged these findings (status shown):
${lines}
- "fixed": verify the fix where it falls in your focus — re-raise ONLY if it is demonstrably wrong or incomplete.
- "disputed": do NOT re-raise — the implementer rejected it with evidence; the human adjudicates it on the PR.
Beyond that, report only NEW problems introduced by the fix diff. Do not sweep for fresh nitpicks in code that already passed earlier rounds.`;
}

function reviewerPrompt(area, def, history) {
  return `You are an INDEPENDENT, READ-ONLY reviewer for the "${area}" scope of one PRD slice. You MUST NOT edit any files — only report.

${CONTRACT}

Inspect the slice diff with \`git diff ${BASE}...HEAD\` (and read surrounding files as needed).
Apply the conventions from the ${def.skills} skill(s) — consult them via the Skill tool if available, otherwise apply their known rules.
Focus on: ${def.focus}${history || ''}

Report ONLY:
- blockingFindings: correctness bugs, missed acceptance criteria, or convention/reuse violations in YOUR scope. Each with title, file, line, detail, and a concrete suggestedFix. If none, return an empty array.
- notes: judgement-call / debatable points that should NOT block.
Set "area" to "${area}". Do not invent problems to look productive — an empty blockingFindings array is the correct result for clean code.`;
}

function reusePrompt(addedFiles, changedFiles, provenance, history) {
  const modified = changedFiles.filter((f) => !addedFiles.includes(f));
  const provRows = (provenance || [])
    .map((p) => `- ${p.file} → ${p.mirroredFrom ? `mirrors ${p.mirroredFrom}` : `[deviation: ${p.deviation || 'MISSING'}]`}`)
    .join('\n');
  return `You are the INDEPENDENT, READ-ONLY reuse/consolidation reviewer for one PRD slice. You MUST NOT edit any files — only report.

${CONTRACT}

Files ADDED by this slice (inspect them via \`git diff ${BASE}...HEAD\`):
${addedFiles.length ? addedFiles.map((f) => `- ${f}`).join('\n') : '(none)'}

Files MODIFIED by this slice (in scope for intra-diff DRY + YAGNI):
${modified.length ? modified.map((f) => `- ${f}`).join('\n') : '(none)'}

Provenance the implementer attested (VERIFY it — open each cited exemplar and check the file actually mirrors it):
${provRows || (addedFiles.length ? '(none attested — every added file above is missing a provenance row: that is a blocking finding per file)' : '(no added files — nothing to audit)')}
${LIB_MAP ? `\nExisting libs (search index for equivalents):\n${LIB_MAP}` : ''}

Focus on: ${REUSE.focus}${history || ''}

Report ONLY:
- blockingFindings: (a) an added function/component/hook/util/type that duplicates an existing lib/design-system equivalent — name the equivalent, the fix is "use it, delete the copy"; (b) the same logic repeated within the diff where a small local helper would remove it; (c) a provenance row that is missing, cites a non-existent exemplar, or claims a mirror the code visibly doesn't follow. Each with title, file, line, detail, concrete suggestedFix.
- consolidations: genuinely generalizable NEW code that belongs in an existing lib as follow-up work — title, detail (what + which call sites would adopt it), targetLib. NEVER put these in blockingFindings; they become follow-up tickets, not slice scope.
- notes: judgement-call points that should not block.
Set "area" to "reuse". Do not invent problems to look productive — empty arrays are the correct result for clean code.`;
}

function playwrightPrompt(priorFailures) {
  const prior = (priorFailures || []).length
    ? `

A prior Playwright round failed these criteria (the implementer has since shipped a fix — verify them extra closely, and still re-run ALL criteria to catch regressions):
${priorFailures.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `You are the READ-ONLY Playwright user-story reviewer for one PRD slice. Verify the slice's user-facing behaviour in a real browser. You MUST NOT edit application code.

${CONTRACT}${prior}

First READ \`${BROWSER_GUIDE}\` in the repo for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. Then:
1. Start the app in the background and capture its URL: \`${DEV_SERVER}\` (wait until it serves).
2. Author a throwaway Playwright spec (reuse the \`${E2E_DIR}\` config + the \`login.spec.ts\` dev-login pattern) driving ISOLATED HEADLESS Chromium with \`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream\`, \`video: 'on'\`, baseURL = the running app.
3. Dev-login as the seeded user matching the slice, then exercise EACH acceptance-criterion user story. Capture a screenshot for EVERY criterion — PASS and FAIL alike — under the gitignored test-output dir, named \`ac-<n>-<pass|fail>.png\`. These are QA evidence: they get uploaded to the ticket after the run, so each screenshot must actually show the behaviour it proves (or the breakage), plus keep the run video.
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
let addedFiles = impl.addedFiles || [];
let provenance = impl.provenance || [];
let userFacing = impl.userFacingImpact !== false; // default to running Playwright when unsure
let declaredAreas = impl.touchedAreas || [];
let diffStat = impl.diffStat || '';
let testsGreen = impl.testsGreen !== false;
const carriedNotes = [...(impl.notes || [])];
const consolidations = []; // reuse reviewer's follow-up-ticket candidates, accumulated across rounds
const playwrightProof = [];
const reviewersPerRound = [];
const findingLog = []; // cross-round memory: {round, area, title, status: fixed|disputed}
let playwrightCriteria = [];
let outstanding = [];

// ── Phase 1: code review ⇄ fix loop (baseline + area reviewers, NO Playwright) ──
let reviewConverged = false;
let reviewRound = 0;

for (reviewRound = 1; reviewRound <= MAX_ROUNDS; reviewRound++) {
  // Tests gate: reviewers never see red code. A red round spends its iteration
  // on a dedicated tests-fix pass instead of reviewers, and counts against the cap.
  if (!testsGreen) {
    reviewersPerRound.push({ round: reviewRound, reviewers: ['tests-gate'] });
    if (reviewRound === MAX_ROUNDS) {
      outstanding = [TESTS_GATE_FINDING];
      log(`Hit ${MAX_ROUNDS}-round review cap with tests still red — escalating to human.`);
      break;
    }
    phase('Fix');
    log(`Review round ${reviewRound}: tests not green — tests-fix pass before any reviewer runs.`);
    const fix = await agent(implPrompt(reviewRound, fmtFeedback([TESTS_GATE_FINDING])), {
      label: `tests-fix:r${reviewRound}`,
      phase: 'Fix',
      model: 'opus',
      schema: IMPL_SCHEMA,
    });
    if (!fix) {
      outstanding = [TESTS_GATE_FINDING];
      log(`Tests-fix agent failed on review round ${reviewRound} — escalating.`);
      break;
    }
    changedFiles = fix.changedFiles || changedFiles;
    addedFiles = fix.addedFiles || addedFiles;
    provenance = fix.provenance || provenance;
    declaredAreas = fix.touchedAreas || declaredAreas;
    userFacing = fix.userFacingImpact !== false;
    diffStat = fix.diffStat || diffStat;
    testsGreen = fix.testsGreen !== false;
    if (fix.notes) carriedNotes.push(...fix.notes);
    phase('Review');
    continue;
  }

  const areas = selectAreas(AREA_COMPILED, changedFiles, declaredAreas);
  const laneEntries = groupAreasByLane(areas);
  const runReuse = changedFiles.length + addedFiles.length > 0; // reuse gates on the slice adding OR modifying files
  const ran = [
    'baseline',
    ...laneEntries.map(([lane, members]) => `${lane}[${members.join('+')}]`),
    ...(runReuse ? ['reuse'] : []),
  ];
  reviewersPerRound.push({ round: reviewRound, reviewers: ran });
  log(`Review round ${reviewRound}: reviewers = ${ran.join(', ')}`);

  const history = fmtHistory(findingLog);
  const thunks = [
    () =>
      agent(reviewerPrompt('baseline', BASELINE, history), {
        label: `review:baseline`,
        phase: 'Review',
        model: 'sonnet',
        schema: FINDINGS_SCHEMA,
      }),
  ];
  for (const [lane, members] of laneEntries) {
    thunks.push(() =>
      agent(reviewerPrompt(lane, laneDef(members), history), {
        label: `review:${lane}`,
        phase: 'Review',
        model: 'sonnet',
        schema: FINDINGS_SCHEMA,
      }),
    );
  }
  if (runReuse) {
    thunks.push(() =>
      agent(reusePrompt(addedFiles, changedFiles, provenance, history), {
        label: 'review:reuse',
        phase: 'Review',
        model: 'sonnet',
        schema: FINDINGS_SCHEMA,
      }),
    );
  }

  const reviews = (await parallel(thunks)).filter(Boolean);

  for (const r of reviews) {
    if (r.notes) carriedNotes.push(...r.notes.map((n) => `[${r.area}] ${n}`));
    if (r.consolidations) consolidations.push(...r.consolidations);
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
  const disputedTitles = new Set((fix.disputed || []).map((d) => d.title));
  for (const f of blocking) {
    findingLog.push({
      round: reviewRound,
      area: f.area,
      title: f.title,
      status: disputedTitles.has(f.title) ? 'disputed' : 'fixed',
    });
  }
  for (const d of fix.disputed || []) {
    carriedNotes.push(`[disputed:${d.area || '?'}] ${d.title} — ${d.evidence}`);
  }
  changedFiles = fix.changedFiles || [];
  addedFiles = fix.addedFiles || addedFiles;
  provenance = fix.provenance || provenance;
  declaredAreas = fix.touchedAreas || [];
  userFacing = fix.userFacingImpact !== false;
  diffStat = fix.diffStat || diffStat;
  testsGreen = fix.testsGreen !== false;
  if (fix.notes) carriedNotes.push(...fix.notes);
  phase('Review');
}

// ── Phase 2: dedicated Playwright user-story loop ⇄ fix, capped at PW_MAX_ROUNDS.
//    Runs ONLY after the code-review loop converged AND the change is user-facing
//    (skip pure refactors / internal utils / no-behaviour-change migrations). ──
let playwrightRan = false;
let playwrightConverged = false;
let playwrightRound = 0;

let pwPriorFailures = [];
if (reviewConverged && userFacing) {
  playwrightRan = true;
  for (playwrightRound = 1; playwrightRound <= PW_MAX_ROUNDS; playwrightRound++) {
    // Same tests gate: never verify red code — spend the round making tests pass.
    if (!testsGreen) {
      if (playwrightRound === PW_MAX_ROUNDS) {
        outstanding = [...outstanding, TESTS_GATE_FINDING];
        log(`Hit ${PW_MAX_ROUNDS}-round Playwright cap with tests still red — escalating to human.`);
        break;
      }
      phase('Fix');
      log(`Playwright round ${playwrightRound}: tests not green — tests-fix pass before verifying.`);
      const fix = await agent(implPrompt(playwrightRound, fmtFeedback([TESTS_GATE_FINDING])), {
        label: `pw-tests-fix:r${playwrightRound}`,
        phase: 'Fix',
        model: 'opus',
        schema: IMPL_SCHEMA,
      });
      if (!fix) {
        outstanding = [...outstanding, TESTS_GATE_FINDING];
        log(`Tests-fix agent failed on Playwright round ${playwrightRound} — escalating.`);
        break;
      }
      changedFiles = fix.changedFiles || changedFiles;
      addedFiles = fix.addedFiles || addedFiles;
      provenance = fix.provenance || provenance;
      declaredAreas = fix.touchedAreas || declaredAreas;
      diffStat = fix.diffStat || diffStat;
      testsGreen = fix.testsGreen !== false;
      if (fix.notes) carriedNotes.push(...fix.notes);
      continue;
    }

    phase('Playwright');
    log(`Playwright round ${playwrightRound}: verifying user-facing behaviour.`);
    const pw = await agent(playwrightPrompt(pwPriorFailures), {
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
    if (pw.criteria) playwrightCriteria = pw.criteria; // last round's per-AC verdicts = the QA evidence table
    if (pw.notes) carriedNotes.push(...pw.notes.map((n) => `[playwright] ${n}`));

    const blocking = (pw.blockingFindings || []).map((f) => ({ ...f, area: 'playwright' }));
    pwPriorFailures = blocking.map((f) => f.title);

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
    for (const d of fix.disputed || []) {
      carriedNotes.push(`[disputed:playwright] ${d.title} — ${d.evidence}`);
    }
    changedFiles = fix.changedFiles || [];
    addedFiles = fix.addedFiles || addedFiles;
    provenance = fix.provenance || provenance;
    declaredAreas = fix.touchedAreas || [];
    userFacing = fix.userFacingImpact !== false;
    diffStat = fix.diffStat || diffStat;
    testsGreen = fix.testsGreen !== false;
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
  testsGreen,
  notes: [...new Set(carriedNotes)], // judgement-call + disputed points for the human, deduped
  provenance, // final attested provenance table (added file → mirroredFrom | deviation) — goes on the PR
  consolidations: [...new Map(consolidations.map((c) => [c.title, c])).values()], // reuse follow-up candidates, deduped by title — the orchestrator files these as tickets
  diffStat,
  playwrightProof,
  playwrightCriteria, // last round's per-AC PASS/FAIL + screenshot paths — the QA evidence table
};
