---
name: solve-ready-tickets
description: >
  The autonomous-loop solver. Scans the Linear queue for tickets that
  daily-ticket-manager stamped `agent:ready` (assigned to me, Seranote team,
  status `Ready for dev - backlog`), claims them, and drives each to a DRAFT
  pull request for my review — implementing inside a difficulty-scaled
  workflow. Drains up to N tickets per run (default N=3, oldest first). Never
  merges, never marks an issue done, never runs compliance — the draft PR is
  the human review gate. Use when I say "solve my ready tickets", "run the
  autonomous solver", "pick up the agent:ready tickets", "work the agent-ready
  queue", or run `/solve-ready-tickets`. Built to run unattended on a schedule.
  Defaults to a read-only dry run; only claims/implements/opens PRs on `apply`.
argument-hint: "[dry-run|apply] [max N]"
---

# Solve Ready Tickets

The **autonomous-loop solver** — the counterpart to `daily-ticket-manager`.
That skill *triages* my queue and stamps `agent:ready` on the small, low-risk,
single-PR work an unattended agent can safely take. This skill is the loop that
*scans `agent:ready`, picks the work up, solves it, and opens a draft PR* for me
to review. The two are a producer/consumer pair joined by the `agent:ready`
label.

Read `~/.claude/docs/agents/issue-tracker.md` (workspace ids, how to fetch /
claim / link issues), `~/.claude/docs/agents/triage-labels.md` (`agent:ready`
is **the autonomous-loop trigger**, owned by `daily-ticket-manager`; the
additive label-write rule), and `~/.claude/docs/agents/repo-config.md` (the
repo-specific values passed to the workflow as `repoConfig`). If the first two
are missing, run `/setup-matt-pocock-skills`; if `repo-config.md` is missing,
the workflow falls back to its built-in Seranote defaults.

This skill **never** marks an issue done, merges, approves, or runs compliance.
Its terminal state is a **draft PR + a summary comment**. Every output gets human
eyes before it goes anywhere.

## Mode — dry-run is the default

Parse the argument for the run mode (mirrors `daily-ticket-manager`):

- **`dry-run`** (default, and the default whenever the mode is absent or
  ambiguous) — select the queue, report which tickets *would* be picked up and
  in what order. **Mutate nothing**: no label changes, no status changes, no
  branches, no PRs, no workflow runs.
- **`apply`** — do everything: claim, branch, run the solve workflow, open the
  draft PR, comment.

`max N` sets how many tickets one run drains (default **3**). Running unattended
(scheduled / non-interactive), never block on input: if a prerequisite is
missing or a ticket turns ambiguous, record it, leave the ticket flagged for a
human, and move to the next. Treat an unattended run as `dry-run` unless the
schedule prompt explicitly says `apply`.

## Step 1 — Select the queue

Scope is **my `agent:ready` tickets queued to start**:

`list_issues` with `assignee: "me"`, `team: "Seranote"`,
`state: "Ready for dev - backlog"`, `label: "agent:ready"`, `limit: 100`.

> Seranote team id `eb39f46c-0d31-4bd0-ae65-c7a42b51b889`.
> `Ready for dev - backlog` = `7a4368ec-5dd4-450b-ad94-baf40fdbe8d1`,
> `Dev in progress` = `6acecef1-b46e-4677-9248-2a478e136dff`. Match by name; fall
> back to these ids if names have drifted.

Then **drop**, in this order:

1. Any ticket carrying **`manager:skip`** — PRD-pipeline-owned, never autonomous.
   (`daily-ticket-manager` should never have stamped `agent:ready` on one, but
   guard anyway.)
2. Any ticket carrying **`needs:human`** — never both, but guard.
3. Any ticket **already claimed**: an existing `ser-<n>-*` branch
   (run `git fetch --prune origin` first so remote branches are current, then
   `git branch --all --list '*ser-<n>-*'`), or an open PR referencing the issue
   (`gh pr list --search "SER-<n>" --state open`). The claim in Step 2 clears
   `agent:ready` precisely so a re-run never re-grabs the same ticket, but branch/PR
   presence is the belt-and-braces check for in-flight work.

Sort the survivors **oldest-first** (by `createdAt`) and take the first **N**.

For each, fetch the full issue with `get_issue` (the list description may be
truncated) and extract **acceptance criteria** — the contract for the workflow.
If a ticket has no explicit AC, derive a short bullet list from the description.

