---
name: to-issues
description: Break a PRD into independently-grabbable, agent-ready sub-issues on the project issue tracker using a walking-skeleton + behaviour-delta split, stacked for small reviewable PRs. Use when the user wants to convert a PRD/plan into implementation tickets or break work into issues.
---

# To Issues

Break a PRD into **independently-grabbable, agent-ready sub-issues** using a **walking skeleton + behaviour deltas** split, ordered as a **stack** so each ships as a small, reviewable PR built on the last.

The split optimises for what an agent one-shots reliably: the **skeleton** slice concentrates every cross-layer decision into one wide-but-shallow end-to-end path; every **delta** slice after it is a localized behaviour addition that mirrors the skeleton and introduces **at most one novel decision**. Slice sizing is by *decision count*, not layer count or LOC — diff size follows.

Each sub-issue must be rich enough that a *fresh* agent can pick it up via `/work-slice` and implement it with `/tdd` — no extra human context needed. That means: end-to-end behaviour, verbatim acceptance criteria, the code-layer pointers to mirror, the exact Figma nodes for any UI, and its place in the stack.

Read `~/.claude/docs/agents/issue-tracker.md` for how this repo's tracker creates child issues and links blockers, `~/.claude/docs/agents/triage-labels.md` for labels, and `~/.claude/docs/agents/repo-config.md` for `goldenPaths` (layer → canonical exemplar file) and `libMap` (lib → purpose). If the first two are missing, run `/setup-matt-pocock-skills` first; missing `goldenPaths`/`libMap` keys just mean you discover exemplars yourself (step 1) and should write them back.

## Input: the parent PRD ticket

Work from the parent ticket that `/to-prd` produced. Take its id from the conversation, or ask. Fetch it **and its comments** — `/to-prd` publishes the PRD as a `# PRD` comment, not in the description, so read the **PRD, acceptance criteria, and links verbatim from that comment** and follow the links to their source-of-truth artifacts. Every slice becomes a **sub-issue of this parent** (`parentId`).

## Process

### 1. Build the code-layer map (and pin the canonical exemplar)

The highest-leverage prep. Start from `repoConfig.goldenPaths` — the blessed exemplar per layer. Where it has an entry, that exemplar is **the** mirror target; don't re-decide. Where it doesn't, find 1–2 existing features of the same kind and **trace them end to end**, recording every layer the new feature touches as a `file:line → what changes / what to mirror` row. Delegate the breadth to an `Explore` subagent if useful. Slices draw their "where to look" and "Convention contract" sections from this map, so the implementing agent starts from pointers instead of re-discovering the architecture.

Repos drift — when two siblings disagree on a convention, pick **one** canonical exemplar deliberately (the one CLAUDE.md blesses, else the newest) and record why. **Write the choice back**: add/update the layer's entry in `goldenPaths` in `~/.claude/docs/agents/repo-config.md` so the next PRD inherits it instead of re-deciding.

Pointers and "mirror X", not edits.

### 2. Gather design context (UI features — non-negotiable)

A slice that renders UI is worthless without exact design. For every screen/state any slice touches:

- Resolve the Figma source via `figma-design-url`. Record the **file key + a per-node deep-link** (one per screen/state).
- Pull the **style tokens** that matter (spacing, type, colours, design-system component names) so the implementer reuses design-system values, not magic numbers.

Put the file key + node deep-links + tokens into the slice body. The implementing agent re-fetches the screenshot itself via the Figma MCP at build time, so bodies stay text-only. If Figma can't be reached, **say so loudly at the top of the affected slice** with the blocker and the unblock step — never silently degrade to a vague description. Include the deep-links regardless.

### 3. Draft the skeleton + delta slices

Break the PRD into **one walking-skeleton slice + N behaviour-delta slices**. Never slice horizontally by layer (integration risk, not demoable), never per-file/per-function (loses AC verifiability), never as temporal "steps" (a ticket describes a state, not a procedure).

