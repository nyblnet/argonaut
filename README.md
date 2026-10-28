# Argonaut Autonomous Engineering System

**Argonaut** (`argonaut-ai`) is an open-source plugin, skill, and runtime hook package that upgrades Gemini in **Google Antigravity** into a continuous, self-correcting, Staff-Engineer-grade autonomous loop.

---

## What Argonaut Does

Instead of making blind edits, guessing product requirements, or going off-script mid-task, Argonaut couples **Always-On Operating Laws (Laws 0–4)**, a **6-Stage State Machine (Phases 0–5)**, a **Token-Bounded Verification Harness**, and **3 Native Antigravity Runtime Hooks (`PreInvocation`, `PreToolUse`, and `Stop`)**:

0. **Automatic Pre-Model Intent Recognition, Ground-Truth Spec Freeze & Context-Aware Prompt Pinning (`PreInvocation` $\rightarrow$ `intent_anchor.py`):**
   Before Gemini generates a single token, `intent_anchor.py` reads your latest prompt directly from Antigravity's `transcript.jsonl`, classifies your intent (`READ_ONLY` vs. `CODING`), detects architectural rework / "wrong approach" prompts to inject an `ARCHITECTURAL REDESIGN SAFEGUARD`, extracts `MUST` and `MUST NOT` directives, auto-locks `forbiddenFiles` (e.g., *"do not touch X"*), `strictAllowedFiles` (e.g., *"only edit Y"*), and **`lockedSpecFiles`** (automatically freezing existing workspace specification and design-doc files `docs/**/*.md`, `SPEC*.md`, `DESIGN*.md`, `ARCHITECTURE*.md` as read-only Ground Truth unless your prompt explicitly asks to edit documentation), snapshots baseline workspace file hashes into `.agents/.argonaut-intent.lock.json`, and pins a context-aware `ephemeralMessage` at the bottom of the context window on every step.
1. **Phase 0 & 1 — Ambiguity Gate, Contrastive Planning, Root-Anchor-First Edit Ordering & Anti-Spec-Laundering (`Law 0 & Law 1` + `pre_edit_guard.py`):**
   If product behavior or an architectural redesign is underspecified, Argonaut pauses, inspects peer exemplars, and calls `ask_question` before touching code. Before any source file edit is permitted, `.agents/argonaut-state.md` must articulate the **`Reference Benchmark / Prior Art`**, the **`Forbidden Lazy Shortcut`** (including any parametric/coordinate-tweaking shortcut inside a cloned skeleton), and the **`Required Root-Level Solution`**. Antigravity's `PreToolUse` hook (`pre_edit_guard.py`) **physically blocks** (`decision: "deny"`) any attempt to edit workspace source files if the turn is `READ_ONLY`, if the target file is in `forbiddenFiles` or `lockedSpecFiles`, if the target file is outside `strictAllowedFiles`, if `.agents/argonaut-state.md` is missing the user constraints checklist or contrastive plan fields, if the agent attempts to edit a downstream sibling file (`dress.ts`, `blocks.ts`, tests) **before modifying the declared or auto-detected `Root Anchor / Schema Files` (`plan.ts`, `schema.ts`) first**, or if the agent attempts mid-implementation **Spec-Laundering** on an approved `/brain/.../*plan*.md` artifact.
2. **Phase 2 — Test-First & Complete Root-Level Implementation (`Law 2`):**
   Writes non-tautological tests first, then builds the complete root-level architectural or structural solution required to genuinely fulfill user intent (tearing down root schema/plan files first on coupled multi-file rewrites)—never taking lazy minimum-diff or parametric-mutation shortcuts, never laundering plans/docs, and never causing unrelated formatting or state-file churn.
3. **Phase 3 — Deterministic Verification Harness (`Law 3` + `verify.py`):**
   Auto-detects project toolchains (Node/TypeScript via `pnpm`/`yarn`/`bun`/`npm`, Python via `ruff`/`pyright`/`mypy`/`pytest`, Go via `go vet`/`go test`, Rust via `cargo check`/`cargo test`, or custom `.agents/verify.json` gates), strips ANSI noise, truncates output to 120 lines for token efficiency, and writes a cryptographic workspace verification stamp (`.agents/.argonaut-verify.stamp.json`) on `exit 0`.
4. **Anti-Spin Circuit Breaker (`Law 4`):**
   If the same error occurs across 2 consecutive edit-verify cycles, Argonaut halts blind edits, logs the failed assumption, re-reads upstream/downstream callers, and formulates a new architectural plan.
