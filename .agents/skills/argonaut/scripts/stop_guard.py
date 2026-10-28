#!/usr/bin/env python3
"""Argonaut Runtime Stop Hook Guard for Google Antigravity (`hooks.json`)."""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from _common import (
    compute_tree_fingerprint,
    emit,
    extract_conversation_id,
    is_ignored_rel_path,
    is_superseded_by_workspace_hook,
    load_json_file,
    matches_any_pattern,
    read_stdin_json,
    resolve_transcript_file,
    resolve_workspace_root,
    snapshot_workspace_files,
)

MAX_ITERATIONS = 10
MAX_STOP_CONTINUATIONS = 10


def cont(stamp_path: Path, stamp: Optional[Dict[str, Any]], reason: str) -> int:
    increment_continuation_counter(stamp_path, stamp)
    return emit({"decision": "continue", "reason": reason})


def parse_state_file(state_path: Path) -> Tuple[str, int, List[str], bool]:
    text = state_path.read_text(encoding="utf-8", errors="replace")
    status_match = re.search(r"\*\*Status:\*\*\s*([A-Za-z_-]+)", text)
    iter_match = re.search(r"\*\*Iteration:\*\*\s*(\d+)", text)
    status = status_match.group(1).upper() if status_match else "UNKNOWN"
    iteration = int(iter_match.group(1)) if iter_match else 0

    stripped = re.sub(r"```[\s\S]*?```", "", text)
    unchecked = [
        m.group(1).strip()
        for line in stripped.splitlines()
        if (m := re.match(r"^\s*-\s*\[\s\]\s+(.+)$", line))
    ]
    has_audit = bool(re.search(r"^##\s+Adversarial\s+Diff\s+Audit", stripped, re.MULTILINE | re.IGNORECASE)) and bool(
        re.search(r"^\s*-\s*\[[xX]\]\s+\*\*Critic\s+Verdict:\*\*", stripped, re.MULTILINE | re.IGNORECASE)
    )
    return status, iteration, unchecked, has_audit


def inspect_transcript_subagent_state(
    transcript_path: Optional[Path],
) -> Tuple[bool, bool, bool, bool, bool, str, List[str]]:
    if not transcript_path or not transcript_path.exists():
        return False, False, False, False, False, "", []
    try:
        lines = transcript_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return False, False, False, False, False, "", []

    user_input_count = 0
    other_step_count = 0
    touched_state = False
    source_edits_in_turn = False
    subagent_invoked_after_last_edit = False
    latest_subagent_id = ""
    edited_targets_in_turn: List[str] = []
    spawned_subagents: Set[str] = set()
    completed_subagents: Set[str] = set()

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue

        step_type = str(obj.get("type", ""))
        content = str(obj.get("content", ""))

        if step_type == "USER_INPUT":
            user_input_count += 1
            spawned_subagents.clear()
            completed_subagents.clear()
            source_edits_in_turn = False
            subagent_invoked_after_last_edit = False
            latest_subagent_id = ""
            edited_targets_in_turn.clear()
        elif step_type in {"SYSTEM_MESSAGE", "PLANNER_RESPONSE", "GENERIC"}:
            other_step_count += 1

        for tc in obj.get("tool_calls", []) or []:
            if not isinstance(tc, dict):
                continue
            tc_name = str(tc.get("name", ""))
            tc_args = tc.get("arguments", tc.get("args", {}))
            tc_args_str = json.dumps(tc_args) if isinstance(tc_args, dict) else str(tc_args)
            if tc_name == "invoke_subagent":
                subagent_invoked_after_last_edit = True
            if tc_name in {"write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content"}:
                if "argonaut-state.md" in tc_args_str:
                    touched_state = True
                else:
                    target_val = ""
                    if isinstance(tc_args, dict):
                        for k in ("TargetFile", "targetFile", "Path", "AbsolutePath", "path", "file_path"):
                            v = tc_args.get(k)
                            if isinstance(v, str) and v.strip():
                                target_val = v.strip()
                                break
                    target_val = target_val or tc_args_str
                    if not any(
                        ex in target_val
                        for ex in ("/.agents/", "/.agent/", "/_agents/", "/_agent/", "/brain/", ".agents/", "argonaut-state.md")
                    ):
                        source_edits_in_turn = True
                        if target_val and target_val not in edited_targets_in_turn:
                            edited_targets_in_turn.append(target_val)
                        subagent_invoked_after_last_edit = False
                        latest_subagent_id = ""
            if tc_name == "manage_subagents" and isinstance(tc_args, dict):
                action = str(tc_args.get("Action", ""))
                if action == "kill_all":
                    completed_subagents.update(spawned_subagents)
                elif action == "kill":
                    for cid in tc_args.get("ConversationIds", []) or []:
                        completed_subagents.add(str(cid))

        if "Created the following subagent" in content:
            subagent_invoked_after_last_edit = True
            for cid in re.findall(r'"conversationId"\s*:\s*"([^"]+)"', content):
                spawned_subagents.add(cid)
                latest_subagent_id = cid
                completed_subagents.discard(cid)

        if step_type == "SYSTEM_MESSAGE":
            for sender_id in re.findall(r"\bsender=([A-Za-z0-9_-]+)", content):
                if sender_id != "system":
                    completed_subagents.add(sender_id)
            for err_id in re.findall(r'with id "([^"]+)" encountered an error', content):
                completed_subagents.add(err_id)
            if "All your subagents and background tasks have been stopped" in content:
                completed_subagents.update(spawned_subagents)

    return (
        (user_input_count == 0 and other_step_count > 0),
        (len(spawned_subagents - completed_subagents) > 0),
        touched_state,
        source_edits_in_turn,
        subagent_invoked_after_last_edit,
        latest_subagent_id,
        edited_targets_in_turn,
    )


