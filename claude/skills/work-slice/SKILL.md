---
name: work-slice
description: Pick up the slice:next sub-issue from a PRD, implement it test-first inside a bounded review-fix loop, then open a stacked draft PR for later review. Use when the user says "work the next slice", "start the next ticket", "implement slice X", "pick up SER-xxxx", or wants to work through PRD slices created by /to-issues.
---

# Work Slice

Drive **one** slice from a PRD to a stacked **draft PR**. The slices were produced by `/to-issues` as sub-issues of a parent PRD ticket, ordered into a stack. This skill picks the next one up, implements it test-first inside a bounded **targeted review ⇄ fix loop**, and then **opens a stacked draft PR automatically** — no confirmation gate; the draft PR itself is the later review surface. Run it once per slice; the next run stacks on the last.

Read `~/.claude/docs/agents/issue-tracker.md` (how to fetch issues, read blocked-by relations, mark state), `~/.claude/docs/agents/triage-labels.md` (the `slice:next` work pointer vs `agent:ready`), and `~/.claude/docs/agents/repo-config.md` (the repo-specific values — integration branch, dev-server command, e2e dir, browser guide, area→path map — passed to the workflow as `repoConfig`). If the first two are missing, run `/setup-matt-pocock-skills`; if `repo-config.md` is missing, the workflow falls back to its built-in Seranote defaults.

## Step 1 — Select the slice

**Preflight (before you claim anything):** confirm you're in a clean, dedicated worktree per Step 2. If you're not in a git worktree, or it has uncommitted changes, **STOP and tell the user** — do not claim the slice and do not create a worktree yourself.

Input is a parent PRD ticket id, a specific slice id, or nothing.

- **Specific slice id given** → use it.
- **Parent id given (or inferable from context)** → list its sub-issues and pick the slice carrying **`slice:next`** — the single work pointer that `/to-issues` (skeleton) or a previous `/work-slice` run placed on the slice that is up. That is the one to work. **Fallback** if no slice carries `slice:next` (e.g. it was cleared by hand): take the earliest **unblocked, not-`needs:human`, not-done, not-in-progress** slice in stack order.
- **Nothing** → ask for the parent id or slice id.

If the chosen slice is **HITL / `needs:human`**, stop and tell the user what decision it needs — don't implement it unattended.

Fetch the chosen slice AND its parent PRD (the PRD lives in the parent's `# PRD` comment — read it from there). Read, verbatim: the slice's **Kind** (skeleton vs delta), **Novel decision**, acceptance criteria, "Where to look" code-layer pointers, the **"Convention contract"** section (binding exemplars + must-use libs), "Design" Figma nodes/tokens, and "Stacked on" predecessor. For a **delta**, also read the ticket's **"Skeleton map" comment** (posted by the skeleton's `/work-slice` run — the actual files the skeleton created; the primary mirror). Read the parent PRD for the wider contract.

**Claim the slice.** Remove its `slice:next` label and set its status to **Dev in progress** (`~/.claude/docs/agents/issue-tracker.md`) so it reads as actively worked and no parallel run grabs it. The pointer only moves on to the next slice after the draft PR is opened (Step 6). When removing/adding `slice:next`, write back the issue's full existing label set minus/plus only that label — never drop `type:*`, `manager:skip`, or any product label (`save_issue.labels` replaces the whole set; see `~/.claude/docs/agents/triage-labels.md`).

## Step 2 — Confirm the worktree & resolve the branch base

**This skill does NOT create a worktree or branch.** It trusts that one is already set up — e.g. the Conductor session's worktree — so the work lands in the same checkout you're watching. (Conductor's `setup` script runs `init-worktree.sh`, so a Conductor workspace is already bootstrapped: env config, Docker stack, migrations, seed.)

**Confirm the working tree** (this is the Step 1 preflight — do it before the claim):

- It is inside a git worktree — `git rev-parse --is-inside-work-tree` returns `true`.
- It is clean — `git status --porcelain` is empty (no uncommitted changes).
- If either fails — **not in a worktree, or there are pending changes** — **STOP and tell the user.** Ask them to open the slice's dedicated worktree (let Conductor create + bootstrap it), or to commit/stash pending work first. **Never create a worktree or switch branches yourself.**

**Confirm av is initialized.** This skill drives stacking through Aviator (`av`). The stack DB lives in the **git common dir** — `test -f "$(git rev-parse --git-common-dir)/av/av.db"` — so it is shared across every Conductor worktree; one `av init` covers the whole repo. If the file is **absent**, **STOP and tell the user to run `av init` once** at the repo root (one-time, repo-wide). Don't run `av init` yourself from inside a slice worktree.

The slice's branch is **whatever Conductor checked out** (a `start-work` slug like `ser-1234-…`, or a Conductor-generated name) — you will **rename it in place** to the stack branch name below. `git branch -m` only renames the branch already checked out; it does not create a branch or a worktree. Before renaming, sanity-check you're in the slice's intended worktree (HEAD should be fresh off the base, not carrying another slice's commits).

