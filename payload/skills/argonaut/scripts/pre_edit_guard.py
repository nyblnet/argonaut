#!/usr/bin/env python3
"""Argonaut Runtime PreToolUse Edit Guard for Google Antigravity (`hooks.json`)."""

import fnmatch
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from _common import (
    ACTIVE_STATUSES,
    AGENT_DOT_DIRS,
    emit,
    extract_conversation_id,
    hash_single_file,
    is_superseded_by_workspace_hook,
    load_json_file,
    matches_any_pattern,
    read_stdin_json,
    resolve_workspace_root,
)


def allow() -> int:
    return emit({"decision": "allow"})


def deny(reason: str) -> int:
    return emit({"decision": "deny", "reason": reason})


def record_state_owner(workspace_root: Path, conv_id: str) -> None:
    if not conv_id:
        return
    stamp_path = workspace_root / ".agents" / ".argonaut-verify.stamp.json"
    data = load_json_file(stamp_path) or {}
    if data.get("ownerConversationId") == conv_id:
        return
    data["ownerConversationId"] = conv_id
    try:
        stamp_path.parent.mkdir(parents=True, exist_ok=True)
        stamp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def extract_target_file(hook_input: Dict[str, Any]) -> str:
    tool_call = hook_input.get("toolCall")
    args = tool_call.get("args") if isinstance(tool_call, dict) else None
    if not isinstance(args, dict):
        return ""
    for key in ("TargetFile", "targetFile", "Path", "AbsolutePath", "path", "file_path"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _resolve_target_path(target_str: str, workspace_root: Path) -> Path:
    clean = target_str[len("file://") :] if target_str.startswith("file://") else target_str
    tp = Path(clean)
    return (workspace_root / tp).resolve() if not tp.is_absolute() else tp.resolve()


def is_argonaut_state_target(target_str: str, workspace_root: Path) -> bool:
    if not target_str:
        return False
    try:
        rel = _resolve_target_path(target_str, workspace_root).relative_to(workspace_root)
    except ValueError:
        return False
    return rel.parts == (".agents", "argonaut-state.md")


def is_locked_plan_artifact(target_str: str) -> Optional[Path]:
    if not target_str:
        return None
    clean = target_str[len("file://") :] if target_str.startswith("file://") else target_str
    tp = Path(clean)
    if "/brain/" in tp.as_posix() and fnmatch.fnmatch(tp.name.lower(), "*plan*.md") and tp.is_file():
        return tp
    return None


def resolve_relative_workspace_target(target_str: str, workspace_root: Path) -> Optional[str]:
    if not target_str:
        return None
    try:
        rel = _resolve_target_path(target_str, workspace_root).relative_to(workspace_root)
    except ValueError:
        return None
    if not rel.parts or rel.parts[0] in AGENT_DOT_DIRS:
        return None
    return rel.as_posix()


def parse_file_list_field(text: str, field_name: str) -> List[str]:
    m = re.search(rf"\*\*{re.escape(field_name)}:\*\*\s*(.+)", text)
    if not m:
        return []
    raw = m.group(1).strip()
    if raw.lower() in {"none", "n/a", "all", "*"}:
        return []
    return [item.strip().strip("`'\"") for item in re.split(r"[,;]+", raw) if item.strip()]


def inspect_state(state_path: Path) -> Tuple[str, bool, bool, bool, bool, List[str], List[str], List[str]]:
    text = state_path.read_text(encoding="utf-8", errors="replace")
    status_match = re.search(r"\*\*Status:\*\*\s*([A-Za-z_-]+)", text)
    status = status_match.group(1).upper() if status_match else "UNKNOWN"
    has_intent = bool(re.search(r"^##\s+User Intent\s*&\s*Constraints", text, re.MULTILINE)) and bool(
        re.search(r"^\s*-\s*\[[ xX]\]\s+\S+", text, re.MULTILINE)
    )
    has_root_cause = bool(re.search(r"^##\s+Root-Cause\s*&\s*Architecture Plan", text, re.MULTILINE))
    has_contrastive = bool(re.search(r"Forbidden\s+Lazy\s+Shortcut", text, re.IGNORECASE)) and bool(
        re.search(r"Required\s+Root-Level\s+Solution", text, re.IGNORECASE)
    )
    has_benchmark = bool(re.search(r"Reference\s+Benchmark\s*/\s*Prior\s+Art", text, re.IGNORECASE))
    allowed = parse_file_list_field(text, "Allowed Files")
    forbidden = parse_file_list_field(text, "Forbidden Files")
    anchors = parse_file_list_field(text, "Root Anchor / Schema Files") or parse_file_list_field(
        text, "Root Anchor Files"
    )
    return status, has_intent, has_root_cause, has_contrastive, has_benchmark, allowed, forbidden, anchors


def is_file_modified_since_baseline(
    rel_posix: str, workspace_root: Path, intent_lock: Optional[Dict[str, Any]]
) -> bool:
    fpath = workspace_root / rel_posix
    if intent_lock and isinstance(intent_lock.get("baselineFiles"), dict):
        baseline = intent_lock["baselineFiles"]
        cur_hash = hash_single_file(fpath) if fpath.exists() else "__deleted__"
        if rel_posix in baseline:
            return cur_hash != baseline.get(rel_posix)
        if "__git_head__" in baseline and (workspace_root / ".git").exists() and shutil.which("git") is not None:
            try:
                old_head = str(baseline["__git_head__"])
                for cmd in (
                    ["git", "status", "--porcelain=v1", "--", rel_posix],
                    ["git", "diff", "--name-only", old_head, "--", rel_posix],
                ):
                    p = subprocess.run(
                        cmd, cwd=workspace_root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5
                    )
                    if p.returncode == 0 and p.stdout.strip():
                        return True
                return False
            except Exception:
                return True
        return cur_hash != baseline.get(rel_posix)

    if (workspace_root / ".git").exists() and shutil.which("git") is not None:
        try:
            p = subprocess.run(
                ["git", "status", "--porcelain=v1", "--", rel_posix],
                cwd=workspace_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=5,
            )
            if p.returncode == 0:
                return bool(p.stdout.strip())
        except Exception:
            pass
    return True


def find_unmodified_root_anchor(
    rel_target: str, workspace_root: Path, state_anchors: List[str], intent_lock: Optional[Dict[str, Any]]
) -> Optional[str]:
    valid_anchors = [
        a.lstrip("./")
        for a in state_anchors
        if a and a.lower() not in {"none", "n/a", "*"} and (workspace_root / a.lstrip("./")).is_file()
    ]
    if valid_anchors:
        if matches_any_pattern(rel_target, valid_anchors):
            return None
        target_parent = Path(rel_target).parent
        scoped = [a for a in valid_anchors if Path(a).parent == target_parent]
        if not scoped:
            scoped = [
                a
                for a in valid_anchors
                if len(Path(a).parts) >= 2 and Path(a).parts[:2] == Path(rel_target).parts[:2]
            ]
        scoped = scoped or valid_anchors
        if any(is_file_modified_since_baseline(a, workspace_root, intent_lock) for a in scoped):
            return None
        return scoped[0]

    if intent_lock and intent_lock.get("isArchitecturalRedesign"):
        target_parent = Path(rel_target).parent
        target_name = Path(rel_target).name
        auto_names = ("plan.ts", "plan.js", "schema.ts", "schema.py")
        if str(target_parent) != "." and target_name not in auto_names:
            for cand_name in auto_names:
                cand_rel = (target_parent / cand_name).as_posix()
                if (workspace_root / cand_rel).is_file() and not is_file_modified_since_baseline(
                    cand_rel, workspace_root, intent_lock
                ):
                    return cand_rel
    return None


def main() -> int:
    hook_input = read_stdin_json()
    if hook_input is None:
        return allow()

    workspace_root = resolve_workspace_root(hook_input)
    if is_superseded_by_workspace_hook(workspace_root, __file__):
        return allow()

    target_str = extract_target_file(hook_input)
    conv_id = extract_conversation_id(hook_input)
    if is_argonaut_state_target(target_str, workspace_root):
        record_state_owner(workspace_root, conv_id)
        return allow()

    rel_target = resolve_relative_workspace_target(target_str, workspace_root)
    intent_lock = load_json_file(workspace_root / ".agents" / ".argonaut-intent.lock.json")
    state_path = workspace_root / ".agents" / "argonaut-state.md"

    if rel_target is None:
        plan_artifact = is_locked_plan_artifact(target_str)
        if plan_artifact is not None and state_path.exists():
            is_ro = bool(
                intent_lock
                and (intent_lock.get("allowSourceEdits") is False or intent_lock.get("intentMode") == "READ_ONLY")
            )
            if not is_ro and inspect_state(state_path)[0] in {"IMPLEMENTING", "VERIFYING", "AUDITING"}:
                return deny(
                    f"Argonaut Anti-Spec-Laundering Violation (Law 1 & Law 2): Plan artifact `{plan_artifact.name}` "
                    "is locked during active implementation. You are strictly forbidden from retroactively editing "
                    "or watering down an approved plan artifact to match your code. Modify the implementation code "
                    "to satisfy the approved plan instead."
                )
        return allow()

    if intent_lock:
        if intent_lock.get("allowSourceEdits") is False or intent_lock.get("intentMode") == "READ_ONLY":
            return deny(
                f"Argonaut Off-Script Safeguard: User intent was automatically recognized as READ_ONLY "
                f"(question, explanation, or `/plan` before approval). Attempted edit to `{rel_target}` "
                "is blocked. Answer the user's question or wait for plan approval before modifying code."
            )
        auto_forbidden = intent_lock.get("forbiddenFiles", [])
        if isinstance(auto_forbidden, list) and auto_forbidden and matches_any_pattern(rel_target, auto_forbidden):
            return deny(
                f"Argonaut Off-Script Safeguard: Target file `{rel_target}` is FORBIDDEN by the user's "
                f"prompt constraints ({', '.join(auto_forbidden)}). Do NOT touch or modify this file."
            )
        auto_allowed = intent_lock.get("strictAllowedFiles", [])
        if isinstance(auto_allowed, list) and auto_allowed and not matches_any_pattern(rel_target, auto_allowed):
            return deny(
                f"Argonaut Off-Script Safeguard: Target file `{rel_target}` is outside the user's strict "
                f"allowed file scope ({', '.join(auto_allowed)})."
            )
        locked_specs = intent_lock.get("lockedSpecFiles", [])
        if isinstance(locked_specs, list) and locked_specs and matches_any_pattern(rel_target, locked_specs):
            return deny(
                f"Argonaut Anti-Spec-Laundering Safeguard (Law 1 & Law 2): Specification/design-doc file "
                f"`{rel_target}` is automatically frozen as read-only Ground Truth during implementation. "
                "You are forbidden from rewriting specification or design documents to match your code; "
                "modify the implementation code to satisfy the specification instead."
            )

    if not state_path.exists():
        return deny(
            "Argonaut Law 0 & Law 1 Violation: You attempted to modify a workspace file before "
            "initializing `.agents/argonaut-state.md`. First check for product ambiguity (call "
            "`ask_question` if any requirement is underspecified), then create `.agents/argonaut-state.md` "
            "with `## User Intent & Constraints (Must Honor 100%)`, `## Acceptance Criteria`, and "
            "`## Root-Cause & Architecture Plan` (including `Forbidden Lazy Shortcut` and `Required Root-Level Solution`) "
            "before editing source files."
        )

    (
        status,
        has_intent,
        has_root_cause,
        has_contrastive,
        has_benchmark,
        state_allowed,
        state_forbidden,
        state_root_anchors,
    ) = inspect_state(state_path)

    if status not in ACTIVE_STATUSES:
        return deny(
            f"Argonaut Law 0 & Law 1 Violation: `.agents/argonaut-state.md` is still marked {status} "
            "from a previous task. Before editing workspace files for this new request, update "
            "`.agents/argonaut-state.md` (`Status: PLANNING` or `IMPLEMENTING`) with the current task's "
            "`## User Intent & Constraints (Must Honor 100%)` and `## Root-Cause & Architecture Plan`."
        )
    if not has_intent or not has_root_cause:
        return deny(
            "Argonaut Law 0 & Law 1 Violation: `.agents/argonaut-state.md` must include both "
            "`## User Intent & Constraints (Must Honor 100%)` (with `- [ ]` checklist items for "
            "verbatim user instructions) and `## Root-Cause & Architecture Plan` before editing source files."
        )
    if not has_contrastive:
        return deny(
            "Argonaut Law 1 & Law 2 Anti-Laziness Violation: `.agents/argonaut-state.md` must include "
            "Contrastive Anti-Shortcut Planning under `## Root-Cause & Architecture Plan`, explicitly "
            "stating `- **Reference Benchmark / Prior Art:** ...`, `- **Forbidden Lazy Shortcut:** ...` "
            "(including any parametric/coordinate-tweaking shortcut), and "
            "`- **Required Root-Level Solution:** ...` before editing source files."
        )
    if not has_benchmark:
        return deny(
            "Argonaut Law 1 & Law 2 Anti-Laziness Violation: `.agents/argonaut-state.md` must include "
            "`- **Reference Benchmark / Prior Art:** ...` under `## Root-Cause & Architecture Plan`, "
            "citing the existing peer modules or baseline files inspected before editing source files."
        )
    if state_forbidden and matches_any_pattern(rel_target, state_forbidden):
        return deny(
            f"Argonaut Off-Script Safeguard: Target file `{rel_target}` matches `Forbidden Files` "
            f"in `.agents/argonaut-state.md` ({', '.join(state_forbidden)})."
        )
    if state_allowed and not matches_any_pattern(rel_target, state_allowed):
        return deny(
            f"Argonaut Off-Script Safeguard: Target file `{rel_target}` is outside `Allowed Files` "
            f"declared in `.agents/argonaut-state.md` ({', '.join(state_allowed)})."
        )

    unmodified_anchor = find_unmodified_root_anchor(rel_target, workspace_root, state_root_anchors, intent_lock)
    if unmodified_anchor:
        return deny(
            f"Argonaut Root-Anchor-First Violation (Law 1 & Law 2): You attempted to edit downstream file "
            f"`{rel_target}` before modifying the root anchor/schema file `{unmodified_anchor}`. "
            "On coupled architectural changes, you are forbidden from cosmetically patching downstream files "
            f"or tests while preserving the old skeleton in `{unmodified_anchor}`. Tear down and modify "
            f"`{unmodified_anchor}` first."
        )

    return allow()


if __name__ == "__main__":
    sys.exit(main())
