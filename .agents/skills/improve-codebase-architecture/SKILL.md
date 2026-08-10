---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase, informed by the domain language in CONTEXT.md and the decisions in docs/adr/, and file them as Linear issues assigned to the user (with a visual HTML report attached). Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable. Defaults to a read-only dry run (explores + builds the HTML report as a preview); only creates/updates Linear, uploads the attachment, and writes CONTEXT.md/ADRs when invoked with `apply`.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

## Mode: dry run vs apply

Parse the invocation args. Default is a **read-only dry run**; treat an `apply` token in the args as the signal to write. (`dry-run` may be passed explicitly to force the default.)

| | Dry run (default) | `apply` |
| --- | --- | --- |
| Step 1 — Explore | runs | runs |
| Step 2a — build + open HTML report (local temp) | runs (this **is** the preview) | runs |
| Step 2b — create parent + child issues, upload + attach report, set labels/priority/status/assignee | **preview only** — print the file plan, write nothing to Linear | creates everything |
| Step 3 — grilling loop's Linear writes (body updates, status, cancel) + CONTEXT.md / ADR writes | describe what it *would* write | writes for real |

The `apply` flag is the authorization — on `apply` proceed with the writes (show what's being created; no extra confirm needed). In dry run, end step 2 with: _"Re-run with `apply` to file these."_

## Process

### 1. Explore

Read the project's domain glossary and any ADRs in the area you're touching first. Their location is set by `~/.claude/docs/agents/domain.md`; for this POC they live **globally** at `~/.claude/docs/agents/CONTEXT.md` and `~/.claude/docs/agents/adr/`, not in the repo. When this skill later says to add a term to `CONTEXT.md`, write to that global file.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. File candidates as Linear issues (with the report attached)

The deliverable is **Linear issues assigned to the user** — one parent container issue and one child issue per candidate — with a visual HTML report **attached to the parent** so no diagram is lost. See [LINEAR-ISSUES.md](LINEAR-ISSUES.md) for the full structure, body template, label/priority/status mapping, dup-check, and attachment-upload steps; the orchestration below is the overview.

**a. Build the HTML report** (now the *attachment*, not the sole deliverable). Write a self-contained file to the OS temp dir so nothing lands in the repo: resolve the temp dir from `$TMPDIR`, fall back to `/tmp` (or `%TEMP%` on Windows), write to `<tmpdir>/architecture-review-<timestamp>.html`. Open it locally — `open` (macOS) / `xdg-open` (Linux) / `start` (Windows) — so the user sees the full visuals immediately. The report uses **Tailwind via CDN** and **Mermaid via CDN**; mix Mermaid (graph-shaped relationships — call graphs, dependencies, sequences) with hand-built divs/SVG (editorial visuals — mass diagrams, cross-sections). Each candidate gets a **before/after visualisation**. Be visual. See [HTML-REPORT.md](HTML-REPORT.md) for the scaffold, diagram patterns, and styling.

**b. File the issues** _(`apply` only — in dry run, print the file plan instead: the parent + each child's title, strength→priority, labels, status, assignee, relations, and a one-line body summary, then "Re-run with `apply` to file these")_. Create the parent (attach the report) and one child per candidate, assigned to the user. Each candidate carries the same content as the report card — **Files, Problem, Solution, Wins (in terms of locality and leverage, and how tests improve), Before/after, Recommendation strength** (`Strong` / `Worth exploring` / `Speculative`) — as issue markdown. **Inline the before/after as a ` ```mermaid ` block when the diagram is graph-shaped** (Linear renders it natively); when it's a hand-built visual, write a one-line textual before→after and point to the attached report. The parent body holds the **Top recommendation** (which candidate you'd tackle first and why) + a checklist linking the children.

**Use CONTEXT.md vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the child body (e.g. an `> ADR / convention note` callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

Do NOT propose interfaces yet — that is what the grilling loop is for. **Filing issues is an outward-facing write: confirm the planned parent + child titles and strengths with the user before creating, unless they've said "just file them."** After the issues exist, ask: "Which of these would you like to grill?"

### 3. Grilling loop

Once the user picks a candidate (now an existing child issue), drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

The candidate's child issue is the live document — keep it in sync as the design sharpens. (Grilling presumes the issues exist, so it follows an `apply` run. In a dry run, hold the conversation but describe the Linear/doc writes rather than making them.)

- **Refining the candidate?** Update the child issue body (`save_issue` with its `id`) as the deepened-module shape, the seam, and the surviving tests crystallize. The issue should always reflect the current best understanding.
- **Candidate too large for a single PR?** The children already sit in `Ready for dev - backlog`; for one that needs slicing, hand it to `/grill-with-docs` → `/to-prd` → `/to-issues` (which re-parents the slices and stamps `manager:skip`).
- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md` — same discipline as `/grill-with-docs` (see [CONTEXT-FORMAT.md](../grill-with-docs/CONTEXT-FORMAT.md)). Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Set the child issue's status to `Cancelled` (the `wontfix` equivalent — there is no label), and offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. See [ADR-FORMAT.md](../grill-with-docs/ADR-FORMAT.md).
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).
