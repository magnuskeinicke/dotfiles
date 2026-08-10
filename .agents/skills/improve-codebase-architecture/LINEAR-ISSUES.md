# Linear issues — the deliverable

The architecture review ships as **Linear issues assigned to the user**, with the HTML report ([HTML-REPORT.md](HTML-REPORT.md)) **attached to the parent** so no bespoke visual is lost. Markdown carries the handoff; Linear renders ` ```mermaid ` code blocks natively, so graph-shaped before/after diagrams survive **inline**. Hand-built CSS/SVG visuals do **not** (Linear strips raw HTML) — they live only in the attached report.

## What renders where

| Artifact | In the issue body | In the attached HTML |
| --- | --- | --- |
| Prose — Files / Problem / Solution / Wins / strength / ADR callout | ✅ markdown | ✅ |
| Mermaid before/after (flowchart, state, sequence) | ✅ ` ```mermaid ` block | ✅ |
| Hand-built mass / cross-section / deep-box visuals | ❌ → link to attachment | ✅ |

When a candidate's before/after is **graph-shaped**, inline it as a ` ```mermaid ` block in the issue. When it's a **hand-built** visual, write a one-line textual before→after and point to the attached report (_"full before/after: see the attached architecture-review.html on the parent"_).

## Structure (mirrors `to-issues`)

Read [issue-tracker.md](~/.claude/docs/agents/issue-tracker.md) for the mechanics: Seranote team id, `save_issue`, `parentId`, `save_comment`, **real newlines not `\n`**. Resolve assignee `me` and dup-check via `list_issues` (per the `create-issue` skill) before writing.

**Parent issue — the index / container:**
- Title: `Architecture review: <area | "deepening opportunities"> (<YYYY-MM-DD>)`
- Assignee: me. Team: Seranote. Status: `Triage` / `Backlog`.
- Label: **`manager:skip` only** — it is a container, never a unit of agent work, so keep it out of the daily triage. No `type:*`, no routing, no priority.
- Body: the **Top recommendation** + the report legend + a checklist linking each child — `- [ ] SER-xxx — <candidate title> (<strength>)`.
- **Attach the HTML report** (steps below).

**One child issue per candidate — the unit of work:**
- `parentId` = the parent. Assignee: me. Team: Seranote.
- `blockedBy` **only** when a candidate genuinely depends on another landing first (e.g. the chunk-lifecycle deepening builds on the model seam from the prompt-dispatch one). Otherwise leave them independent — they are not a forced stack.
- Label: **`type:refactor`** (the Conventional Commit type the work ships as; use `type:test` if a candidate is primarily "add the missing orchestration tests"). **No `risk:*`, no routing (`agent:ready` / `needs:human`), no `manager:skip`** — leave routing to `daily-ticket-manager` so the issue flows into the normal assigned queue once it reaches a dev-active status.
- **Priority ← recommendation strength** (native priority, not a new label): `Strong` → High, `Worth exploring` → Medium, `Speculative` → Low.
- Status: **`Ready for dev - backlog`** (id `7a4368ec-5dd4-450b-ad94-baf40fdbe8d1`) — the issue enters the normal dev queue at creation, so `daily-ticket-manager` triages and routes it on its next run. Always assigned to me.
- Body: the template below.

## Child body template

```markdown
## Files
`path:line` · `path:line`

## Problem
One sentence — what hurts.

## Solution
One sentence — what changes.

## Before / after
<inline ```mermaid block when graph-shaped; otherwise a one-line textual before→after
plus: "full before/after: attached architecture-review.html on SER-<parent>">

## Wins
- locality: …
- leverage: …
- interface is the test surface: …

## Recommendation strength
Strong | Worth exploring | Speculative

> **ADR / convention note** — only when the candidate touches a documented decision (see step 2).
```

Use **CONTEXT.md** vocabulary for the domain and **LANGUAGE.md** vocabulary for the architecture — same discipline as the report. Don't propose concrete interfaces in the issue body; that is what the grilling loop (step 3) is for.

## Attaching the HTML report

Generate the report exactly as [HTML-REPORT.md](HTML-REPORT.md) describes and write it to temp, then attach it to the **parent** so the bespoke visuals survive. The report still pulls Tailwind + Mermaid from CDNs, so it needs internet when opened — same as the local file.

1. `prepare_attachment_upload(issue=<parent>, filename="architecture-review-<ts>.html", contentType="text/html", size=<bytes>)` → returns `assetUrl` + `uploadRequest { url, headers }`.
2. **PUT the raw bytes** to `uploadRequest.url`, sending every signed header **verbatim**, within 60s — don't base64 or transform the file:
   `curl -X PUT --data-binary @<path> -H "content-type: text/html" -H "<each signed header>" "<uploadRequest.url>"`
3. `create_attachment_from_upload(issue=<parent>, assetUrl, title="Architecture review report")`.

`create_attachment` (base64) is a deprecated fallback for tiny files — avoid it, it floods context. Also open the report locally (`open` / `xdg-open` / `start`) so the user can review the full visuals immediately.

## Dry run vs apply

Filing issues is an outward-facing write, so it is gated by the skill's mode (see SKILL.md → _Mode: dry run vs apply_):

- **Dry run (default):** write nothing to Linear. Print the file plan — the parent + each child's title, `strength→priority`, labels, status, assignee, `parentId`/`blockedBy`, and a one-line body summary — and end with _"Re-run with `apply` to file these."_ The local HTML report still builds and opens; it is the dry-run preview.
- **`apply`:** create the parent + children, upload + attach the report, set labels/priority/status/assignee. The `apply` flag is the authorization — proceed without a second confirmation, but show what's being created as you go.
