---
name: daily-ticket-manager
description: >
  Review and triage the Linear tickets assigned to me that are queued to start — every issue assigned
  to me, on the Seranote team, in the `Ready for dev - backlog` status, regardless of cycle. Classifies
  each on two axes: how risky it is to execute unattended (risk: low / medium / high), and who should
  pick it up (routing: agent-ready vs needs-human). The ticket's `type` (bug / feature / docs / …) is
  assumed already set by the PM / PRD pipeline — this skill does not assess it. It produces a triage
  report and, on `apply`, applies risk/routing labels and writes an "Agent Assessment" comment.
  Use this whenever I ask to "review my tickets", "triage my queue", "what's ready for me to pick up",
  "classify my Linear tickets", "which of my tickets can an agent pick up", "what needs my attention",
  "go through my assigned issues", or run `/daily-ticket-manager` — even when I don't name Linear
  explicitly. Defaults to a read-only dry run; only mutates Linear when I pass `apply`.
argument-hint: "[dry-run|apply] [for <team>]"
---

# Daily Ticket Manager

A lightweight daily triage of my own Linear queue — think of it as a product manager that looks at every
dev-ready ticket assigned to me and answers two questions per ticket:

1. **How risky is it to execute unattended?** — a single `risk` (low / medium / high).
2. **Who should pick it up?** — routing: `agent:ready` (safe to hand to an AI agent loop) or `needs:human`
   (a judgement call, ambiguity, or blocker needs me first), or neither.

The ticket's `type` (bug / feature / docs / test / refactor / chore) is assumed already set by the PM / PRD
pipeline (`to-prd` / `to-issues`); this skill does not classify or apply it.

It reports those classifications and, when asked, records them back on the ticket so the queue stays
self-describing for me and for downstream automation — the whole point is to mark which work is safe to
route to an agent and which needs my attention.

This skill **does not implement tickets**. It reads, classifies, and (on `apply`) labels + comments.
Nothing else mutates.

## Mode — dry-run is the default

Parse the argument for the run mode:

- **`dry-run`** (default, and the default whenever the mode is absent or ambiguous) — read Linear, classify,
  print the report. **Mutate nothing.** No labels, no comments, no label creation.
- **`apply`** — do everything dry-run does, then apply the `risk:*` and routing labels and
  write/update the Agent Assessment comment on each ticket, creating any missing managed labels first.

When running unattended (scheduled / non-interactive), never block on input. If a prerequisite is missing
or the scope can't be resolved, record it in the report and exit. Treat an unattended run as `dry-run`
unless the schedule prompt explicitly says `apply`.

## Step 1 — Resolve scope

The default scope is **my tickets, Seranote team, in the `Ready for dev - backlog` status** — every such
ticket assigned to me, regardless of which cycle (or no cycle) it sits in. Concretely:

- **Assignee** — `me` (the Linear MCP resolves this to the authenticated user).
- **Team** — `Seranote` by default. If I name another team ("for Clinical Platform"), use that instead.
- **Status** — only tickets in **`Ready for dev - backlog`**. This is the one state where classification is
  actionable: the work is queued to start. Everything else — other backlogs, `Dev in progress`, review/QA
  states, UI/UX or AI lanes, released/closed/cancelled — is **out of scope** and must be skipped, even when
  assigned to me.

> **No cycle filter.** Triage every assigned `Ready for dev - backlog` ticket whether or not it sits in the
> current cycle (or any cycle). The old current/next-cycle window is gone — scope is now status-only.

> In-scope status ID (Seranote): `Ready for dev - backlog` = `7a4368ec-5dd4-450b-ad94-baf40fdbe8d1`. Match by
> exact state name; fall back to this ID if names have drifted. For another team, resolve the equivalent
> state via `list_issue_statuses`.

> Seranote team ID: `eb39f46c-0d31-4bd0-ae65-c7a42b51b889`. Resolve other teams via `list_teams`.

## Step 2 — Fetch my tickets

`list_issues` takes a single `state`, so filter by status **server-side**:

`list_issues` with `assignee: "me"`, `team: "<resolved team>"`, `state: "Ready for dev - backlog"`, `limit: 100`.

> If the team's state name has drifted and the name-based `state` filter silently returns an empty `issues`
> array, fetch without `state` (just `assignee` + `team`) and filter client-side by the status ID above — an
> empty result then means a genuinely empty queue, not a name mismatch.
> A large result can exceed the tool-output token limit, in which case the MCP saves it to a file instead of
> returning it inline. If that happens, parse the saved JSON (e.g. via a subagent or
> `python3 -c "import json; ..."`) rather than re-fetching — keep the full list out of context.