**Resolve the base branch and the stack position** — base feeds the reviewers' `git diff <base>...HEAD` and the stacked PR; the position gives the branch its number:

- **Skeleton slice** (first in the stack) → base = the repo's integration branch (`development`); stack position **`01`**.
- **Downstream slice** → base = the **predecessor slice's stack branch** (the blocked-by ticket — the skeleton for fanned-out deltas, the chained predecessor otherwise) — the renamed `<project-slug>/NN-ser-xxxx` branch a previous `/work-slice` run created. Find it on the remote by the predecessor's Linear id: `git ls-remote --heads origin '<project-slug>/*'` (match `*-ser-<predecessor-n>`), or read the predecessor's open PR head with `gh pr list --state open --json number,headRefName,baseRefName`. This slice's position `NN` is its **index in the PRD's published stack order** (the `/to-issues` numbering) — NOT predecessor+1: with fan-out, several deltas share the skeleton as predecessor, and only the stack-order index stays unique. If the predecessor has already merged, base off `development` instead and note it.

### Rename the branch to the stack name

Derive `<project-slug>` once per stack: kebab-case the parent PRD's **Linear project name** (e.g. project "Summary feature" → `summary-feature`). If the PRD has no Linear project, fall back to a kebab-case of the parent PRD ticket's short title. The branch name is `<project-slug>/<NN>-<ser-id>` — the project-slug namespace prefix, the zero-padded stack number, then this slice's Linear id lower-cased: `summary-feature/01-ser-1234` for the skeleton, `summary-feature/02-ser-1290` for the next in stack order, and so on. The `<project-slug>` segment is the shared namespace prefix that groups the stack's branches under one name (and lets you list them with `git ls-remote --heads origin '<project-slug>/*'`); `NN` keeps the stack readable in order; `ser-xxxx` ties each branch to its ticket. Rename in place:

```bash
git branch -m "$(git rev-parse --abbrev-ref HEAD)" summary-feature/01-ser-1234
```

The rename is the **only** branch mutation — no new branch, no worktree change. **Leave the Conductor worktree directory name as-is** — renaming the dir breaks the path-keyed docker stack (`vtt-<root>-*`), Conductor's workspace tracking, and the running dev server. Conductor may have already pushed the pre-rename name; the stale remote branch is cleaned up at push time (Step 5).

### Adopt the branch into the av stack

Conductor created the branch+worktree, so `av` doesn't know about it yet — **adopt** it (never `av branch`, which would try to create one):

