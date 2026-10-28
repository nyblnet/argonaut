#!/usr/bin/env python3
"""
Argonaut Automatic Intent Recognition & Off-Script Safeguard Engine (`PreInvocation` hook).
Reads the user's latest prompt from Antigravity's `transcript.jsonl` BEFORE the model runs,
classifies intent (`READ_ONLY` vs `CODING`), locks `forbiddenFiles`, `strictAllowedFiles`,
and `lockedSpecFiles`, snapshots baseline workspace file hashes into
`.agents/.argonaut-intent.lock.json`, and pins a context-aware `ephemeralMessage` on each step.
"""

import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from _common import (
    emit,
    is_ignored_rel_path,
    is_superseded_by_workspace_hook,
    load_json_file,
    resolve_transcript_file,
    resolve_workspace_root,
    snapshot_workspace_files,
)

CODING_VERBS = {
    "implement", "build", "create", "fix", "update", "modify", "add", "remove", "delete",
    "refactor", "write", "change", "upgrade", "install", "wire", "replace", "support",
    "enforce", "patch", "edit", "configure", "put", "make",
}

AFFIRMATION_PATTERNS = {
    "yes", "yep", "yeah", "sure", "ok", "okay", "proceed", "go ahead", "do it",
    "implement it", "looks good", "lgtm", "approved",
}


def is_affirmation_text(text: str) -> bool:
    normalized = re.sub(r"[^a-z\s]", " ", text.lower())
    words = normalized.split()
    if not words or len(words) > 8:
        return False
    joined = " ".join(words)
    if joined in AFFIRMATION_PATTERNS:
        return True
    return bool(
        re.search(
            r"\b(yes|yep|yeah|sure|ok|okay|proceed|go ahead|do it|do this|lets do|let s do|sounds good|looks good|approved|lgtm)\b",
            joined,
        )
    )


def clean_user_content(raw: str) -> Tuple[str, bool]:
    """Extracts text inside <USER_REQUEST> tags and detects plan approval metadata."""
    is_approval = "The user has approved this document" in raw
    m = re.search(r"<USER_REQUEST>([\s\S]*?)</USER_REQUEST>", raw)
    body = m.group(1).strip() if m else raw.strip()
    return body, is_approval


def extract_user_prompts(transcript_path: Path) -> Tuple[int, str, bool]:
    """Returns (latest_step_idx, effective_prompt, is_approval)."""
    user_entries: List[Tuple[int, str, bool]] = []
    try:
        lines = transcript_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 0, "", False

    for idx, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") == "USER_INPUT":
            content = obj.get("content", "")
            if isinstance(content, str):
                cleaned, approved = clean_user_content(content)
                step_idx = int(obj.get("step_index", idx))
                user_entries.append((step_idx, cleaned, approved))

    if not user_entries:
        return 0, "", False

    latest_step, latest_text, latest_approved = user_entries[-1]
    starts_with_affirmation = bool(
        re.match(r"^\s*(?:yes|yep|yeah|sure|ok|okay|proceed|go ahead)\b", latest_text, re.IGNORECASE)
    )

    if latest_approved or is_affirmation_text(latest_text) or starts_with_affirmation:
        for prev_step, prev_text, _ in reversed(user_entries[:-1]):
            if prev_text and not is_affirmation_text(prev_text):
                combined = prev_text if not latest_text else f"{prev_text}\n\n[User Follow-up Confirmation]: {latest_text}"
                return latest_step, combined, True
        return latest_step, latest_text or "Approved previous plan.", True

    return latest_step, latest_text, False


def list_workspace_files(root: Path, baseline_files: Dict[str, str]) -> Set[str]:
    """Returns the set of workspace file paths for prompt filename matching."""
    if "__git_head__" in baseline_files and shutil.which("git") is not None:
        try:
            ls_proc = subprocess.run(
                ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=10,
            )
            if ls_proc.returncode == 0:
                return {p for p in ls_proc.stdout.split("\0") if p and not is_ignored_rel_path(p)}
        except Exception:
            pass
    return {k for k in baseline_files.keys() if k != "__git_head__"}