**Then drop any ticket carrying the `manager:skip` label.** It marks a ticket the PRD pipeline owns — a
`/to-prd` parent or a `/to-issues` slice — and is the authoritative signal that this skill must not touch it:
do not classify, label, or comment. Set these aside and count them so the report can note how many tickets
were skipped (note them in the report's Notes). `manager:skip` is the **only** exclusion: it is the sole signal
that removes a ticket from triage. **Never infer ownership from a ticket's structure** — a ticket having a
parent (being a `/to-issues` slice) or having sub-issues (being a PRD parent) does **not** exclude it and does
**not** change how it is classified or routed. If the PRD pipeline wants a ticket left alone, it carries
`manager:skip`; absent that label, the ticket is triaged like any other.

For each in-scope issue keep: identifier (`SER-xxxx`), title, current `state`, current `labels`, and `url`.
`list_issues` may return a short or truncated description. Classification leans on the body, so for any ticket
whose description looks thin or missing, call `get_issue` to read the full description before classifying.

**An empty in-scope set is a normal outcome,** not an error — there may simply be nothing assigned to me
queued in `Ready for dev - backlog` right now. If nothing is in scope, report "No tickets assigned to me are
Ready for dev - backlog" (noting any `manager:skip` count) and stop. Do not widen the search or invent work.

## Step 3 — Classify each ticket

For each in-scope ticket, read the title and full description and decide two things: **risk** and
**routing**. Write one or two plain sentences of reasoning that justify both — this is the "why" that
goes in the report and, on `apply`, into the Agent Assessment comment.

**Read the ticket's comments first (`list_comments`).** A ticket back in `Ready for dev - backlog`
with **no `risk:*` label** has usually been bounced back by `solve-ready-tickets` after the autonomous
solver *declined* it — look for a comment starting with `## Autonomous solve — declined`. That comment
is new triage information the original classification didn't have: the solver dug into the work and
found it bigger / more ambiguous / higher-blast-radius than `agent:ready` claimed. **Factor it into both
axes**, and treat it as a hard signal for routing — see the re-triage rule in 3b. (Ordinary tickets with
no such comment classify exactly as before; reading comments just surfaces a prior decline when there is
one.)

### 3a — Risk (how risky to execute unattended)

Assign **exactly one** risk level — how dangerous it is to let an AI agent execute the ticket unattended. This
is about *blast radius and the need for judgement*, not about how hard the work is.

| risk     | when                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `low`    | small, bounded change; clear scope; obvious verification; low blast radius. Docs, simple tests, lint/format fixes, small chores, patch dep bumps, isolated copy or constant changes. |
| `medium` | might be agent-suitable later but needs more confidence, stronger tests, or close human review. Touches shared code, multiple modules, or non-trivial logic without clear judgement calls. |
| `high`   | unattended execution could create meaningful product, security, operational, or data risk. Anything touching auth, billing, data migrations, deployment, security, patient/clinical data, schema changes, or wide-blast-radius logic. |

When torn between two levels, pick the **higher** one — risk classification should be conservative.

### 3b — Routing (who should pick it up)

Decide who should act next. This is the machine-readable handoff that lets an AI agent loop query a safe queue
without re-litigating product risk.

Routing applies to **every** in-scope ticket. `manager:skip` tickets were already dropped in Step 2, and that
label is the *only* thing that removes a ticket from triage — see `~/.claude/docs/agents/triage-labels.md`. A
ticket's structure is irrelevant here: having a parent (being a `/to-issues` slice) or having sub-issues (being
a PRD parent) does **not** suppress routing and does **not** by itself disqualify `agent:ready`. Classify each
in-scope ticket purely on the rules below, on its own merits.

Add **`agent:ready`** only when **all** of these hold:

- risk is `low`
- scope is clear and the work fits in a single pull request
- the expected output and likely verification are known
- no product, UX, architecture, security, data, billing, auth, or deployment judgement is required

Add **`needs:human`** when **any** of these hold:

- requirements or expected behaviour are ambiguous
- a real bug has no reproduction
- the work is too large for one pull request
- it needs product, UX, architecture, security, data, billing, auth, or deployment judgement
- you cannot classify it with confidence
- risk is `high` (high-risk tickets are human-led; an agent may investigate or plan, but must not execute unattended)

Otherwise add **neither** routing label.

Keep routing labels small — `agent:ready` and `needs:human` are the only two. Never put both on one ticket.
When uncertain, prefer `needs:human` over `agent:ready`: a false `agent:ready` sends an agent at work it can't
safely do, which is worse than asking me to look.

