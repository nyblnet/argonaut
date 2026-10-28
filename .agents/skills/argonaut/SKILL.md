---
name: argonaut
description: Autonomous, self-correcting Intent Lock -> Contrastive Plan -> TDD -> Verify -> Adversarial Critic Diff Review loop. Automatically invoke this skill for any bug fix, feature implementation, refactor, or complex engineering task, or when called via /argonaut.
---

# Argonaut Continuous Autonomous Engineering Loop

Operate as a self-healing state machine (**Phases 0–5**). Once intent is locked in Phase 1, **do not yield control back to the user** while any verification gate or adversarial audit check is failing unless you hit the 10-iteration circuit breaker or require external credentials.

## Phase 0: Product Intent Lock & Ambiguity Gate
1. **Audit for Ambiguity & Architectural Redesign:** If requirements are ambiguous or the user asks to **rework, redesign, rethink, or overhaul** a layout/architecture (or flags a **"wrong approach"**), STOP before coding. Inspect 2–3 peer exemplar modules first, then call `ask_question` to align with the user on the structural design.
2. **Extract Verbatim Constraints:** Identify every positive directive, negative constraint ("do not touch X"), and product goal.

## Phase 1: Deep Recon & Contrastive Anti-Laziness Planning
1. Inspect relevant modules, peer exemplars, types, callers, and tests.
2. Initialize `.agents/argonaut-state.md` once (`Status`: `PLANNING`, `IMPLEMENTING`, `VERIFYING`, `AUDITING`, `COMPLETED`, `BLOCKED`).
   > **Note:** `pre_edit_guard.py` blocks workspace edits until `.agents/argonaut-state.md` is active with `## User Intent & Constraints` and `## Root-Cause & Architecture Plan` (`Reference Benchmark / Prior Art`, `Forbidden Lazy Shortcut`, `Required Root-Level Solution`).
   ```markdown
   # Argonaut Loop State
   - **Task:** <1-sentence objective>
   - **Iteration:** 0 / 10
   - **Status:** PLANNING
   - **Allowed Files:** <comma-separated paths/globs, or *>
   - **Forbidden Files:** <comma-separated paths/globs, or none>

   ## User Intent & Constraints (Must Honor 100%)
   - [ ] **Product Goal:** <Exact user-facing outcome requested>
   - [ ] **Explicit Constraint 1:** <Verbatim instruction or constraint from user prompt>
   - [ ] **Non-Goals / Do-Not-Touch:** <What NOT to change, or "None specified">

   ## Acceptance Criteria
   - [ ] Criterion 1

   ## Root-Cause & Architecture Plan
   - **Reference Benchmark / Prior Art:** <Existing peer modules or template files inspected>
   - **Root Anchor / Schema Files:** <Root plan/schema/interface files to modify FIRST, or none>
   - **Forbidden Lazy Shortcut:** <Minimum-diff patch or parametric mutation (coordinate shifts, 1D block permutations, N/S or E/W side-swaps, or identifier renames on a cloned skeleton) that is forbidden>
   - **Required Root-Level Solution:** <Complete structural implementation at the root layer>
   - **Files & Symbols to Modify:** <Exact modules and functions>

   ## Edge Cases to Guard
   - <Null/empty inputs, race conditions, error paths, boundary values>

   ## Adversarial Diff Audit
   - [ ] **Critic Verdict:** Pending Phase 4 audit.

   ## Iteration Log
   ```

## Phase 2: Test-First & Complete Root-Level Implementation
1. Set `.agents/argonaut-state.md` `Status` to `IMPLEMENTING` once (do NOT repeatedly re-edit `.agents/argonaut-state.md` between normal coding steps).
2. **Write Structural Tests First:** Assert real structural behavior or topological invariants—never write tautological constant-mirror tests.
3. **Execute Root-Level Code (Root Tear-Down First & Zero Spec-Laundering):**
   - **Root Anchor First:** On coupled multi-file rewrites, tear down and modify the `Root Anchor / Schema Files` (`plan.ts`, `schema.ts`) *first* before editing downstream consumers (`pre_edit_guard.py` blocks downstream edits until the root anchor is modified).
   - **Zero Spec-Laundering & Zero Parametric Shortcuts:** Never rewrite `## Acceptance Criteria`, approved `*plan*.md` artifacts, or `docs/**` specs to match un-reworked code, and never pass off coordinate shifts, 1D permutations, or N/S/E/W side-swaps on a cloned skeleton as structural work.

## Phase 3: Deterministic Verification Loop
1. Set `Status` to `VERIFYING` and run `verify.py`:
   ```bash
   if [ -f ".agents/skills/argonaut/scripts/verify.py" ]; then
     python3 .agents/skills/argonaut/scripts/verify.py
   elif [ -f "$HOME/.gemini/config/skills/argonaut/scripts/verify.py" ]; then
     python3 "$HOME/.gemini/config/skills/argonaut/scripts/verify.py"
   else
     python3 "$HOME/.gemini/config/plugins/argonaut/skills/argonaut/scripts/verify.py"
   fi
   ```
2. **If Exit Code != 0:** Increment `Iteration`, log a 2-line diagnosis in `## Iteration Log` (trigger **Law 4** if the same error occurred twice in a row; set `BLOCKED` at `10 / 10`), and loop back to **Phase 2**.

## Phase 4: Adversarial Principal-Engineer Diff Audit
Once `verify.py` exits `0`, set `Status` to `AUDITING` and spawn a **fresh** `research` subagent via `invoke_subagent` (never self-certify and never reuse a prior subagent via `send_message`; `stop_guard.py` verifies from the Critic's transcript that it read `.agents/argonaut-state.md` and every workspace `Reference Benchmark / Prior Art` path):
> *"You are a skeptical Principal Engineer auditing a candidate implementation. Read `.agents/argonaut-state.md` (`## User Intent & Constraints` is SUPREME LAW over `## Acceptance Criteria`). Read the ENTIRE contents of every modified file AND every file/directory in `Reference Benchmark / Prior Art`. Audit across 5 axes: (0) Product & Structural Fidelity (reject any parametric coordinate shift, 1D block permutation, N/S or E/W side-swap, cloned template skeleton, or spec/plan laundering), (1) Type & Error Integrity, (2) Scope Discipline, (3) Test Authenticity (reject tautological constant-mirror tests), and (4) Resource & Security Hygiene. Reply with `PASS` or `FAIL` and concrete findings."*

Record the verdict in `## Adversarial Diff Audit` (`- [x] **Critic Verdict:** ...`). If any defect is found, fix in **Phase 2** and re-run **Phase 3** + **Phase 4**.

## Phase 5: Final Sign-Off
When **Phase 3** (`exit 0` with a fresh stamp) and **Phase 4** (`PASS`) succeed, check off (`- [x]`) all verified items, set `Status` to `COMPLETED`, and concisely report: **Intent & Anti-Laziness Proof**, **Key Changes**, and **Verification Proof**.