**An empty queue is a normal outcome** — report "no `agent:ready` tickets to
pick up" and stop. Never widen scope to invent work.

## Step 2 — Claim each ticket (apply only)

Claiming is what stops a re-run or a parallel run from double-grabbing. For each
selected ticket, **before any code**:

1. **Clear the trigger.** Remove the **`agent:ready`** label so the ticket leaves
   the autonomous queue and is never picked up again. ⚠️ `save_issue.labels`
   *replaces* the whole set — read the issue's current labels and write them back
   **minus only `agent:ready`**. Never drop `type:*`, `risk:*`, or any product
   label (`Feature`, `Improvement`, `Bugs → …`, `urgent`, `Compliance:*`,
   `Migrated`). See the additive rule in `triage-labels.md`.

   > **Preserving an existing label is not setting it.** Echoing back a
   > pre-existing `Compliance/*` (or any product) label in this replace-the-whole-set
   > write is *required* label preservation — it is **not** "running compliance",
   > stamping compliance status, or any of the forbidden terminal actions in the
   > Safety rules. The "never compliance" rule forbids *initiating*
   > compliance/`/compliance-check` and *adding* a compliance verdict the agent
   > didn't earn; it never forbids carrying forward labels the ticket already had.
   > Write the full existing set minus `agent:ready`, unchanged.
2. **Move status** to **`Dev in progress`** so the ticket reads as actively
   worked. Skip the move if it's already in `Dev in progress` or later.

Clearing `agent:ready` **and** moving to `Dev in progress` is the claim — do both.

## Step 3 — Branch in an isolated worktree (apply only)

The run is unattended, so it must never touch my active checkout. Create the
branch in **its own git worktree** using the repo's **`start-work`** flow, based
on the integration branch:

```
start-issue.sh <branch> --base development
```

Branch name follows the `start-work` slug: `SER-<n> <title>` → `ser-<n>-<slug>`.
The worktree gets its own generated dev env so the workflow's tests can run in
isolation. One worktree per ticket.

## Step 4 — Solve (Workflow, apply only)

Each ticket's implement→review→fix runs as a **single `Workflow` call** — this is
the sanctioned opt-in. The workflow owns implementation and review; the
orchestrator does **not** write or review code. The workflow's first phase
**triages the ticket's difficulty** and scales every later phase to it (see the
workflow file). Invoke it by path, from the ticket's worktree:

```
Workflow({
  scriptPath: "~/.claude/skills/solve-ready-tickets/solve-ready-loop.workflow.js",
  args: {
    issueId,             // "SER-1234"
    title,               // issue title
    acceptanceCriteria,  // verbatim, array or string
    baseBranch: "development",
    worktree,            // absolute worktree path from Step 3 — threaded into every
                         // phase prompt so all work happens in the worktree, never
                         // the main checkout. Omit only if running in-place.
    repoConfig           // the JSON block from ~/.claude/docs/agents/repo-config.md
                         // (integration branch, dev-server command, e2e dir,
                         // browser-guide path, area→path map). Omit if the file is
                         // missing — the workflow falls back to built-in defaults.
  }
})
```

The workflow returns a compact summary: `tier` (trivial | standard | **escalate**),
what shipped, the diff stat, which reviewers ran (baseline + consolidated
**web/server lane** reviewers — at most 2 lanes — plus the **reuse reviewer**
whenever the diff added files, plus Opus Playwright when user-facing), the
findings it fixed, any residual judgement-call or `[disputed:…]` notes
(findings the implementer rejected with evidence — I adjudicate those on the
draft PR), the `provenance` table (added file → mirrored exemplar or declared
deviation — the convention audit trail), `consolidations` (generalizable new
code the reuse reviewer says belongs in an existing lib — follow-up work, never
fixed in-PR), Playwright proof paths, and `playwrightCriteria` (per-AC
PASS/FAIL + screenshot). Read the summary — don't pull full logs into this
context.

**Tests gate:** reviewers never see red code. If the implementer reports
`testsGreen=false`, the workflow spends one dedicated tests-fix pass before any
reviewer runs; if the code is still red after that, review is **skipped
entirely** and the ticket comes back `shipped=false` with a note — surface that
on the draft PR (or bounce the ticket) rather than pretending it was reviewed.
Implementers must prove green via `testEvidence` (commands + summary lines run
in-session), never assert it.