**Re-triage rule — a prior solver decline is a hard signal against `agent:ready`.** If the ticket carries a
`## Autonomous solve — declined` comment (Step 3), the autonomous loop already took this ticket and decided it
could *not* be done unattended. Do **not** re-stamp `agent:ready` on the strength of the original description —
that just sends the solver back at work it already declined (a ping-pong loop). Route **`needs:human`** (and
usually raise the risk to match the decline reason) **unless** the comment's specific blocker has been clearly
resolved since — e.g. the description was edited to remove the ambiguity, or a later comment closes it out. When
in doubt, `needs:human`. Note in the report that the routing was driven by a solver decline.

## Step 4 — Map classification → Linear label

Each classification is recorded with a dedicated managed-label namespace — one label per value, across both
axes:

| axis    | value      | label           | color     |
| ------- | ---------- | --------------- | --------- |
| risk    | `low`      | `risk:low`      | `#0e8a16` |
| risk    | `medium`   | `risk:medium`   | `#fbca04` |
| risk    | `high`     | `risk:high`     | `#b60205` |
| routing | agent-ready| `agent:ready`   | `#1d76db` |
| routing | needs-human| `needs:human`   | `#d93f0b` |

A fully-classified ticket therefore carries **one `risk:*` + at most one routing label**. The `type:*` label
is owned by the PRD pipeline (`to-prd` / `to-issues`), not by this skill — leave any existing `type:*` untouched.

**Why a separate managed namespace instead of the team's existing labels** (`Feature`, `Improvement`,
`Bugs → Bug in prod/QA/test`): those existing labels are the team's *product/QA taxonomy* — `Feature` vs
`Improvement` is a roadmap distinction, and the `Bugs` children record *where a bug was found*. This skill
answers different, orthogonal questions (how-risky / who-picks-it-up) and needs clean 1:1 mappings that a
scheduled run can apply unambiguously, without disturbing the product taxonomy a human curates. **This table
is the one place to edit** if the team later decides to fold any of these into existing labels. These
`risk:*` / `agent:ready` / `needs:human` labels are the ones this skill **owns** — see the managed-label rule
in Step 5b.

## Step 5 — Apply (only in `apply` mode)

In `dry-run`, skip this entire step — just report what *would* happen.

In `apply`:

### 5a. Ensure the managed labels exist

List current Seranote labels (`list_issue_labels` with `team: "Seranote"`, `limit: 200`). For each managed
label this run needs (the `risk:*`, `agent:ready`, `needs:human` rows from Step 4) that is
**missing**, create it once with `create_issue_label` (`name`, `color`, `teamId: "<team UUID>"`, and a short
`description`, e.g. "Set by daily-ticket-manager — how risky / who picks it up").
Labels created once persist; later runs only create genuinely new ones.

### 5b. Apply the labels without clobbering, and without downgrading existing managed labels

⚠️ **`save_issue`'s `labels` field replaces the issue's entire label set** — it is not additive. To apply the
managed labels safely, build the full list to write back: take the issue's **current labels**, then add this
run's `risk:*` and routing label.

Two rules govern that merge:

- **Never clobber non-managed labels.** Keep everything the skill doesn't own — `urgent`, `Compliance: *`,
  `Migrated`, `Bugs → …`, `Feature`, `Improvement`, **any `type:*` label** (owned by the PRD pipeline), etc.
  They must survive untouched in the written set.