<slice-rules>
- **Slice 1 — the walking skeleton (wide, shallow).** The full end-to-end path with the REAL contract: schema, types, API route, UI shell, ONE happy-path behaviour, tests wired. Stubbed/minimal behaviour everywhere else. Every cross-layer decision lands here — where state lives, API shape, error handling, injection points. It is the risk concentrate: downstream deltas mirror its code, so its shape becomes the feature's convention. Demoable on its own ("page loads, saves one record"). If a same-kind exemplar exists in `goldenPaths`, the skeleton is "clone the exemplar's shape" — the cheapest, most reliable slice there is.
- **Slices 2..N — behaviour deltas (narrow, localized).** Each adds the behaviour of 1–2 named acceptance criteria onto the skeleton. Mostly touches 1–2 layers, mostly APPENDS (new handler branch, new component, new test) rather than modifies. Zero-to-one novel decisions; "mirror the skeleton" is the instruction.
- **≤1 novel decision per slice.** The sizing rule — not layer count, not LOC. Name the decision in the slice body (or state "none — pure mirror"). Two decisions → two slices.
- **Contract freeze.** The skeleton publishes the contract; no delta may alter it (schema, types, API shape). A delta that needs a contract change is a stack-restructure signal: stop and requeue, don't quietly edit.
- A completed slice is demoable/verifiable on its own and **ships as one small PR** a human can review without fatigue. If a slice's diff would be too large to review comfortably, split it.
- **Build-green-alone where possible.** A slice's PR should compile on its own. When a slice references a symbol an earlier slice introduces, that's the stack dependency — record it (step 4); don't pretend it's independent.
- **Skeleton first, always.** The rest fan out from it.
</slice-rules>

Mark each slice **AFK** (an agent can implement and open a PR unattended) or **HITL** (needs a human decision/design review first). Prefer AFK for deltas — they carry ≤1 decision by construction. The **skeleton** leans HITL (or at least a flagged, careful review): it makes every decision the rest of the stack inherits, so a wrong skeleton is N wrong slices. HITL slices get the `needs:human` label. AFK slices carry **no routing label of their own** — the `slice:next` work pointer (step 6) marks only the one slice that is up next. **No slice ever gets `agent:ready`**: that label is the autonomous-loop trigger, reserved for `weekly-ticket-manager` on standalone tickets, and must stay off the PRD pipeline (see `~/.claude/docs/agents/triage-labels.md`).

### 4. Define the stack (delivery topology)

Order the slices into a **stack** so PRs stay small and review-friendly — and keep it **shallow** where the deltas allow:

- The **skeleton slice** bases its branch off the repo's default integration branch.
- **Deltas that are file-disjoint from each other stack directly on the skeleton** (fan-out, depth 2) — decidable now from the code-layer map. Disjoint deltas can be worked in parallel worktrees and rebase independently; a deep serial chain costs O(N) restacks and serial wall-clock for no reason.
- **Deltas that collide on files** (or consume a symbol another delta introduces) form a serial chain — each bases its branch off the **previous slice's branch**, so its PR diff shows only that slice's change.
- Express each dependency as a **blocked-by** relation on the tracker (blocker = the slice it stacks on — the skeleton for fanned-out deltas, the predecessor for chained ones). `/work-slice` reads this to pick the next unblocked slice and to choose its branch base.

Record, per slice, **"Stacked on: <predecessor ticket>"** (or "base = default branch" for the skeleton). Branch names aren't known yet — reference the predecessor *ticket*; `/work-slice` resolves the actual branch.

The "Stacked on" line in the body and the **blocked-by relation** on the tracker encode the *same* dependency twice on purpose: the relation is the machine-readable source of truth `/work-slice` queries; the body line is the human-readable note. So there is no separate "Blocked by" field in the template — "Stacked on" *is* the blocked-by, named for what it means in this workflow.

### 5. Quiz the user

Present the breakdown as a numbered list. For each slice show: **Title** · **Kind** (skeleton/delta) · **AFK/HITL** · **Stacked on** (predecessor) · **Novel decision** (the one it introduces, or "none — pure mirror") · **Disjoint?** (can it fan out on the skeleton and run in parallel, or must it chain — and on what) · **User stories / AC covered**. Ask:

- Is the granularity right? (too coarse / too fine — and would any PR be too big to review?)
- Does the skeleton really capture ALL the cross-layer decisions — is any delta hiding a second decision?
- Is the stack topology correct (chain vs fan-out)?
- Should any slices merge or split further?
- Are AFK/HITL right?

Iterate until the user approves.

### 6. Publish the sub-issues

Publish in **stack order** (skeleton first) so you can reference real ids in the "Stacked on" / blocked-by fields. For each approved slice create a sub-issue of the parent (`parentId` = PRD ticket) using the body template below. Reuse the repo's create flow (`~/.claude/docs/agents/issue-tracker.md` — for Linear, the `create-issue` plumbing: team + assignee). Set the blocked-by relation to the predecessor.