def is_architectural_redesign_prompt(prompt: str) -> bool:
    lower = prompt.lower()
    redesign_patterns = (
        r"\b(completely\s+rework|rework\s+the|redesign|rethink|overhaul|re-layout|relayout|from\s+scratch|completely\s+unique|genuinely\s+different)\b",
        r"\b(wrong\s+approach|not\s+unique|still\s+a\s+clone|too\s+similar|very\s+similar|not\s+that\s+much\s+different|just\s+shifted|only\s+shifted)\b",
        r"\b(underlying\s+(?:road|layout|network|architecture|structure|topology|schema|design))\b",
    )
    return any(re.search(pat, lower) for pat in redesign_patterns)


def classify_intent_mode(prompt: str, is_approval: bool) -> str:
    if is_approval:
        return "CODING"

    stripped = prompt.strip()
    if not stripped:
        return "CODING"

    lower = stripped.lower()
    if lower.startswith("/plan ") or lower == "/plan" or lower.startswith("/grill-me"):
        return "READ_ONLY"

    read_only_phrases = (
        "do not edit any file", "don't edit any file", "do not modify any file", "don't modify any file",
        "do not change anything", "don't change anything", "do not touch any file", "just explain", "only explain",
    )
    if any(p in lower for p in read_only_phrases):
        return "READ_ONLY"

    words = set(re.findall(r"\b[a-z]+\b", lower))
    has_coding_verb = bool(words & CODING_VERBS)

    question_starts = (
        "how ", "what ", "why ", "where ", "when ", "who ", "is ", "are ", "does ", "do ",
        "can you explain", "can you check", "could you check", "can you confirm", "can you show",
    )
    if (lower.startswith(question_starts) or lower.endswith("?")) and not has_coding_verb:
        return "READ_ONLY"

    return "CODING"


def match_files_in_clause(clause: str, workspace_files: Set[str]) -> List[str]:
    """Finds file paths referenced in a clause and resolves them to workspace-relative paths."""
    matched: Set[str] = set()
    tokens = re.findall(r"[`\"']?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)[`\"']?", clause)
    for tok in tokens:
        clean_tok = tok.strip("./")
        if not clean_tok:
            continue
        if clean_tok in workspace_files:
            matched.add(clean_tok)
        else:
            basename_matches = [wf for wf in workspace_files if wf == clean_tok or wf.endswith(f"/{clean_tok}")]
            if basename_matches:
                matched.update(basename_matches)
            elif "/" in clean_tok or clean_tok.endswith(
                (".js", ".mjs", ".ts", ".tsx", ".py", ".sh", ".md", ".json", ".go", ".rs")
            ):
                matched.add(clean_tok)
    return sorted(matched)


def extract_directives_and_files(
    prompt: str, workspace_files: Set[str]
) -> Tuple[List[str], List[str], List[str], List[str]]:
    """Returns (must_directives, must_not_directives, forbidden_files, strict_allowed_files)."""
    must_directives: List[str] = []
    must_not_directives: List[str] = []
    forbidden_files: Set[str] = set()
    strict_allowed_files: Set[str] = set()

    raw_chunks = re.split(r"(?:[\r\n]+|(?<=[.!?])\s+)", prompt)
    neg_pattern = re.compile(
        r"\b(do\s+not|don't|never|must\s+not|should\s+not|without|avoid|leave\s+.+\s+alone|keep\s+.+\s+untouched|keep\s+.+\s+unchanged)\b",
        re.IGNORECASE,
    )
    forbid_file_pattern = re.compile(
        r"\b(do\s+not\s+(?:touch|modify|edit|change|update|delete|remove|alter)|don't\s+(?:touch|modify|edit|change|update|delete|remove|alter)|never\s+(?:touch|modify|edit|change)|without\s+(?:touching|modifying|editing|changing)|leave\s+.+\s+(?:alone|untouched|unchanged)|keep\s+.+\s+(?:untouched|unchanged))\b",
        re.IGNORECASE,
    )
    strict_only_pattern = re.compile(
        r"\b(?:only\s+(?:edit|modify|touch|change|update)|(?:edit|modify|touch|change|update)\s+only)\b",
        re.IGNORECASE,
    )

    for chunk in raw_chunks:
        s = chunk.strip()
        if not s or len(s) < 4:
            continue
        if neg_pattern.search(s):
            if s not in must_not_directives:
                must_not_directives.append(s[:240])
            if forbid_file_pattern.search(s):
                forbidden_files.update(match_files_in_clause(s, workspace_files))
        else:
            words = set(re.findall(r"\b[a-z]+\b", s.lower()))
            if words & CODING_VERBS or re.match(r"^[-*0-9.]+\s+", s):
                if s not in must_directives:
                    must_directives.append(s[:240])
            if strict_only_pattern.search(s):
                strict_allowed_files.update(match_files_in_clause(s, workspace_files))

    strict_allowed_files -= forbidden_files
    return (
        must_directives[:12],
        must_not_directives[:12],
        sorted(forbidden_files),
        sorted(strict_allowed_files),
    )


