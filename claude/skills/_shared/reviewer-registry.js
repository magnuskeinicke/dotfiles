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