- **Skeleton slice** → `av adopt --parent development`.
- **Downstream slice** → `av adopt --parent <predecessor stack branch>` — the branch resolved in "Resolve the base branch" above (the skeleton's branch for a fanned-out delta, the chained predecessor's otherwise; don't assume it is `NN-1` — with fan-out several deltas share the skeleton as parent). Conductor usually branches the worktree off `development`, not off the predecessor — so after adopting, **rebase this (still-empty) branch onto the predecessor** so the implementation builds on top of it: `av reparent --parent <predecessor stack branch>`. No-op for the skeleton; skip it there. If the predecessor already merged, adopt with `--parent development` and skip the reparent.

`av adopt` only records stack metadata; it does not create a branch or touch the worktree. From here every commit in Step 3 goes through `av commit`, and Step 5 opens the PR through `av`.

## Step 3 — Implement + targeted review loop (Workflow)

**Precondition:** Step 2 must have already **adopted** the branch into the av stack — the workflow's agents commit with `av commit`, which requires the branch be tracked. Do not invoke the workflow until `av adopt` (Step 2) has run. Sanity-check: `git rev-parse --git-common-dir`/`av/av.db` lists this branch.

This step runs as a **single `Workflow` call** — invoking it here is the sanctioned opt-in. The workflow is the orchestrator: it implements the slice, detects what changed, fans out **only the relevant reviewers in parallel**, aggregates their structured summaries, and loops fix ⇄ review to a hard cap. Once that code-review loop converges it runs a **separate Playwright user-story loop** (verify ⇄ fix, its own smaller cap) on user-facing slices. The main session invokes the workflow, waits, and reads back the returned summary for the Step 4 result presentation. **Do not implement or review in the main session** — the workflow owns it.

The workflow script ships next to this skill. Invoke it by path (resolve `~` to the home dir):

```
Workflow({
  scriptPath: "~/.claude/skills/work-slice/work-slice-loop.workflow.js",
  args: {
    sliceId,             // e.g. "SER-1234"
    sliceKind,           // "skeleton" | "delta" — the ticket's Kind section (defaults to delta)
    acceptanceCriteria,  // verbatim, array or string
    whereToLook,         // the slice's "Where to look" pointers — for a delta, prepend the
                         // "Skeleton map" comment's file list (the primary mirror)
    conventionContract,  // the slice's "Convention contract" section, verbatim (binding
                         // exemplars per layer + must-use libs)
    figma,               // Figma node deep-links + recorded tokens (UI slices)
    baseBranch,          // resolved in Step 2 (predecessor stack branch, or `development`)
    prdContract,         // the parent PRD's wider contract
    repoConfig           // the JSON block from ~/.claude/docs/agents/repo-config.md (integration branch,
                         // dev-server command, e2e dir, browser-guide path, area→path map, goldenPaths,
                         // libMap). Omit if the file is missing — the workflow falls back to built-in defaults.
  }
})
```

The script body encodes everything below (registry, model pinning, the loop, the schemas) — the sections that follow document its behaviour. To tune the workflow, edit `work-slice-loop.workflow.js` and re-run with the same `scriptPath`.

### Model roles (aliases, never exact pins)

Models are role-based and use aliases (`opus` / `sonnet`) so they track the latest model tier — never pin exact model ids or effort levels:

- **Implementers write, so they get the strongest model:** implement + every fix round (code-review and Playwright) → `opus`.
- **Reviewers report, so they run leaner:** baseline + lane + reuse reviewers → `sonnet`.
- **Playwright reviewer** → `opus` (decided — browser-driving plus judging acceptance criteria is the hardest reviewer job).

### Reviewer registry — area → anchor skill → trigger paths

The workflow detects **areas** by matching the changed files against the trigger column, then **consolidates the triggered areas into two composite review lanes** so a round runs at most **baseline + 2 lane reviewers + reuse**: **web** = frontend + i18n + performance, **server** = backend + database + security. A lane reviewer's prompt merges only its *triggered* member areas' skills + focus — same coverage, fewer agents, less finding churn. Defensive enrichment: a triggered `frontend` area always pulls the `performance` lens into the web lane, and a triggered `backend` area always pulls `security` into the server lane (those two rarely trigger by path alone). **Baseline always runs.** The **reuse reviewer** is its own agent, gated not on paths but on the diff **adding files** (the implementer reports `addedFiles`): it hunts duplicates of existing lib/design-system code (blocking) and verifies the implementer's **provenance table** — every added file must cite the exemplar it mirrors or declare a `[deviation: reason]`; missing or false rows block. Generalizable-new-code goes into `consolidations` (never blocking — Step 4 files it as follow-up tickets). Playwright is a per-slice judgement call (below). The trigger paths below are the built-in defaults — `repoConfig.areaPaths` from `~/.claude/docs/agents/repo-config.md` overrides them per repo, and the registry itself lives once in `claude/skills/_shared/reviewer-registry.js` (synced into the workflow scripts via `make skills-shared`).

| Area (lane) | Anchor skill(s) | Fires when the diff touches |
|---|---|---|
| **Baseline** (always, own agent) | `CLAUDE.md` conventions + the slice acceptance criteria | every run — correctness, missed AC, convention/reuse, test quality |
| **Reuse** (own agent, gated on added files) | `CLAUDE.md` conventions + `repoConfig.libMap` | the diff ADDS files/symbols — duplicate-of-lib (blocking), provenance audit (blocking), generalizable-code → `consolidations` (follow-up tickets, never blocking) |
| Frontend / UI (`web`) | `frontend-implementation`, `tailwind-predefined-values`, `web-design-guidelines`, `figma-implement-design` | `libs/ui/web/**`, `apps/seranote-web/**/*.tsx`, `*.stories.tsx` |
| Backend (`server`) | `backend-action-service-split` | `libs/backend/**` (dal / service / action) |
| Database (`server`) | `CLAUDE.md` DB conventions (`createBaseRepo`, Drizzle schema/relations/migrations) | `drizzle/**`, `libs/backend/db/**/schemas/**`, `**/relations/**`, `drizzle.config.ts` |
| i18n / translations (`web`) | `i18n` | `apps/seranote-web/src/i18n/**`, `en.json`, added/changed `t(` / `useTranslations(` / `getTranslations(` |
| Security (`server`) | `security-review` | server actions, auth, secrets/env, authz, input/upload handling — plus always when `backend` triggers |
| Performance (React/Next) (`web`) | `vercel-react-best-practices` | declared by the implementer — plus always when `frontend` triggers |

The `performance` area is the **client/React lens only**. Server-side performance — N+1 query patterns, sequential awaits where `Promise.all` fits, over-fetching, missing indexes, join cost — is baked directly into the **backend** and **database** focus definitions, where the queries live. No extra agent; the server lane always carries it.

A reviewer is told to apply its anchor skill's rules against the slice's diff and report **correctness / missed-AC / convention-reuse** problems — not style nits. Reviewers are **read-only**; they only report.

### Playwright user-story loop (after the code-review loop converges)

Playwright is **not** part of the per-round code review — it runs as its own loop **after** that loop converges, and only when the change warrants it. Whether to run it is the orchestrator's judgement per slice — **lean toward running it.** Skip only when the slice clearly has no user-facing impact (pure refactor, internal util, a migration with no behaviour change). A backend-only diff can still change user-facing behaviour — when in doubt, run it. (The workflow gates this on the implement/fix agent's `userFacingImpact` flag, which biases to `true`.)

