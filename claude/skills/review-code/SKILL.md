---
name: review-code
description: Fan out the shared feature-dev reviewer lanes (baseline + web/server + reuse) on any code, any time — uncommitted changes, a branch diff, or a PR. One read-only parallel review round, findings report back; no fix loop, no ticket needed. Use when the user says "review this code", "spawn the review agents", "run the reviewer lanes", "review my diff/working tree/branch", or wants the work-slice reviewers on ad-hoc code.
---

# Review Code

Run the **same review agents** the feature-dev workflows (`/work-slice`, `/solve-ready-tickets`) use — baseline + diff-matched **web/server lanes** + the **reuse reviewer** — on **any** code, standalone. One parallel read-only round, then a findings report to the terminal. No implementer, no fix loop, no Playwright, no ticket: the human decides what to do with the findings.

The reviewer definitions live once in `claude/skills/_shared/reviewer-registry.js` (synced into the workflow script via `make skills-shared`), so this skill always reviews with the current registry — tune the registry, and this skill picks it up.

Read `~/.claude/docs/agents/repo-config.md` if present (the repo-specific values — integration branch, area→path map, `libMap` — passed to the workflow as `repoConfig`). If it's missing, the workflow falls back to its built-in Seranote defaults.

## Step 1 — Resolve the review target

Input is optional: a base ref/branch, a PR number, or nothing.

- **Nothing given, dirty worktree** (`git status --porcelain` non-empty) → review the **uncommitted work**: `inspect = "git diff HEAD"`, changed = `git diff --name-only HEAD`, added = `git diff --name-only --diff-filter=A HEAD`, untracked = the `??` paths from `git status --porcelain` (source files only — skip build artifacts/screenshots).
- **Nothing given, clean worktree** → review the **branch vs its base**: `inspect = "git diff <base>...HEAD"` where `<base>` = `repoConfig.integrationBranch` (fallback `development`, or `origin/main` if that branch doesn't exist). Changed/added via `--name-only` / `--diff-filter=A` on the same range.
- **Base ref given** ("review against X", "review vs development") → same as above with that base.
- **PR number given** → don't check anything out: `inspect = "gh pr diff <n>"`, changed = `gh pr diff <n> --name-only`, added = paths whose diff hunk starts from `/dev/null` (parse `gh pr diff <n>` for `new file mode` entries). Note in `context` that reviewers see only the diff, not a checkout.
- **Specific files given** → `inspect = "git diff HEAD -- <paths>"` (or, for files with no diff, list them as `untrackedFiles` so reviewers read them in full).

If there is nothing to review (clean tree AND no commits past base), stop and tell the user.

Optionally set `declaredAreas` (from `frontend|backend|database|i18n|security|performance`) when you know the change touches an area its paths don't reveal — e.g. an auth-relevant change in a neutral path → declare `security`.

## Step 2 — Run the review round (Workflow)

This step runs as a **single `Workflow` call** — invoking it here is the sanctioned opt-in. The workflow selects the reviewer set from the changed paths (baseline always; at most 2 lanes; reuse when files were added), spawns them **in parallel**, and returns the aggregated findings.

```
Workflow({
  scriptPath: "~/.claude/skills/review-code/review-code.workflow.js",
  args: {
    inspect,        // the command reviewers run to see the code (Step 1)
    context,        // optional: what the change is / what to judge it against
                    // (acceptance criteria, a ticket description, "pre-commit check")
    changedFiles,   // repo-relative paths under review (Step 1)
    addedFiles,     // added-vs-base paths — gates the reuse reviewer
    untrackedFiles, // new files not in any diff — reviewers read them in full
    declaredAreas,  // optional area hints beyond the path map
    repoConfig      // the JSON block from ~/.claude/docs/agents/repo-config.md, if present
  }
})
```

**Do not review in the main session** — the workflow owns it. Reviewers are **Sonnet** (role-based aliases, never exact pins — same policy as the other feature-dev workflows) and **read-only**: they only report.

## Step 3 — Present the report

Print, from the returned summary:

- **Verdict**: clean, or N blocking findings.
- Which reviewers ran (`reviewers`) — and flag any that died (`reviewersReturned` missing an entry).
- **Blocking findings**: one block each — `[area] title (file:line)`, detail, suggested fix.
- **Notes**: judgement-call points, grouped by area.
- **Consolidations**: generalizable-code candidates the reuse reviewer surfaced (these would become follow-up tickets in the workflow skills; here just list them).

Then **stop** — findings are the deliverable. Do not fix anything unless the user asks; if they do, fixing happens in the main session as a normal task (there is no fix loop in this skill).

## Boundaries

- **Read-only, always.** No edits, no commits, no branch changes, no tickets. The only side effect is the report.
- One round. No fix ⇄ review loop, no convergence cap — that machinery belongs to `/work-slice` / `/solve-ready-tickets`.
- No Playwright — user-story verification needs acceptance criteria and a runnable slice; out of scope here.
- Reviewer definitions come from the shared registry — to change focus/lanes/paths, edit `claude/skills/_shared/reviewer-registry.js` in the dotfiles repo and run `make skills-shared`; never fork them inline here.
- Model roles are fixed, models are aliases: reviewers are **Sonnet**. Never pin exact model ids or effort levels.
- The reuse reviewer runs without a provenance table here (ad-hoc code has none) — it hunts lib duplicates and consolidation candidates only.