**If the workflow returns `escalate`** (triage found the ticket is bigger /
more ambiguous / higher-blast-radius than its `agent:ready` label claimed): the
solver is **declining** the ticket. Do **not** force a PR — and do **not** make
the routing call yourself. Instead, **bounce it back to `daily-ticket-manager`
for a fresh classification**, handing over what you learned so the manager
re-decides with better information than it first had:

1. **Write an elaborate decline comment** — this is the *new info* the manager
   re-classifies on. Don't be terse: capture the workflow's escalate reason
   (quoted), what the solver actually found when it dug in, and why that makes
   the original `agent:ready` wrong. Use this block:

   ```md
   ## Autonomous solve — declined

   The autonomous solver picked this up from `agent:ready` but **declined to
   implement it** and is bouncing it back for re-triage.

   Why declined (tier: escalate):
   <the workflow's escalate reason, quoted verbatim.>

   What the solver found:
   <2–4 lines of new info the original triage missed: the real scope/blast
   radius it touches, the ambiguity or judgement calls discovered, why it
   doesn't fit one safe PR.>

   For re-triage:
   - `agent:ready` and `risk:*` cleared, so daily-ticket-manager re-classifies
     both axes from scratch against the above.
   - Suggested direction: <e.g. likely risk:high + needs:human because …> — the
     manager makes the final call.

   _Declined by solve-ready-tickets. Re-classify with daily-ticket-manager
   before re-queueing._
   ```

   Make it idempotent: if a comment already starts with
   `## Autonomous solve — declined`, update it rather than adding a second.
2. **Clear `risk:*`** (additive write — read the issue's current labels, write
   them back **minus any `risk:low|medium|high`**; `agent:ready` is already gone
   from the Step 2 claim). Stripping the risk label drops the ticket back into
   the manager's gap-fill window so the next run re-classifies it. Preserve every
   other label (`type:*`, product, `Compliance/*`, etc.) per the Step 2 rule.
3. **Do not add `needs:human`** — routing is the manager's call now, made fresh
   against the decline comment. The solver clears the managed labels and steps
   out of the routing decision entirely.
4. **Move the ticket back to `Ready for dev - backlog`** so it re-enters the
   manager's triage scope.

Then move to the next ticket. This is the escape hatch for a mislabelled
ticket — instead of the solver guessing the routing, the manager re-triages with
the new info the solver surfaced.

## Step 5 — Draft PR + comment (apply only)

Only when the workflow shipped a real change (`tier` ≠ escalate, tests green):

0. **Scrub worktree artifacts first.** The Playwright reviewer can leave a
   throwaway e2e spec (e.g. `apps/seranote-web-e2e/e2e/*.spec.ts`) untracked in
   the worktree; an untracked source file makes the pre-push `nx affected -t lint`
   hook lint it and fail the push. Before `create-pr`, in the worktree, drop any
   untracked file that is NOT part of the implementer's committed change set:
   `git -C <worktree> status --porcelain` → for each `??` line, remove it (these
   are review scaffolding, never the shipped change — the implementer committed
   its work, so anything still untracked is throwaway). Then confirm the tree is
   clean. Do **not** touch tracked/committed files.
1. Open the PR with the repo's **`create-pr`** skill (base `development`). It
   enforces the CI-required title regex and writes the **test plan onto the
   Linear issue** — let it. `create-pr` opens a *ready* PR and does not mark it
   draft.
2. **Flip it to draft** immediately so it can't be merged without me:
   `gh pr ready <number> --undo`. The draft state IS the review gate.
3. **Upload QA evidence first (when Playwright ran).** The workflow returns
   `playwrightCriteria` (per-AC PASS/FAIL + screenshot path) and
   `playwrightProof`. Upload the proof files to the ticket via the Linear MCP
   attachment flow (`prepare_attachment_upload` → PUT the file to the returned
   URL → `create_attachment_from_upload`), so QA can verify each criterion from
   the ticket without pulling the branch. Failed criteria are uploaded too —
   evidence of what broke, not just what works.