def extract_workspace_benchmark_paths(state_path: Path, root: Path) -> List[str]:
    try:
        text = state_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    m = re.search(r"-\s*\*\*Reference\s+Benchmark\s*/\s*Prior\s+Art:\*\*\s*(.+)", text, re.IGNORECASE)
    if not m:
        return []
    raw_tokens = re.findall(r"[`\"']?([A-Za-z0-9_./-]+)[`\"']?", m.group(1).strip())
    valid_exts = {
        ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java",
        ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".json", ".yaml", ".yml", ".toml", ".sh", ".md",
    }
    found: List[str] = []
    for tok in raw_tokens:
        clean = tok.strip("`'\".,;:()[]{}<>").lstrip("./")
        if not clean or clean == "." or clean.startswith((".agents", "http:", "https:", "file:")):
            continue
        if "*" in clean or ".." in clean:
            continue
        if "/" not in clean and Path(clean).suffix.lower() not in valid_exts:
            continue
        if (root / clean).exists() and clean not in found:
            found.append(clean)
    return found


def verify_critic_subagent_inspection(latest_subagent_id: str, benchmark_paths: List[str]) -> Optional[str]:
    if not latest_subagent_id:
        return None
    brain_root = Path(os.environ.get("ARGONAUT_BRAIN_ROOT", str(Path.home() / ".gemini" / "antigravity" / "brain")))
    sub_logs_dir = brain_root / latest_subagent_id / ".system_generated" / "logs"
    sub_transcript = sub_logs_dir / "transcript_full.jsonl"
    if not sub_transcript.exists():
        sub_transcript = sub_logs_dir / "transcript.jsonl"
    if not sub_transcript.exists():
        return None

    try:
        lines = sub_transcript.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None

    chunks: List[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        step_type = str(obj.get("type", ""))
        if step_type == "PLANNER_RESPONSE":
            for tc in obj.get("tool_calls", []) or []:
                chunks.append(json.dumps(tc))
        elif step_type == "GENERIC":
            chunks.append(str(obj.get("content", "")))

    critic_activity = "\n".join(chunks)
    if "argonaut-state.md" not in critic_activity:
        return (
            f"Argonaut Phase 4 Critic Audit Violation: Critic subagent `{latest_subagent_id}` never read "
            "`.agents/argonaut-state.md` during its audit. Spawn a fresh `research` subagent via `invoke_subagent` "
            "and ensure it reads `.agents/argonaut-state.md` (`## User Intent & Constraints`) and all modified and "
            "`Reference Benchmark / Prior Art` files before completing."
        )

    missing_benchmarks = [bp for bp in benchmark_paths if bp not in critic_activity]
    if missing_benchmarks:
        return (
            f"Argonaut Phase 4 Critic Audit Violation: Critic subagent `{latest_subagent_id}` did not inspect "
            f"declared workspace `Reference Benchmark / Prior Art` path(s): [{', '.join(missing_benchmarks)}]. "
            "A rubber-stamp Critic audit that skips reading the reference benchmark files is forbidden. "
            "Spawn a fresh `research` subagent via `invoke_subagent` that reads every declared `Reference Benchmark / Prior Art` "
            "file alongside the modified files before marking the task COMPLETED."
        )
    return None


def find_changed_workspace_files(root: Path, intent_lock: Optional[Dict[str, Any]]) -> List[str]:
    if not intent_lock or not isinstance(intent_lock.get("baselineFiles"), dict):
        return []
    baseline = intent_lock["baselineFiles"]
    use_git = "__git_head__" in baseline
    current_files = snapshot_workspace_files(root, allow_git=use_git)
    changed_set = {
        rel_path
        for rel_path in (set(baseline.keys()) | set(current_files.keys())) - {"__git_head__"}
        if baseline.get(rel_path) != current_files.get(rel_path)
    }
    if use_git:
        old_head, new_head = baseline.get("__git_head__"), current_files.get("__git_head__")
        if old_head and new_head and old_head != new_head and shutil.which("git") is not None:
            try:
                p = subprocess.run(
                    ["git", "diff", "--name-only", "-z", str(old_head), str(new_head)],
                    cwd=root,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=5,
                )
                if p.returncode == 0:
                    changed_set.update(f for f in p.stdout.split("\0") if f and not is_ignored_rel_path(f))
            except Exception:
                pass
    return sorted(changed_set)


def find_off_script_file_violations(
    root: Path, intent_lock: Optional[Dict[str, Any]]
) -> Tuple[List[str], List[str], List[str]]:
    if not intent_lock:
        return [], [], []
    forbidden_pat = intent_lock.get("forbiddenFiles", [])
    allowed_pat = intent_lock.get("strictAllowedFiles", [])
    spec_pat = intent_lock.get("lockedSpecFiles", [])
    if not forbidden_pat and not allowed_pat and not spec_pat:
        return [], [], []

    forbidden_mod, out_of_scope_mod, locked_spec_mod = [], [], []
    for chg in find_changed_workspace_files(root, intent_lock):
        if forbidden_pat and matches_any_pattern(chg, forbidden_pat):
            forbidden_mod.append(chg)
        elif spec_pat and matches_any_pattern(chg, spec_pat):
            locked_spec_mod.append(chg)
        elif allowed_pat and not matches_any_pattern(chg, allowed_pat):
            out_of_scope_mod.append(chg)
    return forbidden_mod, out_of_scope_mod, locked_spec_mod


def normalize_structural_lines(text: str) -> List[str]:
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    lines: List[str] = []
    for raw in text.splitlines():
        line = re.sub(r"#.*$", "", re.sub(r"//.*$", "", raw)).strip()
        if not line or line.startswith(("import ", "from ")):
            continue
        line = re.sub(r"\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`", "$STR", line)
        line = re.sub(r"-?\b\d+(?:\.\d+)?\b", "$NUM", line)
        line = re.sub(
            r"\b(export\s+(?:const|let|var|function|class|type|interface)|const|let|var|function|def|class)\s+[A-Za-z_$][A-Za-z0-9_$]*",
            r"\1 $DECL",
            line,
        )
        lines.append(re.sub(r"\s+", " ", line))
    return lines


def find_skeleton_clone_violations(
    root: Path,
    state_path: Path,
    intent_lock: Optional[Dict[str, Any]],
    benchmark_paths: List[str],
    edited_targets_in_turn: List[str],
) -> List[str]:
    if not benchmark_paths:
        return []
    is_redesign = bool(intent_lock and intent_lock.get("isArchitecturalRedesign"))
    if not is_redesign:
        try:
            state_text = state_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            state_text = ""
        is_redesign = bool(
            re.search(
                r"\b(completely\s+rework|rework\s+the|redesign|re-layout|relayout|overhaul|not\s+a\s+clone|replace\s+template)\b",
                state_text,
                re.IGNORECASE,
            )
        )
    if not is_redesign:
        return []

    candidate_mod_rels: Set[str] = set(find_changed_workspace_files(root, intent_lock))
    for raw_t in edited_targets_in_turn:
        clean_t = raw_t[len("file://") :] if raw_t.startswith("file://") else raw_t
        tp = Path(clean_t)
        tp = (root / tp).resolve() if not tp.is_absolute() else tp.resolve()
        try:
            rel_t = tp.relative_to(root).as_posix()
            if not is_ignored_rel_path(rel_t):
                candidate_mod_rels.add(rel_t)
        except ValueError:
            pass

    code_exts = {".ts", ".tsx", ".js", ".mjs", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".c"}
    violations: List[str] = []

    for mod_rel in sorted(candidate_mod_rels):
        mod_path = root / mod_rel
        if not mod_path.is_file() or mod_path.suffix.lower() not in code_exts:
            continue
        if ".test." in mod_rel or ".spec." in mod_rel or mod_rel.startswith(("test/", "tests/")):
            continue

        counterparts: List[str] = []
        mod_name = mod_path.name
        mod_parts = Path(mod_rel).parts
        for bp in benchmark_paths:
            bp_path = root / bp
            if bp_path.is_file() and bp != mod_rel and bp_path.name == mod_name and bp not in counterparts:
                counterparts.append(bp)
            elif bp_path.is_dir():
                direct_cand = (Path(bp) / mod_name).as_posix()
                if (root / direct_cand).is_file() and direct_cand != mod_rel and direct_cand not in counterparts:
                    counterparts.append(direct_cand)
            bp_parts = Path(bp).parts
            if (
                len(mod_parts) >= 3
                and len(bp_parts) >= 2
                and mod_parts[0] == bp_parts[0]
                and mod_parts[1] != bp_parts[1]
            ):
                mapped_rel = Path(bp_parts[0], bp_parts[1], *mod_parts[2:]).as_posix()
                if (root / mapped_rel).is_file() and mapped_rel != mod_rel and mapped_rel not in counterparts:
                    counterparts.append(mapped_rel)

        if not counterparts:
            continue
        try:
            mod_lines = normalize_structural_lines(mod_path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if len(mod_lines) < 15:
            continue

        for cp_rel in counterparts:
            cp_path = root / cp_rel
            if mod_path.resolve() == cp_path.resolve():
                continue
            try:
                cp_lines = normalize_structural_lines(cp_path.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            if len(cp_lines) < 15:
                continue
            ratio = difflib.SequenceMatcher(None, mod_lines, cp_lines).ratio()
            if ratio >= 0.78:
                violations.append(f"`{mod_rel}` vs `{cp_rel}` ({ratio * 100:.1f}% structural skeleton match)")
                break
    return violations


def increment_continuation_counter(stamp_path: Path, stamp: Optional[Dict[str, Any]]) -> int:
    data: Dict[str, Any] = dict(stamp) if isinstance(stamp, dict) else {}
    count = int(data.get("stopContinuations", 0)) + 1
    data["stopContinuations"] = count
    try:
        stamp_path.parent.mkdir(parents=True, exist_ok=True)
        stamp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return count


def main() -> int:
    raw_stdin = sys.stdin.read().strip()
    hook_input: Dict[str, Any] = {}
    if raw_stdin:
        try:
            hook_input = json.loads(raw_stdin)
        except Exception:
            return emit({})

    termination_reason = hook_input.get("terminationReason", "NO_TOOL_CALL")
    if termination_reason and termination_reason != "NO_TOOL_CALL":
        return emit({})

    root = resolve_workspace_root(hook_input)
    if is_superseded_by_workspace_hook(root, __file__):
        return emit({})

    state_path = root / ".agents" / "argonaut-state.md"
    stamp_path = root / ".agents" / ".argonaut-verify.stamp.json"
    lock_path = root / ".agents" / ".argonaut-intent.lock.json"
    if not state_path.exists():
        return emit({})

    (
        is_subagent,
        is_waiting_for_subagent,
        touched_state,
        source_edits_in_turn,
        subagent_invoked_after_last_edit,
        latest_subagent_id,
        edited_targets_in_turn,
    ) = inspect_transcript_subagent_state(resolve_transcript_file(hook_input))
    if is_subagent or is_waiting_for_subagent:
        return emit({})

    status, iteration, unchecked_items, has_audit_section = parse_state_file(state_path)
    if iteration >= MAX_ITERATIONS or status in {"BLOCKED", "ABORTED"}:
        return emit({})

    stamp = load_json_file(stamp_path)
    conv_id = extract_conversation_id(hook_input)
    owner_conv_id = str(stamp.get("ownerConversationId", "")) if isinstance(stamp, dict) else ""
    if conv_id and owner_conv_id and owner_conv_id != conv_id and not touched_state:
        return emit({})
    if stamp and int(stamp.get("stopContinuations", 0)) >= MAX_STOP_CONTINUATIONS:
        return emit({})

    intent_lock = load_json_file(lock_path)
    if intent_lock and intent_lock.get("intentMode") == "READ_ONLY":
        return emit({})

    forbidden_mod, out_of_scope_mod, locked_spec_mod = find_off_script_file_violations(root, intent_lock)
    if forbidden_mod:
        return cont(
            stamp_path,
            stamp,
            f"Argonaut Off-Script Safeguard Violation: Forbidden file(s) [{', '.join(forbidden_mod)}] "
            "were modified contrary to the user's explicit prompt constraints. Revert your changes to "
            f"[{', '.join(forbidden_mod)}] and re-run `verify.py` before finishing.",
        )
    if locked_spec_mod:
        return cont(
            stamp_path,
            stamp,
            f"Argonaut Anti-Spec-Laundering Violation: Ground-truth specification/design-doc file(s) "
            f"[{', '.join(locked_spec_mod)}] were modified during implementation. Revert your changes to "
            f"[{', '.join(locked_spec_mod)}], modify the implementation code to satisfy the specification, "
            "and re-run `verify.py` before finishing.",
        )
    if out_of_scope_mod:
        return cont(
            stamp_path,
            stamp,
            f"Argonaut Off-Script Safeguard Violation: File(s) [{', '.join(out_of_scope_mod)}] "
            "were modified outside the user's strict allowed file scope. Revert those changes and "
            "re-run `verify.py` before finishing.",
        )

    if status == "COMPLETED":
        if unchecked_items:
            preview = "; ".join(unchecked_items[:3])
            return cont(
                stamp_path,
                stamp,
                f"Argonaut Law 0 Violation: Unchecked user constraints or acceptance criteria "
                f"remain in `.agents/argonaut-state.md` ({len(unchecked_items)} unchecked: {preview}). "
                "Verify that every user instruction is satisfied in the implementation, run `verify.py`, "
                "and check off each `- [x]` item before completing.",
            )
        if not stamp or not stamp.get("passed", False):
            return cont(
                stamp_path,
                stamp,
                "Argonaut Law 3 Violation: `.agents/argonaut-state.md` is marked COMPLETED, "
                "but `verify.py` has not recorded a passing verification run (`exit 0`). "
                "Run `verify.py` now and confirm all gates pass before finishing.",
            )
        if stamp.get("fingerprint") != compute_tree_fingerprint(root):
            return cont(
                stamp_path,
                stamp,
                "Argonaut Law 3 Violation: Source files were modified after `verify.py` last passed. "
                "You MUST re-run `verify.py` and observe `exit 0` after your final code edit before "
                "declaring the task COMPLETED.",
            )
        if not has_audit_section:
            return cont(
                stamp_path,
                stamp,
                "Argonaut Phase 4 Anti-Laziness Violation: `.agents/argonaut-state.md` is marked COMPLETED, "
                "but is missing a completed `## Adversarial Diff Audit` section (`- [x] **Critic Verdict:** ...`). "
                "Run Phase 4 Adversarial Diff Review (using an independent `research` subagent via `invoke_subagent` "
                "to audit `git diff` against the user's prompt and `Forbidden Lazy Shortcut`) and record the verdict "
                "before completing.",
            )
        if source_edits_in_turn and not subagent_invoked_after_last_edit:
            return cont(
                stamp_path,
                stamp,
                "Argonaut Phase 4 Anti-Laziness Violation: Self-certified `Critic Verdict` detected "
                "(or stale/reused subagent audit) — workspace source files were modified after the last "
                "`invoke_subagent` call (or `invoke_subagent` was never called). You are forbidden from "
                "self-certifying or reusing an earlier Critic subagent via `send_message` across iterations. "
                "Make a fresh `invoke_subagent` call (`TypeName: \"research\"`) after your final source edit "
                "before marking the task COMPLETED.",
            )

        benchmark_paths = extract_workspace_benchmark_paths(state_path, root)
        if source_edits_in_turn and benchmark_paths:
            clone_violations = find_skeleton_clone_violations(
                root, state_path, intent_lock, benchmark_paths, edited_targets_in_turn
            )
            if clone_violations:
                return cont(
                    stamp_path,
                    stamp,
                    "Argonaut Structural Clone Violation (Law 1 & Law 2): Deterministic normalized-skeleton "
                    f"analysis detected that modified file(s) [{', '.join(clone_violations)}] still retain "
                    ">=78% of the exact declaration/coordinate skeleton of the reference template. "
                    "Renaming identifiers and shifting numbers/coordinates on a cloned skeleton is forbidden. "
                    "Tear down and replace the underlying structural topology in the root plan/schema file, "
                    "re-run `verify.py`, and re-audit with a fresh `invoke_subagent` before completing.",
                )

        if source_edits_in_turn and latest_subagent_id:
            critic_inspection_err = verify_critic_subagent_inspection(latest_subagent_id, benchmark_paths)
            if critic_inspection_err:
                return cont(stamp_path, stamp, critic_inspection_err)

        return emit({})

    return cont(
        stamp_path,
        stamp,
        f"Argonaut Loop Active (Status: {status}, Iteration: {iteration}/{MAX_ITERATIONS}). "
        "Do not yield control back to the user until `verify.py` passes (exit 0), "
        "Phase 4 Adversarial Diff Review succeeds, all User Intent & Constraints checkboxes are marked `[x]`, "
        "and `.agents/argonaut-state.md` Status is set to COMPLETED.",
    )


if __name__ == "__main__":
    sys.exit(main())
