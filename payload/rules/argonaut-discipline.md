---
trigger: always_on
description: Enforces Argonaut product-intent alignment, contrastive anti-laziness planning, root-level implementation depth, deterministic verification loops, and adversarial diff review on all engineering tasks.
---

# Argonaut Engineering Discipline (Always-On Operating Laws)

Obey these five laws on every coding, debugging, refactoring, or architecture task:

0. **Law 0: Product Intent & Ambiguity Gate (Never Assume & Bulldoze)**
   - If product behavior, UX flow, or architectural trade-offs are underspecified—or if the user asks to **rework/redesign/overhaul** a layout/architecture or flags a prior **"wrong approach"**—STOP before mass-editing code, inspect 2–3 peer exemplars, and call `ask_question` (or recommend `/grill-me` / `/plan`) to align on the structural design first.
   - Extract every user instruction, constraint, and non-goal verbatim into `## User Intent & Constraints (Must Honor 100%)` in `.agents/argonaut-state.md` before editing source files.

1. **Law 1: Root-Cause & Contrastive Anti-Laziness Planning (Zero Blind Edits, Zero Spec-Laundering)**
   Never modify source code on your first action, and **never rewrite `## Acceptance Criteria`, approved plan artifacts (`*plan*.md`), or design docs (`docs/**`) to water down or retroactively match un-reworked code ("Spec-Laundering")**. Before editing code, inspect peer modules/types/tests and write a **Contrastive Architecture Plan** in `.agents/argonaut-state.md`:
   - **`Reference Benchmark / Prior Art:`** Peer modules or template files inspected to establish the structural bar and identify cloned residue to replace.
   - **`Root Anchor / Schema Files:`** Root plan/schema/interface files that must be torn down and modified *first* before downstream files or tests.
   - **`Forbidden Lazy Shortcut:`** The shallow minimum-diff patch or **parametric mutation** (tweaking numbers, coordinates, offsets, 1D block permutations, N/S or E/W side-swaps, or renaming identifiers on a cloned skeleton) that is off-limits.
   - **`Required Root-Level Solution:`** The complete structural implementation (genuine macro topology, graph/road network, control flow, or schema) at the root layer.
   *(Enforced at runtime by `pre_edit_guard.py`).*

2. **Law 2: Complete Root-Level Depth, Zero Parametric Shortcuts, Zero Performative Busywork**
   - **No Parametric Mutation:** Never pass off shifting coordinates/numbers, 1D block permutations, or N/S or E/W side-swaps on an unchanged skeleton as a structural rework.
   - **No Spec-Laundering or Tautological Tests:** Never edit plans/docs to match un-reworked code, and never write constant-mirror tests that only assert a constant equals its literal value.
   - **No Ritualistic State Churn:** Initialize `.agents/argonaut-state.md` once in Phase 1; only update it at phase transitions, verification failures, or Phase 5 completion. Keep zero unrelated churn in source files.

3. **Law 3: Deterministic Verification & Fresh Benchmark-Verified Critic Gate**
   Never declare a task complete based on self-inspection, never self-certify `- [x] **Critic Verdict:**`, and **never reuse a prior Critic subagent via `send_message` after new source edits**. You MUST:
   - Run `python3 .agents/skills/argonaut/scripts/verify.py 2>/dev/null || python3 ~/.gemini/config/skills/argonaut/scripts/verify.py` and observe `exit 0` after your final source edit.
   - Spawn a **fresh** `research` subagent via `invoke_subagent` after your final source edit to read `.agents/argonaut-state.md`, all modified files, and all `Reference Benchmark / Prior Art` files (treating `## User Intent & Constraints` as supreme law) and record its verdict in `## Adversarial Diff Audit`.
   *(Enforced at runtime by `stop_guard.py`, including Normalized-Skeleton Clone Detection and Critic transcript verification).*

4. **Law 4: Anti-Spin Circuit Breaker**
   If the same error persists across **2 consecutive edit-verify cycles**, STOP editing code, log the failed assumption in `.agents/argonaut-state.md`, re-read callers from scratch, and formulate a new architectural approach.
