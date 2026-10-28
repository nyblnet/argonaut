#!/usr/bin/env python3
"""
Argonaut Deterministic Verification Harness for Google Antigravity.
Auto-detects project toolchains or reads `.agents/verify.json`, executes all
typecheck, lint, and test gates sequentially, records a verification stamp in
`.agents/.argonaut-verify.stamp.json`, and outputs token-efficient diagnostics
for the Argonaut agent loop.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Tuple

from _common import IGNORED_DIRS, compute_tree_fingerprint, load_json_file, resolve_workspace_root

ROOT = resolve_workspace_root()
AGENTS_DIR = ROOT / ".agents"
CONFIG_PATH = AGENTS_DIR / "verify.json"
STAMP_PATH = AGENTS_DIR / ".argonaut-verify.stamp.json"
MAX_OUTPUT_LINES = 120
CMD_TIMEOUT_SECONDS = 300


def has_cmd(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def write_stamp(passed: bool, exit_code: int, gates: List[str], failed_gate: str = "") -> None:
    if not AGENTS_DIR.exists():
        return
    try:
        existing = load_json_file(STAMP_PATH) or {}
        owner_conv_id = str(existing.get("ownerConversationId", ""))
        payload = {
            "passed": passed,
            "exitCode": exit_code,
            "timestamp": time.time(),
            "fingerprint": compute_tree_fingerprint(ROOT),
            "gates": gates,
            "failedGate": failed_gate,
            "stopContinuations": 0,
        }
        if owner_conv_id:
            payload["ownerConversationId"] = owner_conv_id
        STAMP_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def detect_node_pm() -> str:
    if (ROOT / "pnpm-lock.yaml").exists() and has_cmd("pnpm"):
        return "pnpm"
    if (ROOT / "yarn.lock").exists() and has_cmd("yarn"):
        return "yarn"
    if ((ROOT / "bun.lockb").exists() or (ROOT / "bun.lock").exists()) and has_cmd("bun"):
        return "bun"
    return "npm"


def is_self_referential_script(script_cmd: str) -> bool:
    """Prevents infinite recursion if package.json scripts invoke argonaut doctor/verify."""
    normalized = " ".join(script_cmd.strip().split())
    if "no test specified" in normalized.lower():
        return True
    for pattern in ("argonaut.mjs doctor", "argonaut.mjs verify", "argonaut doctor", "argonaut verify", "verify.py"):
        if pattern in normalized:
            return True
    return False


def has_python_tests(root: Path) -> bool:
    if (root / "tests").is_dir() or (root / "test").is_dir():
        return True
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for fname in filenames:
            if (fname.startswith("test_") and fname.endswith(".py")) or fname.endswith("_test.py"):
                return True
    return False


def discover_commands() -> List[Tuple[str, str]]:
    """Returns a list of (gate_name, shell_command) tuples."""
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            cmds = data.get("commands", [])
            if cmds:
                return [(c.get("name", f"Gate {i+1}"), c["cmd"]) for i, c in enumerate(cmds) if c.get("cmd")]
        except Exception as exc:
            print(f"[argonaut verify.py] Warning: Failed to parse {CONFIG_PATH}: {exc}", file=sys.stderr)

    gates: List[Tuple[str, str]] = []

    pkg_json = ROOT / "package.json"
    if pkg_json.exists():
        pm = detect_node_pm()
        run_prefix = f"{pm} run"
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            scripts = pkg.get("scripts", {})
            for script_name, label in [
                ("typecheck", "TypeScript Typecheck"),
                ("check-types", "TypeScript Typecheck"),
                ("lint", "Linter"),
                ("test", "Test Suite"),
            ]:
                if script_name in scripts:
                    raw_script = str(scripts.get(script_name, ""))
                    if is_self_referential_script(raw_script):
                        continue
                    cmd = f"{run_prefix} {script_name}"
                    if script_name == "test" and pm == "npm":
                        cmd = "npm test -- --watchAll=false" if "react-scripts" in raw_script else "npm test"
                    gates.append((f"Node ({label}: {script_name})", cmd))
        except Exception:
            pass

        if (ROOT / "tsconfig.json").exists() and not any("Typecheck" in g[0] for g in gates):
            gates.append(("TypeScript (tsc --noEmit)", "npx --no-install tsc --noEmit"))

    if (ROOT / "pyproject.toml").exists() or (ROOT / "requirements.txt").exists() or list(ROOT.glob("*.py")):
        if has_cmd("ruff"):
            gates.append(("Python Lint (ruff)", "ruff check ."))
        if has_cmd("pyright") and ((ROOT / "pyrightconfig.json").exists() or (ROOT / "pyproject.toml").exists()):
            gates.append(("Python Typecheck (pyright)", "pyright"))
        elif has_cmd("mypy") and ((ROOT / "mypy.ini").exists() or (ROOT / "pyproject.toml").exists()):
            gates.append(("Python Typecheck (mypy)", "mypy ."))
        if has_cmd("pytest") and has_python_tests(ROOT):
            gates.append(("Python Tests (pytest)", "pytest -q --tb=short"))

    if (ROOT / "go.mod").exists() and has_cmd("go"):
        gates.append(("Go Vet", "go vet ./..."))
        gates.append(("Go Test", "go test ./..."))

    if (ROOT / "Cargo.toml").exists() and has_cmd("cargo"):
        gates.append(("Rust Check", "cargo check --quiet"))
        gates.append(("Rust Test", "cargo test --quiet"))

    return gates


def format_output(raw: str) -> str:
    lines = [line for line in raw.splitlines() if line.strip()]
    if len(lines) <= MAX_OUTPUT_LINES:
        return "\n".join(lines)
    head = lines[:30]
    tail = lines[-(MAX_OUTPUT_LINES - 30) :]
    omitted = len(lines) - len(head) - len(tail)
    return "\n".join(head + [f"\n... [{omitted} lines omitted for token efficiency] ...\n"] + tail)


def main() -> int:
    if os.environ.get("ARGONAUT_VERIFY_ACTIVE") == "1":
        print("[argonaut verify.py] Re-entrant invocation detected; skipping recursive gate execution.")
        return 0

    gates = discover_commands()
    gate_names = [name for name, _ in gates]

    if not gates:
        write_stamp(passed=True, exit_code=0, gates=[])
        print("====================================================")
        print("ARGONAUT VERIFY STATUS: NO AUTOMATED GATES DETECTED")
        print("Tip: Add a `.agents/verify.json` file with custom")
        print('commands: {"commands": [{"name": "Test", "cmd": "..."}]}')
        print("====================================================")
        return 0

    print(f"=== ARGONAUT VERIFICATION HARNESS ({len(gates)} gates) ===")
    env = os.environ.copy()
    env["CI"] = "true"
    env["FORCE_COLOR"] = "0"
    env["ARGONAUT_VERIFY_ACTIVE"] = "1"

    for idx, (name, cmd) in enumerate(gates, 1):
        start = time.time()
        print(f"\n[{idx}/{len(gates)}] Running {name}: `{cmd}` ...")
        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=CMD_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            write_stamp(passed=False, exit_code=1, gates=gate_names, failed_gate=name)
            print(f"FAIL: {name} timed out after {CMD_TIMEOUT_SECONDS}s")
            if exc.stdout:
                out_str = exc.stdout if isinstance(exc.stdout, str) else exc.stdout.decode("utf-8", "ignore")
                print(format_output(out_str))
            return 1

        elapsed = time.time() - start
        if proc.returncode != 0:
            write_stamp(passed=False, exit_code=proc.returncode, gates=gate_names, failed_gate=name)
            print(f"FAIL [{name}] (exit code {proc.returncode} in {elapsed:.2f}s)")
            print("--- DIAGNOSTIC TRACE ---")
            print(format_output(proc.stdout or "(no output)"))
            print("------------------------")
            print("\nACTION REQUIRED: Fix the root cause above and re-run the Argonaut verify.py harness.")
            return proc.returncode

        print(f"PASS [{name}] ({elapsed:.2f}s)")

    write_stamp(passed=True, exit_code=0, gates=gate_names)
    print("\n====================================================")
    print("ALL ARGONAUT VERIFICATION GATES PASSED (EXIT CODE 0)")
    print("Proceed to Phase 4: Adversarial Diff Review.")
    print("====================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
