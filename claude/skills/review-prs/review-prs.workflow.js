export const meta = {
  name: 'review-prs-loop',
  description:
    'Review ONE open PR (targeting development, CI green) on behalf of the user. FRESH mode: fan out diff-matched reviewers + a quality reviewer (+ an acceptance browser reviewer when the change is user-navigable and has clear testing guidelines) and return findings. RE-REVIEW mode: assess each of the user\'s own earlier review threads against the new commits and return a resolve | reply | nothing decision per thread. Returns structured data — the orchestrator posts to GitHub.',
  phases: [
    { title: 'Review', detail: 'FRESH: baseline + matched area reviewers + quality (+ acceptance if relevant), in parallel', model: 'sonnet' },
    { title: 'Re-review', detail: 'one assessor per prior thread → resolve | reply | nothing', model: 'sonnet' },
  ],
};

// ── args (passed by the skill, one PR per call) ──────────────────────────────
// The Workflow runtime can deliver `args` as a JSON *string* — normalise it.
let A = args || {};
if (typeof A === 'string') {
  try {
    A = JSON.parse(A);
  } catch {
    A = {};
  }
}
A = A || {};

const NUMBER = A.number;
const TITLE = A.title ? String(A.title) : '';
const REPO = A.repo || ''; // "owner/name"
const BASE = A.baseBranch || 'development';
const MODE = A.mode === 're-review' ? 're-review' : 'fresh';
const IS_OWN = A.isOwnPr === true;
const ISSUE = A.issueId ? String(A.issueId) : '';
const HEAD_SHA = A.headSha ? String(A.headSha) : '';
const WORKTREE = A.worktree ? String(A.worktree) : '';
const RUN_AC = A.runAcBrowser === true;
const CHANGED = Array.isArray(A.changedFiles) ? A.changedFiles : [];
const DECLARED = Array.isArray(A.declaredAreas) ? A.declaredAreas : [];
const THREADS = Array.isArray(A.reviewThreads) ? A.reviewThreads : [];
const AC = Array.isArray(A.acceptanceCriteria)
  ? A.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
  : String(A.acceptanceCriteria || '(no explicit acceptance criteria on the linked ticket)');
const CHECKLIST = A.testingChecklist ? String(A.testingChecklist) : '(no testing checklist found)';

// ── reviewer registry: area → anchor skill(s) + review focus ────────────────
// (shared shape with solve-ready-loop / work-slice-loop)
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

// ── deterministic path → area mapping (unioned with declared areas) ─────────
function pathAreas(files) {
  const set = new Set();
  for (const f of files || []) {
    if (/^libs\/ui\/web\//.test(f) || /^apps\/seranote-web\/.*\.tsx$/.test(f) || /\.stories\.tsx$/.test(f))
      set.add('frontend');
    if (/^libs\/backend\//.test(f)) set.add('backend');
    if (
      /^drizzle\//.test(f) ||
      /libs\/backend\/db\/.*schemas\//.test(f) ||
      /\/relations\//.test(f) ||
      /drizzle\.config\.ts$/.test(f)
    )
      set.add('database');
    if (/apps\/seranote-web\/src\/i18n\//.test(f) || /(^|\/)en\.json$/.test(f)) set.add('i18n');
    if (/^libs\/backend\/actions\//.test(f) || /auth/i.test(f) || /\.env/.test(f)) set.add('security');
  }
  return set;
}

function selectAreas(changedFiles, declaredAreas) {
  const set = pathAreas(changedFiles);
  for (const a of declaredAreas || []) if (KNOWN_AREAS.includes(a)) set.add(a);
  return [...set];
}

// ── schemas ─────────────────────────────────────────────────────────────────
const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    file: { type: 'string', description: 'Repo-relative path, exactly as it appears in the diff.' },
    line: {
      type: 'number',
      description:
        'Line number in the NEW (right) version of the file — the line an inline review comment attaches to. This is the END line of the anchored range (or the only line for a single-line finding). It MUST be a line the PR adds or changes (a "+" or context line inside a diff hunk), so the comment can attach inline. Omit only if the finding genuinely is not anchored to any changed line.',
    },
    startLine: {
      type: 'number',
      description:
        'OPTIONAL. When the problem spans a block of lines, the FIRST new-side line of that block (with `line` as the last). Both must be changed/context lines inside the same diff hunk. Omit for a single-line finding.',
    },
    detail: { type: 'string' },
    suggestion: { type: 'string', description: 'A concrete fix the author can act on.' },
    blocking: {
      type: 'boolean',
      description:
        'true = a correctness bug, missed acceptance criterion, or convention/reuse violation that should block (drives REQUEST_CHANGES on other people\'s PRs). false = a non-blocking suggestion / quality nit.',
    },
  },
  required: ['title', 'detail', 'blocking'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    notes: { type: 'array', items: { type: 'string' }, description: 'Judgement-call / debatable points; never block.' },
  },
  required: ['area', 'findings', 'notes'],
};

const ACCEPTANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    ran: { type: 'boolean', description: 'false if the app could not be exercised — then every criterion is a fail.' },
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
    findings: { type: 'array', items: FINDING },
    proofPaths: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['area', 'ran', 'criteria', 'findings', 'notes'],
};

const THREAD_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    threadId: { type: 'string', description: 'Echo back the GraphQL thread node id you were given.' },
    decision: {
      type: 'string',
      enum: ['resolve', 'reply', 'nothing'],
      description:
        'resolve = the comment was addressed (code changed to match, OR author defended it convincingly in a reply) → close the thread. reply = partially/incorrectly addressed, or the new commits touched this code but the comment still stands → post a follow-up in the thread. nothing = nothing was done about this comment and the relevant code was not touched → leave it untouched.',
    },
    reason: { type: 'string', description: 'One or two sentences: what the author did (or did not do) and why this decision.' },
    replyBody: {
      type: 'string',
      description: 'Required only when decision = reply. The follow-up comment text to post in the thread. Empty otherwise.',
    },
  },
  required: ['threadId', 'decision', 'reason'],
};

