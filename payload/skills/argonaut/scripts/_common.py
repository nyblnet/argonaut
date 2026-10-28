#!/usr/bin/env python3
"""Shared utilities for Argonaut runtime hooks and verification scripts."""

import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

AGENT_DOT_DIRS = {".agents", ".agent", "_agents", "_agent"}
ACTIVE_STATUSES = {"PLANNING", "IMPLEMENTING", "VERIFYING", "AUDITING"}
IGNORED_DIRS = AGENT_DOT_DIRS | {
    ".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".next", ".nuxt",
    "dist", "build", "out", "target", "coverage",
}


def emit(payload: Dict[str, Any]) -> int:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    return 0


def read_stdin_json() -> Optional[Dict[str, Any]]:
    raw = sys.stdin.read().strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def load_json_file(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def resolve_workspace_root(hook_input: Optional[Dict[str, Any]] = None) -> Path:
    env_root = os.environ.get("ARGONAUT_WORKSPACE_ROOT")
    if env_root:
        return Path(env_root).resolve()

    if isinstance(hook_input, dict):
        ws_paths = hook_input.get("workspacePaths")
        if isinstance(ws_paths, list) and ws_paths:
            first = ws_paths[0]
            if isinstance(first, str) and first.strip():
                if first.startswith("file://"):
                    first = first[len("file://") :]
                candidate = Path(first).resolve()
                if candidate.exists():
                    return candidate

    cwd = Path.cwd().resolve()
    return cwd.parent if cwd.name in AGENT_DOT_DIRS else cwd


def is_superseded_by_workspace_hook(root: Path, script_file: str) -> bool:
    """Returns True if script_file is running from the global plugin while a workspace hook is installed."""
    this_script = Path(script_file).resolve().as_posix()
    if ".gemini/config/plugins/argonaut" in this_script:
        ws_hook = root / ".agents" / "hooks.json"
        ws_script = root / ".agents" / "skills" / "argonaut" / "scripts" / Path(script_file).name
        if ws_hook.exists() and ws_script.exists():
            return True
    return False


def extract_conversation_id(hook_input: Dict[str, Any]) -> str:
    conv_id = hook_input.get("conversationId")
    if isinstance(conv_id, str) and conv_id.strip():
        return conv_id.strip()
    for field in ("transcriptPath", "artifactDirectoryPath"):
        val = hook_input.get(field)
        if isinstance(val, str) and "/brain/" in val:
            m = re.search(r"/brain/([^/]+)(?:/|$)", val)
            if m:
                return m.group(1)
    return ""


def resolve_transcript_file(hook_input: Dict[str, Any]) -> Optional[Path]:
    candidates: List[Path] = []

    raw_tp = hook_input.get("transcriptPath")
    if isinstance(raw_tp, str) and raw_tp.strip():
        tp = Path(raw_tp.replace("file://", ""))
        candidates.append(tp.with_name("transcript_full.jsonl"))
        candidates.append(tp)

    raw_ad = hook_input.get("artifactDirectoryPath")
    if isinstance(raw_ad, str) and raw_ad.strip():
        ad = Path(raw_ad.replace("file://", ""))
        candidates.append(ad / ".system_generated" / "logs" / "transcript_full.jsonl")
        candidates.append(ad / ".system_generated" / "logs" / "transcript.jsonl")

    conv_id = extract_conversation_id(hook_input)
    if conv_id:
        brain_logs = Path.home() / ".gemini" / "antigravity" / "brain" / conv_id / ".system_generated" / "logs"
        candidates.append(brain_logs / "transcript_full.jsonl")
        candidates.append(brain_logs / "transcript.jsonl")

    for cand in candidates:
        if cand.exists() and cand.is_file():
            return cand
    return None


def is_ignored_rel_path(rel_posix: str) -> bool:
    parts = Path(rel_posix).parts
    if not parts or any(p in IGNORED_DIRS for p in parts):
        return True
    fname = parts[-1]
    return fname.startswith(".DS_Store") or fname.endswith(".pyc")


def hash_single_file(fpath: Path) -> Optional[str]:
    try:
        st = fpath.stat()
        if st.st_size <= 2 * 1024 * 1024:
            return hashlib.sha256(fpath.read_bytes()).hexdigest()
        return f"size:{st.st_size}:mtime:{st.st_mtime_ns}"
    except OSError:
        return None


def snapshot_workspace_files(root: Path, allow_git: bool = True) -> Dict[str, str]:
    """Returns a compact snapshot of workspace files (Git-accelerated when in a Git repo)."""
    if allow_git and (root / ".git").exists() and shutil.which("git") is not None:
        try:
            head_proc = subprocess.run(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=5,
            )
            status_proc = subprocess.run(
                ["git", "status", "--porcelain=v1", "-z", "-uall", "--no-renames"],
                cwd=root,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=10,
            )
            if head_proc.returncode == 0 and status_proc.returncode == 0:
                files: Dict[str, str] = {"__git_head__": head_proc.stdout.strip()}
                for entry in status_proc.stdout.split("\0"):
                    if len(entry) < 4:
                        continue
                    rel_posix = entry[3:]
                    if is_ignored_rel_path(rel_posix):
                        continue
                    fpath = root / rel_posix
                    if fpath.exists() and fpath.is_file():
                        fhash = hash_single_file(fpath)
                        if fhash is not None:
                            files[rel_posix] = fhash
                    elif not fpath.exists():
                        files[rel_posix] = "__deleted__"
                return files
        except Exception:
            pass

    files = {}
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
        rel_dir = Path(dirpath).relative_to(root)
        for fname in sorted(filenames):
            if fname.startswith(".DS_Store") or fname.endswith(".pyc"):
                continue
            fpath = Path(dirpath) / fname
            rel_posix = (rel_dir / fname).as_posix() if str(rel_dir) != "." else fname
            fhash = hash_single_file(fpath)
            if fhash is not None:
                files[rel_posix] = fhash
    return files


def compute_tree_fingerprint(root: Path) -> str:
    """Computes a deterministic SHA-256 fingerprint of workspace source files outside .agents/."""
    hasher = hashlib.sha256()
    files = snapshot_workspace_files(root)
    for rel_posix in sorted(files.keys()):
        hasher.update(f"{rel_posix}:{files[rel_posix]}\n".encode("utf-8"))
    return hasher.hexdigest()


def matches_any_pattern(rel_posix: str, patterns: List[str]) -> bool:
    basename = Path(rel_posix).name
    for raw_pat in patterns:
        pat = raw_pat.strip().strip("`'\"")
        if not pat or pat.lower() in {"none", "n/a", "*"}:
            continue
        if rel_posix == pat or basename == pat:
            return True
        if fnmatch.fnmatch(rel_posix, pat) or fnmatch.fnmatch(basename, pat):
            return True
        if pat.endswith("/") and rel_posix.startswith(pat):
            return True
    return False
