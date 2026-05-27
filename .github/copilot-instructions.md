# Copilot Instructions — Game-main

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