// ── prompt builders ──────────────────────────────────────────────────────────
const CONTRACT = `Pull request: #${NUMBER}${TITLE ? ` — ${TITLE}` : ''}  (repo ${REPO})
Base branch: ${BASE}${ISSUE ? `
Linked Linear ticket: ${ISSUE}` : ''}
This PR is ${IS_OWN ? "the user's OWN PR (a self-review)" : "another author's PR — the user is a requested reviewer"}.

How to read the change (you are READ-ONLY — never edit, commit, or push):
- The full diff against ${BASE} is \`gh pr diff ${NUMBER}\`.
- The changed files are: ${CHANGED.length ? CHANGED.join(', ') : '(see the diff)'}.
- You may read any file in the current checkout for surrounding context (it is on ${BASE}); the diff shows what the PR adds/changes on top of it.
- When you report a finding anchored to a line, use the line number in the NEW (right) side of the diff so it can become an inline review comment.

Acceptance criteria (from the linked ticket):
${AC}`;

function reviewerPrompt(area, def) {
  return `You are an INDEPENDENT, READ-ONLY reviewer for the "${area}" area of one pull request. You MUST NOT edit any files — only report.

${CONTRACT}

Inspect the diff with \`gh pr diff ${NUMBER}\` (and read surrounding files as needed).
Apply the conventions from the ${def.skills} skill — consult it via the Skill tool if available, otherwise apply its known rules.
Focus on: ${def.focus}

Report ONLY findings in YOUR area:
- findings: each with title, file, line (new-side), detail, a concrete suggestion, and "blocking". Set blocking=true for a correctness bug, a missed acceptance criterion, or a clear convention/reuse violation; blocking=false for a non-blocking suggestion. If the area is clean, return an empty array.
- Every finding gets posted as its OWN inline review comment anchored to the code, so "line" MUST be a line the PR adds or changes (a "+" or context line inside a diff hunk) — pick the most relevant changed line, never an unchanged line far from the edit. If the problem spans a block, set "startLine" (first new-side line) and "line" (last); both inside one hunk. Only omit line when the finding truly cannot be tied to a changed line.
- notes: judgement-call / debatable points that should never block.
Set "area" to "${area}". Do not invent problems to look productive — an empty findings array is the correct result for clean code.`;
}