It mirrors the repo's existing browser-verification mechanism — **read `.claude/skills/dev-loop/browser-guide.md` first** for login steps, seeded users, routes, the core SOAP flow, selectors, and the microphone fake-media flags. (The guide path, dev-server command, and e2e dir below are the built-in defaults; `repo-config.md` overrides them.) Each round it must:

1. Start the app in the background and capture its URL: `DEV_LOGIN_ENABLED_SERVER=true pnpm nx portless seranote-web` (wait until it serves).
2. Author a throwaway Playwright spec (reuse `apps/seranote-web-e2e/` config + the `login.spec.ts` dev-login pattern) driving **isolated headless Chromium** with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, `video: 'on'`, `baseURL` = the running app.
3. Dev-login as the seeded user matching the slice, then **exercise this slice's acceptance-criteria user stories**, capturing a screenshot for **every** criterion — PASS and FAIL alike, named `ac-<n>-<pass|fail>.png` — plus the run video. These are **QA evidence**: Step 4 uploads them to the slice ticket, so each screenshot must actually show the behaviour it proves (or the breakage).
4. **Clean up before returning:** delete the throwaway spec (and any other source file it created) so nothing untracked remains — an untracked spec fails the pre-push `nx affected -t lint` hook at PR time. Only the gitignored screenshots/video stay.
5. Return a PASS/FAIL per criterion with the proving screenshot. **A broken user story = a failed acceptance criterion = a blocking finding** that triggers a fix round; keep the screenshot as proof. The workflow returns the last round's per-criterion verdicts as `playwrightCriteria`.

### The loop (inside the workflow)

