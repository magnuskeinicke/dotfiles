---
name: review-prs
description: >
  Sweep the open GitHub PRs I'm involved in and review them on my behalf. Scope
  is strictly: PRs I authored, OR other people's PRs where a review is *currently
  requested of me* (a request I've already submitted on — and not been
  re-requested — falls out of scope). Only PRs targeting `development`, and only
  PRs whose CI has finished and is green — never review failing or in-flight CI.
  For a PR I haven't reviewed yet it runs a full review (baseline + diff-matched
  area reviewers + a quality reviewer, plus an acceptance browser reviewer when
  the change is user-navigable and the ticket has clear testing guidelines). For
  a PR I reviewed before and that has new commits since, it walks each of my
  earlier review threads and decides per thread: resolve it, reply again, or
  leave it. Posts as REQUEST_CHANGES on other people's PRs with blocking findings
  (COMMENT otherwise); my own PRs are always COMMENT. Use when I say "review my
  PRs", "review my open PRs", "go through the PRs awaiting my review", "run the
  PR reviewer", or `/review-prs`. Defaults to a read-only dry run; only posts to
  GitHub on `apply`.
argument-hint: "[dry-run|apply] [max N]"
---

# Review PRs

Reviews the open PRs I'm involved in — sibling to `solve-ready-tickets` and
`work-slice`, and built to run unattended on a schedule. It is a **PR reviewer**,
not an implementer: it reads diffs, runs reviewers, and posts reviews / replies /
thread resolutions. It never writes application code.

Read `~/.claude/docs/agents/issue-tracker.md` (workspace ids, `SER-XX` ↔ PR-title
linkage, `development` is the integration branch, the `## Test plan` lives on the
Linear issue). If it's missing, run `/setup-matt-pocock-skills`.

This skill **never** approves a PR, merges, closes, or toggles draft/ready. Its
only mutations are: posting one review (event `COMMENT` or `REQUEST_CHANGES`),
replying in a thread, and resolving a thread. Everything else is my call.

## Mode — dry-run is the default

Parse the argument for the run mode (mirrors `solve-ready-tickets`):

- **`dry-run`** (default, and the default whenever the mode is absent or
  ambiguous) — discover the PRs, run the reviewers, and report exactly what
  *would* be posted (the review body + inline comments, and each thread's
  resolve / reply / nothing decision). **Post nothing to GitHub.** Note: unlike
  `solve-ready` dry-run, this one *does* run the reviewer agents — that's what
  produces the preview.
- **`apply`** — do the same, then actually post: the review, the thread replies,
  and the thread resolutions.

`max N` caps how many PRs one run reviews (default **10**, oldest-updated first).
Running unattended (scheduled / non-interactive), never block on input: if a
prerequisite is missing or a PR turns ambiguous, record it, skip the PR, and move
on. Treat an unattended run as `dry-run` unless the schedule prompt says `apply`.

## Step 0 — Preconditions

- `gh auth status` must be authenticated. Capture the repo as `owner/name`
  (`gh repo view --json nameWithOwner -q .nameWithOwner`).
- Capture my GitHub login: `gh api user -q .login` → `ME`.

## Step 1 — Discover candidate PRs

Two queries, both scoped to this repo, base `development`, open:

```
# PRs I authored
gh pr list --state open --base development --author "@me" --limit 100 \
  --json number,title,headRefName,headRefOid,isDraft,updatedAt,author

# PRs where a review is requested of me (request still pending)
gh pr list --state open --base development --search "review-requested:@me" --limit 100 \
  --json number,title,headRefName,headRefOid,isDraft,updatedAt,author
```

The `review-requested:@me` search is the scope gate for other people's PRs: once
I submit a review GitHub clears the request, so a PR I've already reviewed only
reappears here if the author **re-requested** me after pushing changes. That is
exactly the "requested → submitted → don't review again (unless re-requested)"
rule — it falls out of the query, no extra bookkeeping.

Merge the two lists (dedupe by number). Mark each PR `isOwnPr = author.login === ME`.

## Step 2 — Gate each candidate (drop with a reason)

Drop a PR — and record why — if any of these fail. **Never review a PR that
fails a gate.**

1. **Base branch.** Must target `development`. (The `--base development` filter
   handles it; re-confirm from `gh pr view <n> --json baseRefName`.)