5. **Phase 4 — Mandatory Fresh Benchmark-Verified Critic Subagent Audit:**
   Spawns a fresh, clean-context `research` subagent (`invoke_subagent`) after the final source edit using a **Non-Leading Whole-File Audit Prompt** that enforces `## User Intent & Constraints` as supreme law over self-authored `## Acceptance Criteria`, auditing `git diff`, `.agents/argonaut-state.md`, the entire contents of modified files, and every workspace `Reference Benchmark / Prior Art` file across 5 axes (**Axis 0: Product & Macro-Topological Fidelity vs. Parametric/Side-Swap/Clone/Spec-Laundering Shortcuts**, *Type & Error Integrity*, *Scope Discipline*, *Edge-Case & Test Authenticity*, and *Resource & Security Hygiene*).
6. **Phase 5 & Runtime `Stop` Hook Enforcement (`hooks.json` + `stop_guard.py`):**
   Antigravity's native `Stop` lifecycle hook intercepts turn completion whenever `.agents/argonaut-state.md` is active—blocking premature stops if the loop is incomplete, if **any forbidden, out-of-scope, or frozen ground-truth spec file (`lockedSpecFiles`) was modified** relative to the baseline snapshot in `.agents/.argonaut-intent.lock.json`, if **any `- [ ]` user constraint checkbox remains unchecked**, if **Deterministic Normalized-Skeleton Clone Analysis detects that a reworked file still retains $\ge 78\%$ structural skeleton similarity to its `Reference Benchmark / Prior Art` template**, if **`## Adversarial Diff Audit` (`- [x] **Critic Verdict:**`) is missing, self-certified, reused via `send_message`, or if the Critic subagent's own transcript shows it failed to read `.agents/argonaut-state.md` and the declared workspace `Reference Benchmark / Prior Art` files**, or if any source file was modified after `verify.py` last passed.

---

## One-Command Installation

### Option 1: via `npx` (Node.js)

```bash
# Install into the current workspace (.agents/)
npx argonaut-ai init

# Install globally for all Antigravity workspaces (~/.gemini/)
npx argonaut-ai init --global

# Run the verification harness / health check
npx argonaut-ai doctor

# Uninstall (workspace or global)
npx argonaut-ai uninstall
npx argonaut-ai uninstall --global
```

### Option 2: Universal Shell Installer (Python / Rust / Go / C++)

```bash
# Install into the current workspace (.agents/)
curl -fsSL https://raw.githubusercontent.com/nyblnet/argonaut/main/install.sh | bash

# Install globally (~/.gemini/)
curl -fsSL https://raw.githubusercontent.com/nyblnet/argonaut/main/install.sh | bash -s -- --global

# Or from a local clone:
./install.sh
./install.sh --global
./install.sh --uninstall
```

### Option 3: Antigravity Prompt-Install

Paste this single sentence directly into your Google Antigravity chat:

> `Run npx argonaut-ai init in my terminal to install the Argonaut autonomous engineering loop in this workspace.`

---

## Usage in Google Antigravity

Once installed, Argonaut's 5 Operating Laws (`argonaut-discipline.md`) and runtime `PreInvocation` + `PreToolUse` + `Stop` hooks (`hooks.json`) are active automatically. To invoke the full autonomous loop explicitly on a task:

```text
/argonaut Fix the race condition in the token refresh middleware and add regression tests.
```

---

## Customizing Verification Gates (`.agents/verify.json`)

By default, `verify.py` auto-detects Node/TypeScript, Python, Go, and Rust toolchains when `"commands"` in `.agents/verify.json` is empty (`[]`).

For monorepos or custom build pipelines, populate `.agents/verify.json` with explicit sequential gates:

```json
{
  "commands": [
    {
      "name": "Typecheck (Backend & Web)",
      "cmd": "pnpm -r run typecheck"
    },
    {
      "name": "Lint",
      "cmd": "pnpm -r run lint"
    },
    {
      "name": "Unit & Integration Tests",
      "cmd": "pnpm --filter api test && pytest services/worker/tests -q"
    }
  ]
}
```

---

## Repository Structure

```text
.
├── package.json
├── bin/
│   └── argonaut.mjs
├── install.sh
├── payload/
│   ├── plugin.json
│   ├── hooks.json
│   ├── rules/
│   │   └── argonaut-discipline.md
│   └── skills/
│       └── argonaut/
│           ├── SKILL.md
│           └── scripts/
│               ├── _common.py
│               ├── intent_anchor.py
│               ├── pre_edit_guard.py
│               ├── stop_guard.py
│               └── verify.py
├── test/
│   └── argonaut.test.mjs
└── README.md
```