- **Managed labels are additive; never downgrade an existing one.** Trackers don't record who set a label, so
  treat every existing `risk:*` / `agent:ready` / `needs:human` label as if a human set it
  deliberately. Only **fill gaps** — add a managed label on an axis that has none. If this run's classification
  **disagrees** with an existing managed label (e.g. it already has `risk:low` but you'd assign `risk:medium`,
  or it has `agent:ready` but you'd route `needs:human`), **keep the existing label, do not replace it, and
  raise the disagreement in the report.** The one exception: when adding a routing label, you may drop the
  *other* routing label only if it's clearly stale — otherwise flag it.

If, after the merge, the written set is identical to the current set (the ticket already carries the right
managed labels), **leave it** — don't issue a `save_issue` just to re-write the same labels.

### 5c. Write or update the Agent Assessment comment

The reasoning lives in one comment, not in extra labels. Use this exact block:

```md
## Agent Assessment

Risk: low | medium | high
Agent-ready: yes | no

Reason:
<1–2 sentences: what this ticket does, and why it got this risk and routing.>

Suggested plan:
1. <small first step>
2. <small second step>
3. <verification step>

_Classified by daily-ticket-manager._
```

When the routing is `needs:human`, append — before the marker line — a block naming the blocker:

```md
Human needed:
<the specific question, decision, or missing input required before an agent can execute.>
```

Make it **idempotent** so repeated daily runs don't spam notifications:

1. `list_comments` for the issue.
2. Find an existing comment whose body starts with `## Agent Assessment` and ends with the
   `_Classified by daily-ticket-manager._` marker.
3. If one exists and the risk + routing + reason are unchanged, **do nothing**.
4. If one exists but any of those changed, **update it** (`save_comment` with that comment's `id`).
5. If none exists, **create** one (`save_comment` with `issueId: "SER-xxxx"` and the block as `body`).

## Step 6 — Report

End every run with a compact summary, regardless of mode:

```md
# Ticket triage — Ready for dev
Mode: dry-run | apply   ·   Team: <team>   ·   In scope: <n>   ·   Skipped (manager:skip): <m>

| Ticket   | Title              | Risk   | Routing      | Reason      |
| -------- | ------------------ | ------ | ------------ | ----------- |
| SER-1234 | <short title>      | medium | needs:human  | <one line>  |
| SER-1235 | <short title>      | low    | agent:ready  | <one line>  |
| …        |                    |        |              |             |

## Recommended next pickups (agent:ready)
- SER-1235 — <title> — <why it's safe>

## Needs my attention (needs:human)
- SER-1234 — <title> — <the specific question/decision/blocker>

## Counts
- Risk — low: N  medium: N  high: N
- Routing — agent:ready: N  needs:human: N  unrouted: N

## Notes
- <labels created; comments written/updated/skipped; disagreements with existing managed labels; manager:skip tickets dropped>
- <blockers or missing setup, if any>
```

Lead with the two action lists — **agent:ready** (what I can safely delegate) and **needs:human** (what I must
look at myself) — because that routing is the whole point of the triage; the table is the supporting detail.
In `dry-run` describe what *would* be applied; in `apply` state what was done ("added risk:low +
agent:ready", "already classified", "updated comment", etc.). If a ticket already carries a managed label that
**disagrees** with this run's classification, **do not silently overwrite it** — keep the existing label and
flag the disagreement here.

## Safety rules

- Default to `dry-run`. Mutate Linear only when I pass `apply`.
- Never remove or replace a ticket's existing non-managed labels. Always write the full preserved set (Step 5b).
- Never downgrade or flip an existing managed label (`risk:*` / `agent:ready` / `needs:human`) — only fill gaps. On disagreement, keep the existing label and flag it in the report.
- Assign exactly one `risk:*` per classified ticket; at most one routing label; never both routing labels.
- Never touch `type:*` labels — they're owned by the PRD pipeline (`to-prd` / `to-issues`). Preserve any existing one; never add, change, or remove one.
- Only add `agent:ready` to `risk:low` work that meets every agent-ready condition (Step 3b). Never add `agent:ready` to a `risk:high` ticket.
- `risk:high` tickets get `needs:human` unless already clearly human-owned. When uncertain, prefer `needs:human` over `agent:ready`.
- A ticket carrying a `## Autonomous solve — declined` comment was bounced back by the solver: never re-stamp `agent:ready` on it unless the named blocker is clearly resolved — route `needs:human` to avoid a re-grab/decline loop (Step 3b re-triage rule).
- Don't change ticket state, assignee, title, description, estimate, or any field other than the managed labels.
- Don't create tickets, close tickets, or touch tickets that aren't assigned to me in `Ready for dev - backlog`.
- Only classify/label/comment tickets in `Ready for dev - backlog`. Never touch a ticket in any other status, even if it's mine.
- Never touch a ticket carrying `manager:skip` — it's PRD-pipeline-owned. Drop it from scope (Step 2), fold it into the skip count, and never classify, label, or comment on it. `manager:skip` is the *only* exclusion; never infer ownership from a ticket's parent/sub-issue structure.
- Don't re-write an unchanged Agent Assessment comment.
- An empty in-scope set is a valid result — report it and stop, never widen scope to fill the report.

## Scheduling

This skill is built to run unattended on a daily cadence (e.g. a morning cron). For that, the
schedule prompt must be self-contained: name the team (`Seranote`), the scope (`my tickets, status
Ready for dev - backlog, any cycle`), and the mutation policy (`dry-run` to just get a report, or `apply` to
label + comment). Default a scheduled run to `dry-run` unless I have explicitly approved `apply`. A scheduled
`apply` run still only ever creates managed labels (`risk:*` / `agent:ready` / `needs:human`), fills label gaps
on those axes per ticket, and writes the assessment comment — never downgrading an existing managed label,
never touching `type:*` or any other field.