1. **Implement** — one Opus agent, TDD discipline (one test → impl per acceptance criterion — never all-tests-then-all-impl). Use the "Where to look" pointers as the starting map. **Mirroring is binding**: a skeleton clones the exemplar's shape (it makes every cross-layer decision the deltas inherit); a delta mirrors the skeleton first, appends rather than modifies, never alters the skeleton's contract (contract freeze — a needed contract change is a stop-and-escalate, not an edit), and introduces at most the ticket's one named novel decision. No new helper without a `libs/**` search; consolidation is in-scope only within the slice's own new code + at most one existing call site. The agent returns a **provenance table** (added file → `mirroredFrom` exemplar, or `[deviation: reason]` — silent deviation forbidden). For UI: fetch the Figma screenshot fresh via the Figma MCP from the slice's node deep-link and reuse design-system tokens/components, not magic numbers. Stay inside this slice's scope — if you discover it needs something a later slice owns, note it, don't pull future work forward. Commit. → GREEN slice.
2. **Code-review loop, max 5 rounds**, starting from the GREEN slice — **baseline + area reviewers only, no Playwright**:
   0. **Tests gate** — reviewers never see red code. If the latest implement/fix pass reports `testsGreen=false`, the round is spent on a dedicated tests-fix pass instead of reviewers (it still counts against the cap). Every implement/fix agent must set `testsGreen=true` only after actually running tests + lint/typecheck in-session and must return the commands + summary lines as `testEvidence`.
   1. **Detect changed areas** — `git diff --name-only <base>...HEAD`, match each path against the registry trigger column, then group the triggered areas into the **web/server lanes** → the active reviewer set (baseline always; at most baseline + 2 lanes; plus the **reuse reviewer** whenever the diff adds files).
   2. **Review** — spawn the selected reviewers **in parallel** (each Sonnet, fresh), each returning a structured summary `{ area, blockingFindings[], notes[] }`. From round 2 on, every reviewer receives the **finding history** (what earlier rounds flagged, marked `fixed` or `disputed`): verify fixes, never re-raise disputed items, and report only NEW problems introduced by the fix diff — no fresh nitpicks in code that already passed.
   3. **Aggregate (deterministic).** No `blockingFindings` across any reviewer → the review loop **converges**; go to the Playwright loop. Otherwise → fix.
   4. **Fix** — hand all blocking findings to a single fresh Opus agent to resolve test-first (RED→GREEN where behaviour changes). The fixer may **dispute** a finding instead of fixing it — only with concrete evidence (file:line, test output, spec text); disputed findings exit the loop as notes for the human on the draft PR, everything else must be resolved. Commit. Then **recompute the changed-area set from the fix diff** — the next round re-runs only the **fix-touched lanes + baseline**. Return to step 1 with fresh reviewers.
   - **Cap at 5 rounds.** If round 5 still returns blocking findings, **stop** and return them as outstanding (skip the Playwright loop) — do not keep iterating. The main session still opens the draft PR (Step 4→5) and carries these outstanding findings into it. Pure judgement-call / debatable findings never block; carry them back as notes.
3. **Playwright user-story loop, max 3 rounds** — runs **only after the code-review loop converged AND the slice is user-facing** (the case-by-case judgement above; skip pure refactors / internal utils / no-behaviour-change migrations):
   1. **Verify** — one fresh Opus Playwright reviewer drives the running app and returns PASS/FAIL per acceptance-criterion user story with proving screenshots. It cleans up its throwaway spec before returning (only gitignored screenshots/video remain).
   2. **Aggregate.** No broken user stories → the Playwright loop **converges**; done. Otherwise → fix.
   3. **Fix** — hand the broken user stories (each a failed AC = blocking) to a single fresh Opus agent to resolve test-first. Commit. Re-verify with a fresh Playwright reviewer.
   - **Cap at 3 rounds.** If round 3 still has broken user stories, **stop** and return them as outstanding — escalate to the human.
4. Before returning, run the slice's tests + lint/typecheck green (`pnpm nx`).

The workflow **returns** to the main session: code-review rounds + Playwright rounds used, whether each loop converged or hit its cap (with any outstanding blocking findings listed), the carried notes, the final **provenance table**, the **consolidations** list (reuse follow-up candidates), the diff stat, and the Playwright proof paths. That summary feeds Step 4.

## Step 4 — Present the result, then proceed

**No confirmation gate — the draft PR is the review surface, so proceed straight to Step 5.** First print, from the workflow's returned summary (so the terminal has the record):

