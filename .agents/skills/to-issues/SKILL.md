---
name: to-issues
description: Break a PRD into independently-grabbable, agent-ready sub-issues on the project issue tracker using tracer-bullet vertical slices, stacked for small reviewable PRs. Use when the user wants to convert a PRD/plan into implementation tickets or break work into issues.
---

# To Issues

Break a PRD into **independently-grabbable, agent-ready sub-issues** using vertical slices (tracer bullets), ordered as a **stack** so each ships as a small, reviewable PR built on the last.

Each sub-issue must be rich enough that a *fresh* agent can pick it up via `/work-slice` and implement it with `/tdd` — no extra human context needed. That means: end-to-end behaviour, verbatim acceptance criteria, the code-layer pointers to mirror, the exact Figma nodes for any UI, and its place in the stack.

Read `~/.claude/docs/agents/issue-tracker.md` for how this repo's tracker creates child issues and links blockers, and `~/.claude/docs/agents/triage-labels.md` for labels. If those files are missing, run `/setup-matt-pocock-skills` first.

## Input: the parent PRD ticket

Work from the parent ticket that `/to-prd` produced. Take its id from the conversation, or ask. Fetch it **and its comments** — `/to-prd` publishes the PRD as a `# PRD` comment, not in the description, so read the **PRD, acceptance criteria, and links verbatim from that comment** and follow the links to their source-of-truth artifacts. Every slice becomes a **sub-issue of this parent** (`parentId`).

## Process

### 1. Build the code-layer map

The highest-leverage prep. Find 1–2 existing features of the same kind already in the codebase and **trace them end to end**, recording every layer the new feature touches as a `file:line → what changes / what to mirror` row. Delegate the breadth to an `Explore` subagent if useful. Slices draw their "where to look" section from this map, so the implementing agent starts from pointers instead of re-discovering the architecture.

Pointers and "mirror X", not edits.

### 2. Gather design context (UI features — non-negotiable)

A slice that renders UI is worthless without exact design. For every screen/state any slice touches:

- Resolve the Figma source via `figma-design-url`. Record the **file key + a per-node deep-link** (one per screen/state).
- Pull the **style tokens** that matter (spacing, type, colours, design-system component names) so the implementer reuses design-system values, not magic numbers.

Put the file key + node deep-links + tokens into the slice body. The implementing agent re-fetches the screenshot itself via the Figma MCP at build time, so bodies stay text-only. If Figma can't be reached, **say so loudly at the top of the affected slice** with the blocker and the unblock step — never silently degrade to a vague description. Include the deep-links regardless.

### 3. Draft vertical slices

Break the PRD into **tracer-bullet** sub-issues. Each is a thin vertical slice that cuts through ALL layers end-to-end (schema → API → UI → tests), NOT a horizontal slice of one layer.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer it touches.
- A completed slice is demoable/verifiable on its own and **ships as one small PR** a human can review without fatigue. If a slice's diff would be too large to review comfortably, split it.
- Prefer many thin slices over few thick ones.
- **Build-green-alone where possible.** A slice's PR should compile on its own. When a slice references a symbol an earlier slice introduces, that's the stack dependency — record it (step 4); don't pretend it's independent.
- **Foundation first.** Usually one slice defines the shared contract (types / keys / DB columns / injection points). Make it explicit and first; the rest fan out from it.
</vertical-slice-rules>

Mark each slice **AFK** (an agent can implement and open a PR unattended) or **HITL** (needs a human decision/design review first). Prefer AFK. HITL slices get the `needs:human` label. AFK slices carry **no routing label of their own** — the `slice:next` work pointer (step 6) marks only the one slice that is up next. **No slice ever gets `agent:ready`**: that label is the autonomous-loop trigger, reserved for `weekly-ticket-manager` on standalone tickets, and must stay off the PRD pipeline (see `~/.claude/docs/agents/triage-labels.md`).

### 4. Define the stack (delivery topology)

Order the slices into a **stack** so PRs stay small and review-friendly:

- The **foundation slice** bases its branch off the repo's default integration branch.
- Each downstream slice bases its branch off the **previous slice's branch** — its PR diff then shows only that slice's change, not the whole feature.
- Express each dependency as a **blocked-by** relation on the tracker (blocker = the slice it stacks on). `/work-slice` reads this to pick the next unblocked slice and to choose its branch base.