4. **Comment on the ticket** with the solve summary — use this block:

   ```md
   ## Autonomous solve

   Tier: trivial | standard
   PR: <draft PR url> (draft — awaiting your review)

   Shipped:
   <1–2 lines: what was built.>

   Reviewers run: <baseline, web[frontend+…], server[backend+…], reuse, playwright>
   Fixed in review: <n finding(s)>  ·  Tests: green

   Convention provenance:
   | Added file | Mirrors / deviation |
   | --- | --- |
   | <path> | <mirroredFrom exemplar, or [deviation: reason]> |

   QA evidence:
   | AC | Result | Proof |
   | --- | --- | --- |
   | <criterion> | PASS/FAIL | <uploaded screenshot link> |

   Consolidation follow-ups (not fixed in this PR — candidates for their own tickets):
   - <consolidation title — targetLib — detail>

   Flagged for your review:
   - <residual judgement-call or [disputed:…] note, if any>

   _Solved by solve-ready-tickets. Not merged, not marked done — review the draft PR._
   ```

   Omit the QA evidence table when Playwright didn't run, the provenance table
   when no files were added, and the consolidation section when the reuse
   reviewer returned none. Consolidations are surfaced for me to decide — this
   skill does NOT file follow-up tickets (unlike `/work-slice`); it never
   creates tickets. Make it idempotent: if a comment already starts with
   `## Autonomous solve`, update it rather than adding a second.

Leave the ticket in **`Dev in progress`** (or a review state if the team has
one). **Never** mark it done, merge, mark the PR ready, or run
`/compliance-check` — those are my calls on the draft.

## Step 6 — Report

End every run with a compact summary, regardless of mode:

```md
# Autonomous solve — agent:ready queue
Mode: dry-run | apply   ·   In queue: <n>   ·   Picked up: <k of N>

| Ticket   | Title         | Tier      | Outcome                          |
| -------- | ------------- | --------- | -------------------------------- |
| SER-1235 | <short title> | standard  | draft PR #123                    |
| SER-1240 | <short title> | trivial   | draft PR #124                    |
| SER-1251 | <short title> | escalate  | declined → re-triage (manager)   |

## Draft PRs awaiting review
- SER-1235 — <title> — <draft PR url>

## Declined — bounced back for re-triage
- SER-1251 — <title> — <why the solver declined; agent:ready + risk:* cleared, back in Ready for dev - backlog for daily-ticket-manager>

## Notes
- <claims made, worktrees created, anything skipped, prerequisites missing>
```

In `dry-run`, the table shows what *would* be picked up and in what order; no
Outcome column actions are taken.

## Safety rules

- Default to `dry-run`. Claim / branch / implement / open PRs only on `apply`.
- **Clear `agent:ready` on claim** (additive write — never clobber other labels)
  so a ticket is never picked up twice; pair it with the `Dev in progress` move.
- **Terminal state is a DRAFT PR.** Never merge, mark the PR ready, approve, mark
  the issue done, or run compliance. "Run compliance" means *initiating*
  `/compliance-check` or *adding* a compliance verdict — it does **not** mean
  preserving a `Compliance/*` label the ticket already carried; echoing an existing
  label back on the additive claim write is mandatory, not a compliance action
  (see Step 2). The draft is the human gate.
- Honor `manager:skip` and `needs:human` as hard exclusions even if `agent:ready`
  is somehow also present.
- **One worktree per ticket**, based on `development` — never work in the user's
  active checkout.
- The orchestrator does no code work: implementation + review live entirely in
  the workflow (Step 4); the PR mechanics live in `create-pr`. Read summaries,
  not logs.
- A ticket that triages to `escalate` is **declined**, not routed: write the
  elaborate decline comment, clear `risk:*` (`agent:ready` already cleared on
  claim), add **no** routing label, and move it back to `Ready for dev - backlog`
  so `daily-ticket-manager` re-classifies it. Never stamp `needs:human` yourself —
  routing is the manager's call once the solver hands back the new info.
- A ticket that fails to claim or errors mid-solve is flagged and skipped — never
  crash the whole run, never force a low-quality PR.
- Don't touch tickets that aren't mine, aren't `agent:ready`, or aren't in
  `Ready for dev - backlog`. Don't create or close tickets.
- An empty queue is a valid result — report it and stop.

## Scheduling

Built to run unattended (e.g. nightly, after the morning `daily-ticket-manager`
run so the queue is fresh). The schedule prompt must be self-contained: name the
scope (`my agent:ready tickets, Seranote, Ready for dev - backlog`), the batch
size (`max N`), and the mutation policy (`apply` to actually solve, `dry-run` to
just report the queue). Default a scheduled run to `dry-run` unless I've
explicitly approved `apply`. A scheduled `apply` run still only ever: clears
`agent:ready` + claims, branches in a worktree, runs the workflow, opens a
**draft** PR, and comments — never merging, never marking done, never running
compliance.