- The slice id + one-line summary of what was built.
- The diff stat (and how to see the full diff).
- Acceptance criteria, each ticked or flagged (Playwright proof screenshots where it verified them).
- The loop outcome: which reviewers ran and how many code-review rounds it took to converge; whether the Playwright loop ran and converged (or how many of its 3 rounds it used) — or that either loop **hit its cap** with the listed blocking findings still unresolved.
- Any judgement-call findings — including `[disputed:…]` notes (findings the implementer rejected with evidence; you adjudicate those on the PR).
- The **provenance table** (added file → mirrored exemplar or declared deviation) — the convention audit trail.
- Any **consolidations** the reuse reviewer surfaced, and any **ratchet candidates**: a convention finding that showed up in 2+ rounds (or that you recognise from earlier slices) is a candidate for a lint rule / Nx module-boundary tag — name it so the human can move it from review into the tests gate.
- The branch + its base (the stack position).

**QA evidence → Linear (when the Playwright loop ran):** the workflow returns `playwrightCriteria` (per-AC PASS/FAIL + screenshot path) and `playwrightProof` (screenshots + video). Upload the proof files to the **slice ticket** via the Linear MCP attachment flow (`prepare_attachment_upload` → PUT the file to the returned URL → `create_attachment_from_upload`), then post/update a ticket comment starting with `## QA evidence`: one row per acceptance criterion — PASS/FAIL + link to its uploaded screenshot (video linked at the bottom). Failed criteria stay in the table marked FAIL so QA sees exactly what broke. Idempotent: update an existing `## QA evidence` comment rather than adding a second.

**Consolidation follow-ups → Linear (when the workflow returned `consolidations`):** file each as its own ticket on the team (same create flow as `~/.claude/docs/agents/issue-tracker.md`): title from the consolidation, body = the detail + targetLib + a link back to this slice's PR, labels `type:chore` + `manager:skip`. This is the strict boundary that keeps the slice diff small — generalisation happens in its own reviewed change, never by scope-creeping this slice. List the created ticket ids in the terminal summary and in the Step 5 PR comment.

Then open the draft PR (Step 5) **without asking**. Open it even when a loop hit its cap — carry the unresolved blocking findings + judgement-call notes into the PR body / a review comment so they surface on the draft. The **only** thing that skips Step 5 is the implement agent having produced no committed diff (nothing to PR) — in that case stop and tell the user.

## Step 5 — Open the stacked draft PR (automatically)

Stacking is **owned by `av`**, but av does **not** open the PR — `create-pr` does. The split:

- **`create-pr`** (repo skill, used **verbatim** — never edit it) opens the PR and owns everything it is good at: the `<type>[(scope)]: SER-XX <subject>` title regex, the conflict check, the Summary body, and **writing the test plan onto the Linear issue**. It opens against `development`.
- **`av sync`** then **adopts** that PR into the stack: it retargets the base to the parent branch and embeds the stack-linkage metadata block — no hand-rolled `gh pr edit --base`, no `### Stack` block.

The mechanism that makes this work (verified): **`av sync` adopts an existing GitHub PR; `av pr` does NOT — `av pr` would open a second, duplicate PR.** So the branch is adopted in Step 2, `create-pr` opens the PR, and `av sync` reconciles it. **Never run `av pr` in this flow.**

**0. Scrub worktree artifacts first.** The Playwright reviewer cleans up after itself, but guard anyway: an untracked throwaway e2e spec (e.g. `apps/seranote-web-e2e/e2e/*.spec.ts`) left in the worktree makes the pre-push `nx affected -t lint` hook lint it and fail the push. Run `git status --porcelain` — for each `??` line, remove it (the implementer committed its work via `av commit`, so anything still untracked is review scaffolding, never the shipped change). Then confirm the tree is clean. Do **not** touch tracked/committed files.

**1. Clean up the stale remote branch.** Conductor pushed the pre-rename name. If it still exists on the remote, delete it so only the stack branch remains — and **close any PR that was opened against it**. This matters: `av sync` aborts the whole stack if a branch has more than one open PR (`error: multiple open pull requests for branch …`).

```bash
old=<conductor-branch-name>
git ls-remote --exit-code --heads origin "$old" >/dev/null 2>&1 && git push origin --delete "$old"
gh pr list --head "$old" --state open --json number --jq '.[].number' | xargs -r -n1 gh pr close
```