Record, per slice, **"Stacked on: <predecessor ticket>"** (or "base = default branch" for the foundation). Branch names aren't known yet — reference the predecessor *ticket*; `/work-slice` resolves the actual branch.

The "Stacked on" line in the body and the **blocked-by relation** on the tracker encode the *same* dependency twice on purpose: the relation is the machine-readable source of truth `/work-slice` queries; the body line is the human-readable note. So there is no separate "Blocked by" field in the template — "Stacked on" *is* the blocked-by, named for what it means in this workflow.

### 5. Quiz the user

Present the breakdown as a numbered list. For each slice show: **Title** · **AFK/HITL** · **Stacked on** (predecessor) · **User stories / AC covered**. Ask:

- Is the granularity right? (too coarse / too fine — and would any PR be too big to review?)
- Is the stack order correct?
- Should any slices merge or split further?
- Are AFK/HITL right?

Iterate until the user approves.

### 6. Publish the sub-issues

Publish in **stack order** (foundation first) so you can reference real ids in the "Stacked on" / blocked-by fields. For each approved slice create a sub-issue of the parent (`parentId` = PRD ticket) using the body template below. Reuse the repo's create flow (`~/.claude/docs/agents/issue-tracker.md` — for Linear, the `create-issue` plumbing: team + assignee). Set the blocked-by relation to the predecessor.

Labels per `~/.claude/docs/agents/triage-labels.md` — a `type:*` **and** `manager:skip` on every slice, plus:

- **Every slice** → `manager:skip` — the triage opt-out telling `weekly-ticket-manager` this ticket is PRD-pipeline-owned and must not be classified or routed by the weekly triage. Routing here belongs to `slice:next` + `/work-slice`. Create the label first if the team lacks it (`list_issue_labels` → `create_issue_label`, muted grey e.g. `#6b7280`).
- **HITL slice** → `needs:human`.
- **The foundation slice, if AFK** → `slice:next` — the work pointer telling `/work-slice` this is the one to pick up. Create the `slice:next` label first if the team lacks it (`list_issue_labels` for the team → `create_issue_label`). Exactly **one** slice carries `slice:next` at a time; `/work-slice` advances it down the stack as each slice reaches PR.
- **Downstream AFK slices** → no routing label yet; they receive `slice:next` from `/work-slice` when their turn comes.
- **Never `agent:ready`** on any slice or on the parent — it is the autonomous-loop trigger and stays off the PRD pipeline.

If the foundation slice is HITL, no slice starts with `slice:next` — tell the user the first slice needs a human before any agent can start.

Do NOT modify the parent ticket's body, status, or assignee.

<subissue-template>
## Parent

[<PARENT-ID>](<parent-url>) — the PRD. Read it for the full picture.

## What to build

A concise description of this vertical slice — the end-to-end behaviour it delivers, not a layer-by-layer implementation. Name the contract it publishes (if foundation) or binds to (if downstream).

## Acceptance criteria

- [ ] <verifiable, behaviour-level outcome>
- [ ] <…>

## Where to look (code-layer slice)

The rows of the code-layer map relevant to this slice + which sibling to mirror. `file:line` pointers — not edits.

| Layer | File | What to do / mirror |
|-------|------|---------------------|
| <layer> | `path:line` | <pointer> |

## Design (UI slices only)

- Figma: file key `<KEY>`, node `<node-id>` — <deep-link>
- Tokens / components: <spacing, type, colours, design-system component names>
- Fetch the screenshot fresh via the Figma MCP at build time.
- ⚠️ <access blocker, if any — loud, with the unblock step>

## Stacked on

<predecessor ticket id> — base this slice's branch off that slice's PR branch. (Foundation: "base = default integration branch.") This is also set as the **blocked-by relation** on the tracker; the relation, not this line, is what `/work-slice` reads.

</subissue-template>

Avoid specific code snippets — they go stale. Exception: a prototype snippet that encodes a decision more precisely than prose (state machine, reducer, schema, type shape) — inline the decision-rich bits and note it came from a prototype.

## Done when

Every slice is a sub-issue of the PRD parent, carries acceptance criteria + code-layer pointers + (for UI) Figma nodes + tokens, names what it stacks on via a blocked-by relation, and is labelled `type:*` + `manager:skip` (plus `needs:human` for HITL); the foundation AFK slice also carries `slice:next`. No slice carries `agent:ready`. Tell the user to run `/work-slice` to start the foundation slice.