function qualityPrompt() {
  return `You are an INDEPENDENT, READ-ONLY QUALITY reviewer for one pull request. You review code QUALITY, not functionality — correctness is another reviewer's job. You MUST NOT edit any files.

${CONTRACT}

Inspect the diff with \`gh pr diff ${NUMBER}\`. Then look OUTWARD into the repo (grep/glob/read) to judge the change in context. Hunt specifically for:
- DRY violations: logic, components, hooks, types, constants, or queries the diff (re)implements that ALREADY exist elsewhere in the repo and should have been reused or extracted. Name the existing thing (file:line) the PR duplicates.
- Simplification: code that can be shorter/flatter/clearer — dead branches, redundant state, needless abstraction or indirection, over-engineering for a case that does not exist, conditions that collapse.
- Best practice / idiom: does it match how the surrounding codebase already does this? Follow CLAUDE.md (named functions not top-level arrows, error-as-value, @vtt/* aliases for cross-lib imports, self-documenting names over comments, type vs interface). Flag drift from established patterns.

These are QUALITY findings — set blocking=false on all of them (they advise, they do not block the merge). For each: title, file, line (new-side), detail (and for DRY, the existing code it duplicates), and a concrete suggestion. Each becomes its own inline comment, so "line" MUST be a changed/context line inside a diff hunk (use "startLine"+"line" for a block); omit line only when it truly cannot be anchored. Skip pure formatting (Prettier owns that). An empty findings array is the correct result for clean, idiomatic code. Set "area" to "quality".`;
}

function acceptancePrompt() {
  return `You are the READ-ONLY acceptance reviewer for one pull request. Verify the PR's user-facing behaviour against the linked ticket's acceptance criteria AND testing checklist, in a real browser. You MUST NOT edit application code.

${CONTRACT}

The PR branch has already been checked out for you in a git worktree: ${WORKTREE || '(the current checkout)'}. \`cd\` into it before doing anything — the running app must be the PR's code, not ${BASE}.

Testing checklist (from the Linear ticket's "## Test plan" and/or the PR body — uphold every item that is user-navigable):
${CHECKLIST}

First READ \`.claude/skills/dev-loop/browser-guide.md\` in the repo for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. Then:
1. Start the app in the background and capture its URL: \`DEV_LOGIN_ENABLED_SERVER=true pnpm nx portless seranote-web\` (wait until it serves).
2. Author a throwaway Playwright spec (reuse the \`apps/seranote-web-e2e/\` config + the \`login.spec.ts\` dev-login pattern) driving ISOLATED HEADLESS Chromium with \`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream\`, \`video: 'on'\`, baseURL = the running app.
3. Dev-login as the seeded user matching the ticket, then exercise EACH acceptance criterion and each user-navigable testing-checklist item, capturing a screenshot per item.
4. CLEAN UP before returning: delete the throwaway spec file you authored (and any other source files you created under apps/, libs/, or the repo root). It relies on hand-seeded DB rows and is NOT a maintainable test — it must NOT be committed or left untracked, or the pre-push lint hook (nx affected -t lint) fails on it. Keep ONLY the screenshots/video under the gitignored test-output dir for proofPaths. Then run \`git -C ${WORKTREE || '<worktree>'} status --porcelain\` and confirm it lists ONLY the PR author's committed change set — no untracked *.spec.ts or other new source files. Remove any of your artifacts that remain.
5. Return: ran (true if you actually exercised the app), criteria (criterion + pass + screenshot path), findings (one BLOCKING finding per broken criterion/checklist item — include the screenshot path in detail), proofPaths (screenshots + video), notes (e.g. console errors). "Couldn't verify" counts as a failed criterion, not a pass. Set "area" to "acceptance".`;
}

function threadAssessorPrompt(t) {
  const replies = (t.replies || [])
    .map((r) => `  - @${r.author}: ${r.body}`)
    .join('\n');
  return `You are RE-REVIEWING one of the user's earlier review comments on a pull request, to decide what to do with the thread now that new commits have landed. You are READ-ONLY on application code; you only decide the thread's fate.

${CONTRACT}

The thread you are assessing (the user left this comment in an earlier review):
- Thread id: ${t.threadId}
- File: ${t.path}${t.line ? `:${t.line}` : ''}
- The user's comment: "${t.body}"
- The user's review was made at commit ${t.reviewCommitId}; the PR head is now ${HEAD_SHA}.
- Replies so far in the thread:
${replies || '  (none)'}

Determine whether the author addressed this specific comment since the review:
1. First make the commits available locally: \`git fetch origin pull/${NUMBER}/head\` (read-only fetch — do not check anything out).
2. See what changed in the flagged file since the review: \`git diff ${t.reviewCommitId}..${HEAD_SHA} -- ${t.path}\` (and read surrounding code as needed).
3. Read the thread replies above: the author may have addressed the comment by CHANGING the code to match it, OR by REPLYING to defend the existing code.

Decide ONE of:
- "resolve": the comment was genuinely addressed — the code now matches what was asked, OR the author gave a convincing defence in a reply and the point no longer stands. Close the thread.
- "reply": the comment was only partially/incorrectly addressed, or the new commits touched this code but the original concern still holds, or the author's reply needs a response. Provide replyBody — a short, specific follow-up to post in the thread (reference what they changed/said).
- "nothing": nothing was done about this comment and the relevant code was NOT touched. Leave the thread exactly as it is.

Be conservative: only "resolve" when you are confident it was handled; never resolve a thread just because time passed. Return threadId (echo it back), decision, reason, and replyBody (only for "reply").`;
}