**2. Run `create-pr` (verbatim), then make it a draft.** `create-pr` runs the conflict check, enforces the title, writes the test plan onto the Linear issue, and opens the PR against `development`. Let it do all of that — for a downstream slice the base (`development`) and the whole-stack Summary it computes are both "wrong" right now; `av sync` fixes the base in step 3. (The Summary bullets stay create-pr's; `av sync` does not rewrite the body, only appends its metadata block. The base retarget makes GitHub show the correct per-slice diff regardless — a downstream body that still reads whole-stack is a known cosmetic, not a correctness, issue.)

`create-pr` opens a **ready** PR; this skill ships **drafts** (review happens on the draft PR, not before it). It can't be opened as a draft without editing `create-pr`, so convert it immediately after — capture the number and undo-ready (verified metadata-safe: it touches neither base nor body, and `av sync` preserves the draft state in step 3):

```bash
pr=$(gh pr view --json number --jq .number)
gh pr ready "$pr" --undo   # ready -> draft
```

**3. Adopt the PR with `av sync`.** The branch is already av-adopted (Step 2). Reconcile its PR into the stack:

```bash
av sync --push=yes --prune=no
```

- It finds the PR `create-pr` opened, **retargets its base** to the parent (`development` → predecessor for a downstream slice; left at `development` for the skeleton), **embeds the metadata block**, and **keeps the PR a draft**. Verify: `gh pr view <n> --json baseRefName,isDraft` shows the parent and `true`.
- **The base retarget only happens once the parent branch also has an open PR** (verified). In a real stack the predecessor's PR is already open from its own `/work-slice` run, so the condition holds; if you ever see a downstream base stuck on `development` after sync, confirm the predecessor PR is open.
- `--prune=no` always — sibling stack branches are checked out in other Conductor worktrees and must not be deleted.
- **Skeleton slice / predecessor already merged:** base correctly stays `development`; `av sync` is still run to embed the metadata.

**4. Post the convention audit as a PR comment.** Never `gh pr edit --body` (it strips av's metadata block) — use a comment instead: `gh pr comment <n> --body` with a `## Convention provenance` section (the provenance table: added file → mirrored exemplar or `[deviation: reason]`) and, when present, a `## Consolidation follow-ups` section linking the tickets filed in Step 4. This is what the human reviews the convention story against.

That is the whole stack bookkeeping — no hand-maintained `### Stack` block. av records the parent/child links in `av/av.db` and the navigable metadata in each PR body; later slices' `av sync` runs refresh the linkage across the stack.

**After the predecessor merges**, run `av sync --all --push=no --prune=no` to restack the remaining branches onto the new base and rebase away any duplicated commits (handles the squash-merge case the manual `git rebase --onto` used to). Ask the user before pushing all stacks (`--push=yes`).

## Step 6 — Advance the pointer & hand off

The PR is open, so this slice is "ready for PR" — hand off:

**If this slice was the skeleton**, first post a **"Skeleton map" comment on every downstream delta ticket**: the list of files the skeleton created/changed, one line each (`path — what it is / which layer`), taken from the workflow's `changedFiles` + provenance. This refreshes the deltas' "Where to look" with the feature's *actual* shape — a fresh delta agent mirrors these files, not a guess made before the skeleton existed. (Comments only — never edit sibling ticket bodies.) Idempotent: update an existing `Skeleton map` comment rather than adding a second.

Then advance the work pointer:

- Find the **next slice in the stack** (the earliest now-unblocked slice in stack order; with fan-out, several deltas unblock at once — the pointer marks just the earliest, and you tell the user which siblings are also unblocked for parallel worktrees).
- **If it is AFK** (not `needs:human`) → add **`slice:next`** to it. That is the signal the next `/work-slice` run (or, later, an autonomous loop) reads to pick it up. Only ever one slice carries `slice:next`.
- **If it is HITL / `needs:human`, or there is no next slice** → do **not** stamp `slice:next`. Tell the user the stack needs a human decision next (name the slice), or that the stack is complete.

Then tell the user this slice is up for review and that the next `/work-slice <parent-id>` run will pick up whatever now carries `slice:next` and stack it on this branch. Name that slice.

## Boundaries

- One slice per run. Don't batch slices.
- **Never create a worktree or a new branch.** Operate in the current (e.g. Conductor) worktree; you may **rename** the already-checked-out branch to the stack name and **adopt** it into the av stack (Step 2), but never create additional branches or worktrees (no `av branch` — use `av adopt`), and never rename the Conductor worktree directory. If it isn't a clean worktree, stop and tell the user (Step 2).
- **av owns stacking.** Commit only with `av commit`, never raw `git commit`/`git push` (raw git skips restacking and breaks stack tracking). `av init` is the user's one-time job — never run it from a slice worktree (Step 2). On any `av sync`/prune, use `--prune=no` — sibling stack branches are checked out in other Conductor worktrees and must not be deleted.
- **`create-pr` is a repo skill — never edit it.** It opens the PR verbatim (title regex, conflict check, Summary, Linear test plan). Then **`av sync` adopts that PR** — retargets the base to the parent and embeds the stack metadata (Step 5). **Never run `av pr`** in this flow: `av pr` creates a *new* PR and duplicates create-pr's (verified); only `av sync` reconciles an existing GitHub PR into the stack. Don't run `gh pr edit --body` on an av-adopted PR — it strips the metadata block.
- Never merge, approve, or mark the PR ready — Step 5 opens it as a **draft** (create-pr opens ready → `gh pr ready --undo`); promoting to ready is the human's call after review.
- Never implement a needs-human/HITL slice unattended (Step 1).
- **Model roles are fixed, models are aliases:** implementers (implement + every fix round) are **Opus**; reviewers (baseline + lanes + reuse) are **Sonnet**; the Playwright reviewer is **Opus** (decided). Never pin exact model ids or effort levels. Not the orchestrator's discretion.
- Reviewers are **read-only** — only the implement/fix agent edits code (Step 3).
- Reviewers run **in parallel**; the workflow aggregates their structured summaries and decides fix vs done vs escalate deterministically.
- **Re-review is focused:** after a code-review fix, only the fix-touched lanes + the always-on baseline re-run. The baseline pass is the net against a fix regressing an area that's no longer reviewed. Playwright is no longer part of the per-round review — it's the dedicated post-convergence loop below.
- **Reviews have memory:** from round 2 on, reviewers see the finding history (`fixed` / `disputed`) — they verify fixes and hunt fix-introduced problems, they don't re-litigate passed code or re-raise disputed items.
- **Disputes exit the loop, not the record:** the fixer may reject a factually-wrong finding with concrete evidence; it becomes a `[disputed:…]` note the human adjudicates on the draft PR. Never silently dropped, never fixed-around.
- The code-review loop is capped at **5 rounds** and the Playwright loop at **3** — never iterate past either; return the outstanding findings and escalate to the human (Step 4) instead.
- **Tests gate before every review/verify round:** reviewers and the Playwright agent never see red code. A `testsGreen=false` result routes back to an implementer tests-fix pass (consuming a round of the same cap), and implementers must prove green with `testEvidence` (commands + summary lines run in-session), never assert it.
- Playwright runs as a **dedicated loop, only after the code-review loop converges**, and only on user-facing slices. A broken user story is a **blocking** finding (failed AC), not advisory — it triggers a fix round inside that loop (max 3), with the screenshot kept as proof.
- TDD discipline is carried in the implement/fix agent's prompt (red-green per criterion); workflow subagents don't load the `tdd` skill directly.
- Don't apply `agent:ready` to anything — this skill speaks `slice:next`, never the autonomous-loop trigger.
- Don't modify the parent PRD ticket or sibling slices' bodies. The only sibling changes allowed are moving the `slice:next` pointer and posting/updating the "Skeleton map" comment on downstream deltas (Step 6).
- **Conventions are binding, not advisory:** exemplar mirroring per the slice's Convention contract; every added file carries a provenance row (`mirroredFrom` or a declared `[deviation: reason]`) — silent deviation is a blocking finding; no new helper without a `libs/**` search; the reuse reviewer runs whenever the diff adds files.
- **Contract freeze:** a delta never alters the skeleton's published contract (schema/types/API shape). A needed contract change stops the slice and escalates — the stack gets restructured, not quietly edited.
- **Consolidation never widens a slice:** in-slice extraction only within this slice's own new code + at most one existing call site; everything wider becomes a filed follow-up ticket (Step 4), linked from the PR comment (Step 5).
- **No pre-PR confirmation gate.** Once the loop finishes, open the draft PR automatically (Step 4→5); the only skip is "no committed diff". Never promote it to ready or merge — that stays the human's call on the draft.