Labels per `~/.claude/docs/agents/triage-labels.md` — a `type:*` **and** `manager:skip` on every slice, plus:

- **Every slice** → `manager:skip` — the triage opt-out telling `weekly-ticket-manager` this ticket is PRD-pipeline-owned and must not be classified or routed by the weekly triage. Routing here belongs to `slice:next` + `/work-slice`. Create the label first if the team lacks it (`list_issue_labels` → `create_issue_label`, muted grey e.g. `#6b7280`).
- **HITL slice** → `needs:human`.
- **The skeleton slice, if AFK** → `slice:next` — the work pointer telling `/work-slice` this is the one to pick up. Create the `slice:next` label first if the team lacks it (`list_issue_labels` for the team → `create_issue_label`). Exactly **one** slice carries `slice:next` at a time; `/work-slice` advances it down the stack as each slice reaches PR (with fan-out, sibling deltas become unblocked together — the pointer still marks just the one that is up next; the user may hand siblings to parallel worktrees manually).
- **Downstream AFK slices** → no routing label yet; they receive `slice:next` from `/work-slice` when their turn comes.
- **Never `agent:ready`** on any slice or on the parent — it is the autonomous-loop trigger and stays off the PRD pipeline.

If the skeleton slice is HITL, no slice starts with `slice:next` — tell the user the first slice needs a human before any agent can start.

Do NOT modify the parent ticket's body, status, or assignee.

<subissue-template>
## Parent

[<PARENT-ID>](<parent-url>) — the PRD. Read it for the full picture.

## Kind

**Skeleton** (walking skeleton — publishes the contract, makes the cross-layer decisions) or **Delta** (behaviour delta — mirrors the skeleton, appends behaviour).

## What to build

A concise description of this slice — the end-to-end behaviour it delivers, not a layer-by-layer implementation. Name the contract it publishes (skeleton) or binds to (delta — contract is FROZEN; a needed change means stop + requeue, not a quiet edit).

## Novel decision

The ONE new decision this slice introduces, stated explicitly — or "none — pure mirror".

## Acceptance criteria

- [ ] <verifiable, behaviour-level outcome>
- [ ] <…>

## Where to look (code-layer slice)

The rows of the code-layer map relevant to this slice + what to mirror. `file:line` pointers — not edits. For a **delta**, the primary mirror is the skeleton — this feature's own code; sibling features are fallback. (The skeleton's actual file map arrives as a "Skeleton map" comment on this ticket once the skeleton PR opens — read it first.)

| Layer | File | What to do / mirror |
|-------|------|---------------------|
| <layer> | `path:line` | <pointer> |

## Convention contract (BINDING)

- Exemplar per layer: <layer> → `<goldenPaths entry or the canonical sibling chosen in step 1>` — mirror it; deviations must be declared in the PR's provenance table with a reason.
- Must-use libs/utilities: <e.g. `createBaseRepo`, design-system tokens/components — from `libMap`>.
- No new helper/util/hook/component without first searching `libs/**` for an existing equivalent.

## Design (UI slices only)

- Figma: file key `<KEY>`, node `<node-id>` — <deep-link>
- Tokens / components: <spacing, type, colours, design-system component names>
- Fetch the screenshot fresh via the Figma MCP at build time.
- ⚠️ <access blocker, if any — loud, with the unblock step>

## Stacked on

<predecessor ticket id> — base this slice's branch off that slice's PR branch. For a fanned-out delta this is the skeleton's ticket. (Skeleton: "base = default integration branch.") This is also set as the **blocked-by relation** on the tracker; the relation, not this line, is what `/work-slice` reads.

</subissue-template>

Avoid specific code snippets — they go stale. Exception: a prototype snippet that encodes a decision more precisely than prose (state machine, reducer, schema, type shape) — inline the decision-rich bits and note it came from a prototype.

## Done when

Exactly one slice is the walking skeleton and every delta names its novel decision (or "none — pure mirror"). Every slice is a sub-issue of the PRD parent, carries acceptance criteria + code-layer pointers + a Convention contract (+ for UI: Figma nodes + tokens), names what it stacks on via a blocked-by relation, and is labelled `type:*` + `manager:skip` (plus `needs:human` for HITL); the skeleton AFK slice also carries `slice:next`. No slice carries `agent:ready`. Any newly-pinned exemplars are written back to `goldenPaths` in `repo-config.md`. Tell the user to run `/work-slice` to start the skeleton slice.