def is_doc_edit_requested(prompt: str) -> bool:
    """Returns True only if the user prompt explicitly requests writing, editing, or updating docs/specs."""
    lower = prompt.lower()
    doc_edit_patterns = (
        r"\b(?:update|edit|modify|write|create|fix|change|rewrite|revise|document|add\s+to)\s+(?:the\s+|all\s+)?(?:docs?|documentation|readme|spec|specification|design\s+doc|architecture\s+doc)\b",
        r"\b(?:update|edit|modify|write|create|fix|change|rewrite|revise)\s+[`\"']?(?:docs/|spec|design|architecture|readme)",
    )
    return any(re.search(pat, lower, re.IGNORECASE) for pat in doc_edit_patterns)


def detect_locked_spec_files(
    prompt: str,
    workspace_files: Set[str],
    strict_allowed_files: List[str],
) -> List[str]:
    """Automatically identifies existing workspace specification/design-doc files to freeze as read-only Ground Truth."""
    if is_doc_edit_requested(prompt):
        return []

    allowed_set = set(strict_allowed_files)
    locked: Set[str] = set()
    for wf in workspace_files:
        if wf in allowed_set:
            continue
        lower_wf = wf.lower()
        basename = Path(wf).name.upper()
        is_docs_dir_md = (lower_wf.startswith("docs/") or "/docs/" in lower_wf) and lower_wf.endswith(
            (".md", ".mdx", ".txt")
        )
        is_root_spec_md = any(
            basename.startswith(prefix) and basename.endswith(".MD")
            for prefix in ("SPEC", "DESIGN", "ARCHITECTURE")
        )
        if is_docs_dir_md or is_root_spec_md:
            locked.add(wf)
    return sorted(locked)


def is_state_currently_active(workspace_root: Optional[Path]) -> bool:
    if workspace_root is None:
        return False
    state_path = workspace_root / ".agents" / "argonaut-state.md"
    if not state_path.exists():
        return False
    try:
        text = state_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    m = re.search(r"\*\*Status:\*\*\s*([A-Za-z_-]+)", text)
    status = m.group(1).upper() if m else "UNKNOWN"
    return status in {"PLANNING", "IMPLEMENTING", "VERIFYING", "AUDITING"}


