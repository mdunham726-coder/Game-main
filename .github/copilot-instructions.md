# Copilot Instructions — Game-main

## REASONING & PLANNING DOCTRINE (OVERRIDES ALL ELSE)

This section is the highest-priority instruction set. When it conflicts with any other instruction, this section wins.

### Core Doctrine
- Research before planning. Trace the real failing path before suggesting a fix.
- Fix root causes, not just the immediate symptom.
- Preserve existing behavior unless a behavior change is explicitly intended.
- Minimize blast radius. Prefer surgical edits over broad rewrites.
- Do not manufacture new abstractions, helper layers, normalization passes, schema fields, or architectural refactors unless the existing structure provably cannot support the fix safely.
- A narrow localized fix is preferred over a theoretically cleaner redesign if the redesign increases blast radius.
- Do not broaden ontology, semantics, or matching rules unless the evidence proves that is required.
- Do not silently reinterpret ambiguous user language into stronger semantics than the current contract already supports.
- Do not infer semantic meaning from null, defaults, or omissions unless the contract explicitly says so.
- Do not guess ownership of fields, state, helpers, or write paths. Verify them in source first.
- Distinguish observed facts from inference from uncertainty. Label every claim.
- Check for contradictions in your own plan, assumptions, and verification matrix.
- State explicit scope exclusions so the task does not silently expand.
- If the true root is not yet proven, stop and ask for the missing evidence rather than inventing confidence.

### Required Workflow
1. Read the relevant source files and trace the execution or data path end to end.
2. Report the exact failing branch, handoff, contract break, or ambiguity with receipts.
3. Identify the semantic authority for the behavior in question. State which layer is supposed to know the truth.
4. Before proposing any semantic change, explicitly state:
   - current behavior,
   - intended new behavior,
   - behaviors that must remain unchanged.
5. List the invariants that must remain true after the fix.
6. List scope exclusions: what this task will NOT change.
7. Only then propose the minimal safe plan.
8. Before coding, provide a verification matrix covering:
   - intended fixed behavior,
   - unchanged existing behavior,
   - edge cases,
   - negative cases,
   - contradiction checks.
9. If coding is requested, implement in small bounded steps and verify each step before proceeding.

### Output Format (Plan Mode)
- Observed facts
- Inferences
- Uncertainties
- Semantic authority
- Current behavior
- Intended new behavior
- Unchanged behavior
- Invariants to preserve
- Scope exclusions
- Minimal safe plan
- Verification matrix
- Implementation steps (only if requested)

### Evidence Rules
- Cite file names, function names, and line ranges whenever possible.
- If something is inferred rather than observed, label it explicitly as inference.
- If you have not verified a path in source, say you have not verified it.
- Do not present guesses as findings.

### Planning Quality Rules
- Describe the problem precisely before prescribing the fix.
- If multiple fixes are possible, prefer the one with the narrowest semantic impact.
- If a proposed fix changes behavior outside the target bug, call that out explicitly.
- If the true root is not yet proven, stop and ask for the missing evidence.
- If a helper or abstraction is being reused outside its original semantic direction, examine that as a possible smell before endorsing reuse.
- Do not default to subsystem redesign because a bug was found. First prove that the existing structure cannot safely support a localized fix.

### Implementation Rules
- Make the smallest change that solves the proven problem.
- Keep names, contracts, and behavior stable unless change is necessary and explicitly justified.
- Do not mix cleanup, refactor, and bugfix work in the same patch unless required for correctness.
- After edits, re-check that the implementation matches the plan and did not silently drift.

### Speed vs. Correctness
Never optimize for speed over correctness. Disciplined reasoning, preserved behavior, narrow scope, and verified claims are valued above all else.

---

## POST-PATCH MANDATORY SEQUENCE
Every patch to this codebase must complete ALL six steps before it is considered done.
Do NOT wait for the user to ask — execute automatically after every commit.

1. **Version bump** — update `package.json` `"version"` field to the new version number
2. **Syntax check** — run `node --check index.js` (and any other edited JS files); fix before proceeding
3. **Commit** — `git commit -m "vX.XX.XX: brief description"`
4. **Push** — `git push origin main` immediately; no batching, no exceptions
5. **Update CHANGELOG** — `c:\Users\daddy\Desktop\CHANGELOG.md`
6. **Update Documentation** — `c:\Users\daddy\Desktop\ULTIMATE_DUNGEON_MASTER_GAME_DOCUMENTATION_PART2.md`