// ── run ───────────────────────────────────────────────────────────────────────
if (!NUMBER) {
  return { error: 'no PR number in args', mode: MODE };
}

if (MODE === 're-review') {
  phase('Re-review');
  if (!THREADS.length) {
    return { number: NUMBER, mode: 're-review', reviewersRun: [], findings: [], threadDecisions: [], summary: 'no open prior threads to assess' };
  }
  log(`#${NUMBER}: re-reviewing ${THREADS.length} prior thread(s)`);
  const decisions = (
    await parallel(
      THREADS.map((t) => () =>
        agent(threadAssessorPrompt(t), {
          label: `assess:#${NUMBER}:${t.path}`,
          phase: 'Re-review',
          model: 'sonnet',
          schema: THREAD_DECISION_SCHEMA,
        }),
      ),
    )
  ).filter(Boolean);
  // Map decisions back to the reply/resolve targets the orchestrator needs.
  const byId = {};
  for (const t of THREADS) byId[t.threadId] = t;
  const threadDecisions = decisions.map((d) => {
    const t = byId[d.threadId] || {};
    return {
      threadId: d.threadId,
      decision: d.decision,
      reason: d.reason,
      replyBody: d.replyBody || '',
      path: t.path,
      commentId: t.commentId, // numeric id of the comment to reply to
    };
  });
  const counts = threadDecisions.reduce(
    (acc, d) => ((acc[d.decision] = (acc[d.decision] || 0) + 1), acc),
    {},
  );
  return {
    number: NUMBER,
    mode: 're-review',
    reviewersRun: ['thread-assessor'],
    findings: [],
    threadDecisions,
    summary: `assessed ${threadDecisions.length} thread(s): ${counts.resolve || 0} resolve, ${counts.reply || 0} reply, ${counts.nothing || 0} nothing`,
  };
}

// ── FRESH review ──────────────────────────────────────────────────────────────
phase('Review');
const areas = selectAreas(CHANGED, DECLARED);
const reviewersRun = ['baseline', ...areas, 'quality', ...(RUN_AC ? ['acceptance'] : [])];
log(`#${NUMBER}: reviewers = ${reviewersRun.join(', ')}`);

const thunks = [
  () =>
    agent(reviewerPrompt('baseline', BASELINE), {
      label: `review:#${NUMBER}:baseline`,
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    }),
];
for (const area of areas) {
  thunks.push(() =>
    agent(reviewerPrompt(area, REVIEWERS[area]), {
      label: `review:#${NUMBER}:${area}`,
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    }),
  );
}
thunks.push(() =>
  agent(qualityPrompt(), {
    label: `review:#${NUMBER}:quality`,
    phase: 'Review',
    model: 'sonnet',
    schema: FINDINGS_SCHEMA,
  }),
);
if (RUN_AC) {
  thunks.push(() =>
    agent(acceptancePrompt(), {
      label: `review:#${NUMBER}:acceptance`,
      phase: 'Review',
      model: 'sonnet',
      schema: ACCEPTANCE_SCHEMA,
    }),
  );
}

const reviews = (await parallel(thunks)).filter(Boolean);

const findings = [];
const notes = [];
let acResult = null;
for (const r of reviews) {
  if (r.area === 'acceptance') {
    acResult = { ran: r.ran, criteria: r.criteria || [], proofPaths: r.proofPaths || [] };
  }
  for (const f of r.findings || []) findings.push({ ...f, area: r.area });
  for (const n of r.notes || []) notes.push(`[${r.area}] ${n}`);
}
const blockingCount = findings.filter((f) => f.blocking).length;

return {
  number: NUMBER,
  mode: 'fresh',
  isOwnPr: IS_OWN,
  reviewersRun,
  findings, // each: { title, file?, line?, startLine?, detail, suggestion?, blocking, area }
  notes,
  acResult,
  blockingCount,
  summary: `${reviewersRun.length} reviewer(s) → ${findings.length} finding(s) (${blockingCount} blocking), ${notes.length} note(s)`,
};