def build_ephemeral_anchor(lock_data: Dict[str, Any], workspace_root: Optional[Path] = None) -> str:
    mode = lock_data.get("intentMode", "CODING")
    active = is_state_currently_active(workspace_root)
    prompt = lock_data.get("rawPrompt", "").strip()
    max_len = 320 if active else 1000
    if len(prompt) > max_len:
        half = max_len // 2
        prompt = prompt[:half] + " ... " + prompt[-half:]

    lines = [
        f"[ARGONAUT AUTO-INTENT SAFEGUARD — MODE: {mode}]",
        f'Verbatim User Prompt: "{prompt}"',
    ]

    must_not = lock_data.get("mustNotDirectives", [])
    if must_not and not active:
        lines.append("Negative Constraints (MUST NOT VIOLATE):")
        for item in must_not:
            lines.append(f"  - {item}")

    forbidden = lock_data.get("forbiddenFiles", [])
    if forbidden:
        lines.append(f"Runtime-Blocked Forbidden Files: {', '.join(forbidden)}")

    strict_allowed = lock_data.get("strictAllowedFiles", [])
    if strict_allowed:
        lines.append(f"Runtime-Locked Allowed File Scope: {', '.join(strict_allowed)}")

    locked_specs = lock_data.get("lockedSpecFiles", [])
    if locked_specs:
        preview = ", ".join(locked_specs[:6])
        suffix = f" (+{len(locked_specs) - 6} more)" if len(locked_specs) > 6 else ""
        lines.append(f"Runtime-Frozen Ground-Truth Spec Files (Read-Only): {preview}{suffix}")

    if mode == "READ_ONLY":
        lines.append(
            "SAFEGUARD ACTIVE: User intent is READ_ONLY / QUESTION / PLAN. Do NOT modify workspace source files."
        )
    else:
        if lock_data.get("isArchitecturalRedesign"):
            lines.append(
                "ARCHITECTURAL REDESIGN SAFEGUARD: Structural rework requested. Inspect peer exemplars "
                "(`Reference Benchmark / Prior Art`), tear down root schema/plan files first, and NEVER pass off "
                "parametric coordinate shifts or identifier renames on a cloned skeleton as a rework."
            )
        if active:
            lines.append(
                "SAFEGUARD ACTIVE: `.agents/argonaut-state.md` is already initialized and active — do NOT repeatedly touch or "
                "re-edit `.agents/argonaut-state.md` between coding steps (only update at phase transitions/completion), "
                "and NEVER rewrite plans/docs/specs to match un-reworked code."
            )
        else:
            lines.append(
                "SAFEGUARD ACTIVE: Stay strictly on-script. Record all user directives in `.agents/argonaut-state.md` once "
                "before your first code edit (do not repeatedly re-edit it between coding steps)."
            )

    return "\n".join(lines)


def main() -> int:
    raw_stdin = sys.stdin.read().strip()
    if not raw_stdin:
        return emit({})

    try:
        hook_input = json.loads(raw_stdin)
    except Exception:
        return emit({})

    root = resolve_workspace_root(hook_input)
    if is_superseded_by_workspace_hook(root, __file__):
        return emit({})

    agents_dir = root / ".agents"
    lock_path = agents_dir / ".argonaut-intent.lock.json"

    transcript_file = resolve_transcript_file(hook_input)
    if not transcript_file:
        if lock_path.exists():
            try:
                existing = json.loads(lock_path.read_text(encoding="utf-8"))
                return emit({"injectSteps": [{"ephemeralMessage": build_ephemeral_anchor(existing, root)}]})
            except Exception:
                pass
        return emit({})

    step_idx, prompt, is_approval = extract_user_prompts(transcript_file)
    if not prompt:
        return emit({})

    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
    prompt_id = f"{step_idx}:{prompt_hash}"

    existing_lock: Optional[Dict[str, Any]] = None
    if lock_path.exists():
        try:
            existing_lock = json.loads(lock_path.read_text(encoding="utf-8"))
        except Exception:
            existing_lock = None

    if existing_lock and existing_lock.get("promptId") == prompt_id:
        lock_data = existing_lock
    else:
        baseline_files = snapshot_workspace_files(root)
        workspace_file_set = list_workspace_files(root, baseline_files)
        mode = classify_intent_mode(prompt, is_approval)
        must_dir, must_not_dir, forbidden_files, strict_allowed_files = extract_directives_and_files(
            prompt, workspace_file_set
        )
        locked_spec_files = (
            detect_locked_spec_files(prompt, workspace_file_set, strict_allowed_files)
            if mode == "CODING"
            else []
        )
        lock_data = {
            "promptId": prompt_id,
            "stepIndex": step_idx,
            "timestamp": time.time(),
            "intentMode": mode,
            "allowSourceEdits": mode == "CODING",
            "isArchitecturalRedesign": is_architectural_redesign_prompt(prompt),
            "rawPrompt": prompt,
            "mustDirectives": must_dir,
            "mustNotDirectives": must_not_dir,
            "forbiddenFiles": forbidden_files,
            "strictAllowedFiles": strict_allowed_files,
            "lockedSpecFiles": locked_spec_files,
            "baselineFiles": baseline_files,
        }
        if agents_dir.exists():
            try:
                lock_path.write_text(json.dumps(lock_data, indent=2) + "\n", encoding="utf-8")
            except OSError:
                pass

    anchor_msg = build_ephemeral_anchor(lock_data, root)
    return emit({"injectSteps": [{"ephemeralMessage": anchor_msg}]})


if __name__ == "__main__":
    sys.exit(main())