Steps 5 and 6 are NOT optional. They are part of the patch workflow, not a separate request.

---

## CHANGELOG FORMAT (`c:\Users\daddy\Desktop\CHANGELOG.md`)

Each entry follows this structure immediately below the `---` separator at the top:

```
## [X.XX.XX] — Month Year
**Fix/Feature: Short descriptive title**
- `file.js` what changed and why — mechanistic detail, not narrative
- Root cause: what was wrong before and why
- No changes to X, Y, Z (scope boundaries)
- Package X.XX.XX.

---
```

If a `## [X.XX.XX]` entry for the current version already exists, **replace it** with the new content.
If it does not exist, prepend it below the top `---` separator line.

---

## DOCUMENTATION FORMAT (`c:\Users\daddy\Desktop\ULTIMATE_DUNGEON_MASTER_GAME_DOCUMENTATION_PART2.md`)

The file contains a `**Development History**` bullet list, one line per version, newest first.

Each entry follows this pattern:
```
- X.XX.XX complete -- summary of what changed; root cause if applicable; no changes to X, Y, Z. Package X.XX.XX.
```

To add a new version entry: **prepend** a new bullet immediately after the `**Development History** (newest first):` heading line.
If an entry for the current version already exists, replace that bullet line in place.

---

## GIT HYGIENE

- Always commit before starting any editing session
- `git checkout Index.html` is the emergency rollback for that file
- **MANDATORY: `git push origin main` immediately after every `git commit`** — no exceptions, no batching
- The sequence is commit → push → CHANGELOG → docs → done. Never declare a patch complete before all four post-code steps are finished.

---

## EDITING DISCIPLINE

- Use `replace_string_in_file` exclusively for all file edits — never PowerShell text manipulation
- Include 3–5 lines of unchanged context above and below every replacement
- Surgical edits only: one contiguous range at a time, one file per replace call
- For multiple independent edits in the same session: use `multi_replace_string_in_file`
- After each edit: read back the changed section to verify
- Run `node --check` after every JS edit before committing
- If `replace_string_in_file` fails twice with the same approach, stop and diagnose

**HIGH-RISK FILES — surgical only, no exceptions:**
- `index.js`
- `ContinuityBrain.js`
- `ObjectHelper.js`
- `ActionProcessor.js`

---

## CROSS-REFERENCE VERIFICATION (MANDATORY BEFORE COMMIT)

When writing new code blocks that mirror or parallel existing code (e.g., identical guards in drop/throw, copied patterns across functions):

1. **Grep every variable reference** in the new code against the function signature. If the function takes `state`, every reference must be `state` — never `gameState`, `gs`, or any other name. One mismatched variable in a rarely-hit branch can ship undetected.
2. **Diff identical blocks.** If two blocks claim to be "structurally identical" (e.g., the drop and throw partial-stack guards), diff them line-by-line before committing. A difference in variable naming, reason strings, or log verbs is expected; a difference in core references is a bug.
3. **Never assume.** "Throw looked right so drop must be the same" is not verification. Read both blocks independently.

These steps take seconds and prevent the most common class of post-commit hotfixes.

---

## NO LITERAL EXAMPLES IN LLM PROMPTS

Never embed specific object names, NPC names, turn details, locations, or scenario specifics inside prompt strings in the codebase. Instructions must describe the pattern, not exemplify a specific case. Applies to all files containing LLM prompt text.

---

## TEMPORARY INSTRUMENTATION

- Temporary diagnostic `console.log` lines are allowed during investigation.
- If a diagnostic is added to **prove** a hypothesis, the observed output must be captured and cited before the instrument is removed.
- Do NOT declare a proof step complete based on instrumentation alone — the evidence must have been actually observed and retained.
- Clean up all temporary instrumentation before committing. No diagnostic logs in shipped code.

---

## TESTING & HARNESS

- **Mother Brain** owns harness execution and regression sweeps. Do NOT run `node test-harness.js` or probe commands directly — Mother Brain will run them when requested.
- Do NOT start the game server (`node index.js`) unless explicitly asked. Mother Brain or the user manages the live server.
- Long-running verification sweeps may be delegated to Mother Brain. Only Mother Brain may declare them complete after reviewing results.
- Syntax checks (`node --check`) are the exception — run those locally after every JS edit.
