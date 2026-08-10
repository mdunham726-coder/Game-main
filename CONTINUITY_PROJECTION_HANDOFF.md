# Continuity Projection — Coding Agent Handoff

This is the cover note. It tells you what to read, what is already decided, what you may not decide, and
what you are authorized to do. It is short on purpose — the content lives in the two documents below.

---

## What is being built

A new standalone component that replaces the continuity block the narrator receives each turn. Today that
block is produced by `assembleContinuityPacket` inside `ContinuityBrain.js`, which performs implicit,
unlogged, partly unbounded selection over accumulated facts and returns a flat string.

The replacement makes selection **identified, explicit, reasoned, archived, and bounded**. Every fact
carries a verdict (`live` / `memory` / `retired`) and an archived reason. It does **not** make the engine
better-informed about truth — no new evidence source is added, and none may be designed.

---

## Read these, in this order

| # | File | Why |
|---|---|---|
| 1 | `.github/copilot-instructions.md` | **Governs your conduct.** Source-first reasoning, explicit authorization, scope discipline, and a prohibition on claiming validation you did not run. Read it first and follow it. If your platform does not load it automatically, load it manually |
| 2 | `CONTINUITY_PROJECTION_REQUIREMENTS.md` | **The what.** 33 requirements, 33 source-verified facts, the category matrix, the classification table, unchanged behavior, 43 verification rows, 10 stop conditions |
| 3 | `CONTINUITY_PROJECTION_IMPLEMENTATION_PLAN.md` | **The how.** File, interface, packet shape, archive envelope, five phases, shadow mechanism, failure path |

The plan cites requirement, fact, and verification IDs (`R-n`, `F-n`, `V-n`) without restating them.
**You need both documents.** The plan alone is not sufficient.

`CONTINUITY_PROJECTION_PLANNING_CHARTER.md` is optional context — its invariants are reproduced in the
requirements' §9. `CONTINUITY_PROJECTION_PLAN_INPUTS.md` and `research-notes-continuity-packet.md` are
provenance and are **not** needed.

You also need read access to the repository. Every `file:line` citation must be re-verified before you
edit anything.

---

## State you are starting from

- **Source was audited at HEAD `a856c99`, branch `main`, for G-10.** Phases 1–3 have since been
  implemented against that source, corrected after a post-implementation follow-up review (six defects
  found and fixed — see the plan's revision 7 and the requirements' revision 2), and committed as
  `e7b51bf` on branch `continuity-projection-shadow`, pushed to origin.
- **Your starting HEAD should be `e7b51bf` on `continuity-projection-shadow`.** If it is not, treat that
  as this handoff's version of stop condition S-1 for this session — re-verify against actual current
  source before proceeding; do not assume the difference is harmless.
- **The plan's file:line citations for the Phase 4 edit site are stale by line number, not by
  substance** — they were written against the pre-Phase-2 tree, and Phases 2–3 inserted lines ahead of
  them. Re-verified just now, current source has: the require at `index.js:37` (plan cites `:36`); the
  shadow-invocation block spanning `index.js:4474–4523`, with the actual
  `CP.project(gameState, _cbShadowMeta, { shadow: true })` call at `:4488` and the live
  `CB.assembleContinuityPacket(gameState, _cbMeta)` call at `:4495` (plan cites the whole block as
  `:4473–4476`); and the archive block's `continuity_packet` key opening at `:8371` (plan cites `:8262`).
  These numbers are a snapshot from this update, not a live value — re-verify them yourself before
  editing regardless.
- **Six charter amendments are enacted** (charter revisions 8, 9, 10). The requirements depend on them.
  If any is missing or reverted, that is **S-3**.
- **Planning is closed.** G-1 through G-10 complete; requirements passed G-8 after four audit rounds, the
  plan passed G-10 after three.

---

## What you are authorized to do

**Phases 1, 2, and 3 are already complete — not pending, nothing here for you to build.** They were
implemented, corrected, committed, and pushed; see "State you are starting from" above. If source
contradicts what the plan or requirements describe for Phases 1–3, that is drift to report, not work to
redo.

**Phase 4 is the cutover, and this document does not authorize it — that has not changed.** It is the
first change a player can observe. It requires three things; here is where each actually stands right
now, evidence-based, not assumed:

1. Shadow comparison run over a period including **deliberately constructed overflow cases** for C-1,
   C-2, and C-3 — **satisfied.** All five categories, C-1 through C-5, have fired against real or
   deliberately constructed data, each with both `compatEqual` and `structural.approved` holding. The
   unrecognized-bucket vocabulary path and the founding-friend L0 path have each been separately
   exercised against real or realistically-constructed data as well.
2. No difference outside the approved set — **satisfied**, by the same evidence.
3. **A separate, explicit authorization from the user, given after they have looked at real
   before-and-after output — this is a procedural act, not an evidentiary one, and items 1 and 2 being
   satisfied does not supply it.** The user has already read real `compat`/`live` comparisons and
   accepted the 10/12/8 bounds, in a *prior* conversation. That is not authorization for *this* session
   to make the edit. Per the Authorization section at the bottom of this document, it must be given
   fresh, in **this** chat, in words that name the files and the action. Do not infer it from items 1–2,
   from this document's tone, or from the user having opened this session with these files.

**Phase 5 removes the old code and comes later still**, once Phase 4 has run without incident for a
period the user judges sufficient. It is not mechanically gated. Not this session's concern.

Stop and ask if Phase 4 authorization has not been given in words, in this chat, naming the files and the
action — regardless of how satisfied the preconditions above look.

---

## Already decided — do not revisit

Category policies and bounds · disposition semantics · the classification of every element including the
three absence markers · failure behavior by class · the tiebreak order · the single-use clear's timing and
owner · the projection point · the file name, interface, packet structure, archive envelope, phase
ordering, and shadow mechanism.

These were settled across ten planning gates and seven audit rounds. If one looks wrong, say so and stop —
do not quietly improve it.

## You must not decide

- what a category's bound is;
- what class an element belongs to;
- what replays on failure;
- whether a difference in shadow comparison is acceptable;
- whether a stop condition has been met.

If the work seems to require one of these, a settled decision has been misread. That is **S-P4** — stop
and identify which.

---

## Known and accepted

**Tests will break at Phase 5.** `tests/actor-possession-authority.test.cjs` calls
`CB.assembleContinuityPacket` directly, and three probe/scenario fixtures reference it by name. The user
has explicitly accepted this. **Report the breakage; do not repair it, and do not expand scope into
fixing tests.**

---

## Highest-risk defects, so you can watch for them

Four things are easy to get wrong and were each caught during audit. **All four have since been checked
against the implemented code, not just the design — with mixed results, stated precisely so you know what
is proven and what is merely designed:**

1. **C-5's render order.** It is *first-appearance order of canonical keys*, not `turn_set` descending.
   The substring-replacement branch mutates a survivor in place without repositioning it. It looks like a
   bug. It is not. Sorting it "correctly" breaks the shadow gate — `V-23`. **Correct as built.** General
   C-5 overflow behavior is confirmed against real archived gameplay; the specific substring-replacement
   collision branch is proven only by a differential test harness against a constructed fixture — no real
   save has yet been observed to produce one.
2. **The identity breadcrumb reset** must happen before any operation that can throw, or a failed
   projection leaves a stale value visible in the HTTP response — `V-29`. **Found genuinely violated in
   the initial implementation** — `project()` read `options.shadow` before resetting, and a hostile
   `options` object could throw there and skip the reset. Fixed via a reset-containment ruling: shadow
   determination is now read defensively before the reset, and the reset remains the first *state
   mutation* on every non-shadow call. See plan revision 7.
3. **`state_attrs_suppressed`** counts age-rule exclusions **only**. Folding the new count-bound
   exclusions into it silently changes a documented diagnostic — `V-26`. **Correct as built and
   confirmed** — a real overflow turn showed the counter moving independently of the new bound-exclusion
   counts, never absorbing them.
4. **The founding-friend L0 path** — the `w._visible_npcs` fallback — must survive input supply intact.
   Simplifying it out removes NPC content from turn 1 — `V-42`. **Correct as built, and since confirmed
   against real play**, not just a fixture: a founding NPC was created, absent from the projector's
   candidate list for exactly one turn (a general one-turn lag also seen in C-3's declared-fact
   promotion — not a defect), then present and rendered identically to the real unmodified assembler from
   the following turn on.

---

## Validation expected

Syntax check every changed file. Satisfy each phase's exit criteria in the plan's §7 before starting the
next phase. **Do not claim a check passed unless you ran it and saw the output.**

---

## Authorization

The user grants coding authorization in chat. This document does not grant it. Until it is given in
words that name the files and the action, produce a plan or a question — not an edit.
