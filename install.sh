#!/usr/bin/env bash
set -euo pipefail

MODE="workspace"
ACTION="install"

for arg in "$@"; do
  case "${arg}" in
    --global|-g)
      MODE="global"
      ;;
    --uninstall|uninstall|remove)
      ACTION="uninstall"
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

if [[ "${ACTION}" == "uninstall" ]]; then
  if [[ "${MODE}" == "global" ]]; then
    rm -rf "${HOME}/.gemini/config/skills/argonaut" "${HOME}/.gemini/config/plugins/argonaut"
    GEMINI_MD="${HOME}/.gemini/GEMINI.md"
    if [[ -f "${GEMINI_MD}" ]] && grep -q "ARGONAUT-DISCIPLINE-START" "${GEMINI_MD}" 2>/dev/null; then
      python3 - "${GEMINI_MD}" <<'PY'
import re, sys
from pathlib import Path
p = Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
cleaned = re.sub(r"\n*<!-- ARGONAUT-DISCIPLINE-START -->[\s\S]*?<!-- ARGONAUT-DISCIPLINE-END -->\n*", "\n", text).strip()
if cleaned:
    p.write_text(cleaned + "\n", encoding="utf-8")
else:
    p.unlink(missing_ok=True)
PY
    fi
    echo "🗑️  Removed global Argonaut skill, plugin, and GEMINI.md rules."
  else
    rm -f .agents/rules/argonaut-discipline.md .agents/argonaut-state.md .agents/.argonaut-verify.stamp.json .agents/.argonaut-intent.lock.json
    rm -rf .agents/skills/argonaut
    if [[ -f .agents/hooks.json ]]; then
      python3 - .agents/hooks.json <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
try:
    data = json.loads(p.read_text(encoding="utf-8"))
    data.pop("argonaut-stop-guard", None)
    data.pop("argonaut-pre-edit-guard", None)
    data.pop("argonaut-intent-anchor", None)
    if data:
        p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    else:
        p.unlink(missing_ok=True)
except Exception:
    pass
PY
    fi
    echo "🗑️  Removed Argonaut from current workspace."
  fi
  exit 0
fi

# Support running either from a cloned repo or via curl | bash
if [[ -d "${SCRIPT_DIR}/payload" ]]; then
  SRC_DIR="${SCRIPT_DIR}/payload"
else
  REPO_URL="${ARGONAUT_REPO_URL:-https://github.com/nyblnet/argonaut.git}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  echo "⬇️  Fetching Argonaut from ${REPO_URL}..."
  git clone --depth 1 "${REPO_URL}" "${TMP_DIR}/argonaut" >/dev/null 2>&1
  SRC_DIR="${TMP_DIR}/argonaut/payload"
fi

if [[ "${MODE}" == "global" ]]; then
  DEST_SKILL="${HOME}/.gemini/config/skills/argonaut"
  DEST_PLUGIN="${HOME}/.gemini/config/plugins/argonaut"
  mkdir -p "${DEST_SKILL}" "${DEST_PLUGIN}/skills/argonaut"
  rm -rf "${DEST_PLUGIN}/rules"

  cp -R "${SRC_DIR}/skills/argonaut/"* "${DEST_SKILL}/"
  chmod +x "${DEST_SKILL}/scripts/verify.py" "${DEST_SKILL}/scripts/stop_guard.py" "${DEST_SKILL}/scripts/pre_edit_guard.py" "${DEST_SKILL}/scripts/intent_anchor.py"

  cp "${SRC_DIR}/plugin.json" "${DEST_PLUGIN}/plugin.json"
  cp "${SRC_DIR}/hooks.json" "${DEST_PLUGIN}/hooks.json"
  cp -R "${SRC_DIR}/skills/argonaut/"* "${DEST_PLUGIN}/skills/argonaut/"
  chmod +x "${DEST_PLUGIN}/skills/argonaut/scripts/verify.py" "${DEST_PLUGIN}/skills/argonaut/scripts/stop_guard.py" "${DEST_PLUGIN}/skills/argonaut/scripts/pre_edit_guard.py" "${DEST_PLUGIN}/skills/argonaut/scripts/intent_anchor.py"

  GEMINI_MD="${HOME}/.gemini/GEMINI.md"
  mkdir -p "$(dirname "${GEMINI_MD}")"

  python3 - "${SRC_DIR}/rules/argonaut-discipline.md" "${GEMINI_MD}" <<'PY'
import re, sys
from pathlib import Path

rule_src = Path(sys.argv[1]).read_text(encoding="utf-8")
rule_body = re.sub(r"^---\r?\n[\s\S]*?\r?\n---\r?\n*", "", rule_src).strip()

gemini_md = Path(sys.argv[2])
marker_start = "<!-- ARGONAUT-DISCIPLINE-START -->"
marker_end = "<!-- ARGONAUT-DISCIPLINE-END -->"
block = f"{marker_start}\n{rule_body}\n{marker_end}"

if gemini_md.exists():
    existing = gemini_md.read_text(encoding="utf-8")
    if marker_start in existing and marker_end in existing:
        updated = re.sub(f"{marker_start}[\\s\\S]*?{marker_end}", block, existing)
        gemini_md.write_text(updated, encoding="utf-8")
    else:
        prefix = "\n\n" if existing and not existing.endswith("\n") else "\n"
        gemini_md.write_text(existing + f"{prefix}{block}\n", encoding="utf-8")
else:
    gemini_md.write_text(f"{block}\n", encoding="utf-8")
PY
  echo "🌐 Argonaut installed globally into ~/.gemini/"
else
  mkdir -p .agents/rules .agents/skills/argonaut
  cp "${SRC_DIR}/rules/argonaut-discipline.md" .agents/rules/
  cp -R "${SRC_DIR}/skills/argonaut/"* .agents/skills/argonaut/
  chmod +x .agents/skills/argonaut/scripts/verify.py .agents/skills/argonaut/scripts/stop_guard.py .agents/skills/argonaut/scripts/pre_edit_guard.py .agents/skills/argonaut/scripts/intent_anchor.py

  python3 - "${SRC_DIR}/hooks.json" ".agents/hooks.json" <<'PY'
import json, sys
from pathlib import Path
src = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
dst_path = Path(sys.argv[2])
current = {}
if dst_path.exists():
    try:
        current = json.loads(dst_path.read_text(encoding="utf-8"))
    except Exception:
        current = {}
current.update(src)
dst_path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
PY

  [[ -f .agents/verify.json ]] || printf '{\n  "commands": []\n}\n' > .agents/verify.json

  if ! grep -q ".agents/argonaut-state.md" .gitignore 2>/dev/null; then
    printf "\n# Argonaut ephemeral loop state\n.agents/argonaut-state.md\n.agents/.argonaut-verify.stamp.json\n.agents/.argonaut-intent.lock.json\n" >> .gitignore
  else
    grep -q ".agents/.argonaut-verify.stamp.json" .gitignore 2>/dev/null || printf ".agents/.argonaut-verify.stamp.json\n" >> .gitignore
    grep -q ".agents/.argonaut-intent.lock.json" .gitignore 2>/dev/null || printf ".agents/.argonaut-intent.lock.json\n" >> .gitignore
  fi
  echo "✅ Argonaut installed into workspace (.agents/)"
fi