2. **CI finished and green.** Fetch the rollup:
   `gh pr view <n> --json statusCheckRollup`.
   - Any check still `IN_PROGRESS` / `QUEUED` / `PENDING` (or a pending commit
     status state) → **skip, "CI unfinished"**.
   - Any check `conclusion` of `FAILURE` / `TIMED_OUT` / `CANCELLED` / `ACTION_REQUIRED`,
     or a `FAILURE`/`ERROR` commit status → **skip, "CI failing"**.
   - All checks `COMPLETED` + `SUCCESS`/`NEUTRAL`/`SKIPPED` → green, proceed. If
     there are **no** checks at all, treat as green but note "no CI on this PR".
3. (Other people's PRs only) review still requested of me — guaranteed by the
   Step 1 query; no extra check.

## Step 3 — Classify FRESH vs RE-REVIEW

For each surviving PR, look at my prior reviews and the commit timeline:

```
# my reviews on this PR, newest last; each carries the head SHA it was made on
gh api repos/<owner>/<repo>/pulls/<n>/reviews --paginate \
  --jq '[.[] | select(.user.login=="'"$ME"'") | {state, submitted_at, commit_id}]'

# current head + last commit time
gh pr view <n> --json headRefOid,commits \
  --jq '{head: .headRefOid, lastCommit: (.commits | last | .committedDate)}'
```

- **No prior review by me** → **FRESH**.
- **Prior review exists**, and my latest review's `commit_id` **equals** the
  current head → **SKIP, "already reviewed this head"** (no new commits — the
  request/submit cycle is done).
- **Prior review exists** and there are **new commits since** my latest review
  (head SHA differs / `lastCommit` is after my `submitted_at`) → **RE-REVIEW**.
  Capture my latest review's `commit_id` as `reviewCommitId`.

This branch is symmetric for my own PRs: the first run self-reviews (FRESH);
later runs, after I push more commits, RE-REVIEW my own earlier self-review
threads.

## Step 4 — Resolve the Linear ticket, testing guidelines, and review areas

For each PR (both modes need the changed files; FRESH needs the rest):

1. **Changed files:** `gh pr view <n> --json files -q '.files[].path'`.
2. **Linear ticket:** extract `SER-\d+` from the PR title. If present, Linear MCP
   `get_issue` → read the description, the **acceptance criteria** (checkboxes),
   and the **`## Test plan`** section. Also scan the PR body for a testing
   checklist. (No `SER-XX`, or ticket not found → note it; review with no AC.)
3. **Acceptance-browser relevance (`runAcBrowser`).** Set it **true only when
   both** hold:
   - the change is **user-navigable** — the changed files touch the web UI / app
     routes (frontend area present, `apps/seranote-web/**`, etc.), AND
   - there are **clear testing guidelines** to check against — real acceptance
     criteria and/or a `## Test plan` / PR checklist describing steps a user can
     drive in the browser.

   Otherwise **omit it** (back-end-only change, no AC, nothing user-navigable).
   This acceptance reviewer *is* the browser/playwright reviewer — there is no
   separate one, and the two are never both run.

**FRESH only — prepare a worktree when `runAcBrowser`:** the acceptance reviewer
runs the PR's code, so check the PR branch out into its own worktree off the PR
head (never the main checkout):

```
git fetch origin pull/<n>/head
git worktree add /tmp/review-prs/pr-<n> <headRefOid>
```

Pass that absolute path as `worktree`. (No worktree needed for any other
reviewer — they read `gh pr diff <n>` + the `development` checkout.)

**RE-REVIEW only — collect my open prior threads** via GraphQL (REST can't read
thread resolution state or resolve threads):

```
gh api graphql -f query='
query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$n){
      reviewThreads(first:100){ nodes{
        id isResolved isOutdated path line
        comments(first:1){ nodes{ databaseId author{login} body } }
      }}
    }
  }
}' -F owner=<owner> -F repo=<repo> -F n=<n>
```

Keep threads where `isResolved == false` and the **first comment's author == ME**
(my own review threads). For each, also pull the full reply list
(`comments(first:50)`) so the assessor can see whether the author defended the
code. Build `reviewThreads[]` of `{ threadId, path, line, body, commentId
(first comment databaseId, for replies), replies:[{author,body}], reviewCommitId }`.

## Step 5 — Run the review workflow (one call per PR)

Sort the survivors oldest-`updatedAt` first, take the first **N**, and for each
invoke the workflow — the sanctioned Workflow opt-in. The workflow owns all
reviewing; the orchestrator does no code analysis itself.

```
Workflow({
  scriptPath: "~/.claude/skills/review-prs/review-prs.workflow.js",
  args: {
    number, title, repo: "<owner>/<name>", baseBranch: "development",
    mode,                 // "fresh" | "re-review"
    isOwnPr,              // boolean
    issueId,              // "SER-1234" or ""
    headSha,              // current head oid
    changedFiles,         // string[]
    declaredAreas: [],    // optional extra areas
    acceptanceCriteria,   // array or string (FRESH)
    testingChecklist,     // "## Test plan" + PR checklist text (FRESH)
    runAcBrowser,         // boolean (FRESH)
    worktree,             // abs path if runAcBrowser, else ""
    reviewThreads,        // [] for FRESH; the thread list for RE-REVIEW
  }
})
```

It returns a compact result — read it, don't pull agent logs into context:

- **FRESH** → `{ findings[], notes[], acResult, blockingCount, reviewersRun }`.
  Each finding: `{ title, file?, line?, startLine?, detail, suggestion?, blocking, area }`
  (`line` is the new-side anchor line; `startLine` is set when the finding spans a
  block — it's the first line, `line` the last).
- **RE-REVIEW** → `{ threadDecisions[] }`, each `{ threadId, decision:
  resolve|reply|nothing, reason, replyBody, path, commentId }`.

## Step 6 — Post (apply only; dry-run reports the same as "would …")

### FRESH → one review, **one inline comment per finding**

The goal is a normal-looking review: **every finding is its own inline comment
anchored to the code it's about** — like a human reviewer leaving a remark on a
line. The review **body stays thin** (a one-line header + the few things that
genuinely can't anchor). Never collapse the findings into one big body comment —
that's the behaviour we're moving away from.

**6a — idempotency recheck (apply only).** Just before posting, re-query my
reviews on this PR — a concurrent/earlier run may have posted since discovery:

```
gh api repos/<owner>/<repo>/pulls/<n>/reviews --paginate \
  --jq '[.[] | select(.user.login=="'"$ME"'") | .commit_id]'
```

If any of my review `commit_id`s equals `headSha`, **skip posting** and record
"already reviewed this head (posted by a concurrent run)". This closes the race
where two runs both discovered "no prior review" before either posted.

**6b — which findings can be inline.** A GitHub review is rejected **whole** (422)
if any inline comment points at a line that isn't in the diff. So split the
findings against the lines the diff actually exposes:

```
# the (path, new-side line) pairs an inline comment may attach to —
# added "+" lines and context lines on the RIGHT side of each hunk
gh pr diff <n> --patch
```

Parse the hunk headers (`@@ -a,b +c,d @@`): walk each hunk counting new-side
lines, and collect every line that is `+` or context (not `-`). A finding is
**anchorable** when its `file` + `line` (and `startLine`, if present) all fall in
that set. Everything else is an **orphan**.

**6c — build the inline `comments[]`** from the anchorable findings, one entry
each:

```jsonc
{ "path": "<file>", "line": <line>, "side": "RIGHT",
  // block finding: add the range (omit both for single-line)
  "start_line": <startLine>, "start_side": "RIGHT",
  "body": "**[<area>] <title>** — <detail>\n<suggestion>" }
```

- Prefix the body with `⚠️` for a blocking finding, `💡` for a non-blocking one,
  so severity reads at a glance.
- When the suggestion is a concrete drop-in replacement, render it as a
  ` ```suggestion ` block so the author can commit it in one click.
- Omit `start_line`/`start_side` unless the finding has a `startLine` (and it
  differs from `line`).

**6d — build a thin body.** Only:
- a one-line header: `## review-prs · <N> inline comment(s)` (+ `· M blocking`),
- **orphan findings** (no `file`/`line`, or line not in the diff) as a short
  bullet list — name the `file:line` in text so they're still actionable,
- `notes` as a short "Non-blocking notes" list,
- the acceptance pass/fail table + proof paths if the acceptance reviewer ran,
- the `<sub>🤖 review-prs · <run context></sub>` footer.

If there are no orphans, no notes and no acceptance table, the body is just the
header line. Never restate the inline findings in the body.

**6e — event.**
- **My own PR → always `COMMENT`.**
- **Someone else's PR → `REQUEST_CHANGES` when `blockingCount > 0`, else
  `COMMENT`.** Never `APPROVE`.

**6f — post** (write the payload to a temp JSON file — inline `comments` arrays
don't go through `-f` cleanly):

```
gh api repos/<owner>/<repo>/pulls/<n>/reviews --input /tmp/review-prs/review-<n>.json
# payload: { "commit_id": "<headSha>", "event": "<EVENT>", "body": "<thin body>",
#            "comments": [ { "path","line","side":"RIGHT"[,"start_line","start_side"],"body" }, ... ] }
```

Pin `commit_id` to `headSha` so the inline lines anchor to the reviewed commit.
If GitHub still rejects with a 422 on a comment line, drop that comment to an
orphan bullet in the body and retry once — never let one bad anchor sink the
whole review.

### RE-REVIEW → per-thread action

For each `threadDecision`:
- **`resolve`** → `gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=<threadId>`
- **`reply`** → `gh api repos/<owner>/<repo>/pulls/<n>/comments/<commentId>/replies -f body='<replyBody>'`
- **`nothing`** → no-op.

Never resolve a thread the assessor didn't mark `resolve`; never invent replies.

## Step 7 — Report

End every run (any mode) with a compact summary:

```md
# Review PRs — Mode: dry-run | apply   ·   In scope: <n>   ·   Reviewed: <k of N>

| PR    | Title        | Mine? | Mode       | Action                                   |
| ----- | ------------ | ----- | ---------- | ---------------------------------------- |
| #2412 | <short>      | mine  | fresh      | COMMENT · 3 inline                        |
| #2399 | <short>      | —     | fresh      | REQUEST_CHANGES · 5 inline (2 blocking)   |
| #2381 | <short>      | —     | re-review  | 2 resolved · 1 replied · 1 left           |

Count the inline comments, not the body. If any findings landed in the body as
orphans (line not in the diff), note it: `COMMENT · 4 inline · 1 in body`.

## Skipped
- #2405 — CI unfinished
- #2390 — CI failing
- #2377 — already reviewed this head (no new commits)
- #2350 — already reviewed this head (posted by a concurrent run)
- #2360 — base is `release/x`, not development

## Notes
- worktrees created/cleaned, missing SER links, acceptance reviewer omitted (not user-navigable), prerequisites missing
```

In `dry-run`, the Action column shows what *would* be posted (event + comment
count, or the resolve/reply/nothing tally); nothing is sent.

**Clean up** any worktrees created in Step 4: `git worktree remove --force
/tmp/review-prs/pr-<n>` for each, after its workflow returns.

## Safety rules

- Default to `dry-run`. Post to GitHub only on `apply`.
- **Only PRs targeting `development`.** Drop anything else.
- **Never review a PR whose CI is failing or unfinished.** Green + complete only.
- **Other people's PRs only while a review is actively requested of me.** Never
  post on a PR where the request was already submitted and not re-requested
  (the Step 1 query enforces this) — and never re-post on a head I've already
  reviewed.
- **Event policy:** `REQUEST_CHANGES` only on *other people's* PRs with blocking
  findings; `COMMENT` otherwise; **my own PRs are always `COMMENT`**. Never
  `APPROVE`, merge, close, mark ready, or convert to draft.
- RE-REVIEW only touches **my own** earlier threads, and only acts as the
  assessor decided (resolve / reply / nothing) — it never opens new threads or
  re-reviews unrelated code.
- The orchestrator does no code analysis: all reviewing lives in the workflow
  (Step 5). Read summaries, not logs.
- One worktree per acceptance-reviewed PR, off the PR head, removed after — never
  work in my active checkout. Scrub throwaway specs (the pre-push lint hook fails
  on untracked source).
- A PR that errors mid-review is recorded and skipped — never crash the whole run.
- An empty scope is a valid result — report "no PRs to review" and stop.

## Scheduling

Built to run unattended (e.g. a few times a day, or after CI tends to settle).
The schedule prompt must be self-contained: name the scope (`PRs I author or am
requested to review, base development, CI green`), the batch size (`max N`), and
the mutation policy (`apply` to post, `dry-run` to just preview). Default a
scheduled run to `dry-run` unless I've explicitly approved `apply`. A scheduled
`apply` run still only ever posts a review, replies in my threads, and resolves
my threads — never approving, merging, closing, or changing PR state.
