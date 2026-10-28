#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAYLOAD_DIR = path.resolve(__dirname, "..", "payload");

const args = process.argv.slice(2);
const nonFlagArgs = args.filter((a) => !a.startsWith("-"));
const command = nonFlagArgs[0] || (args.includes("--uninstall") ? "uninstall" : "init");
const isGlobal = args.includes("--global") || args.includes("-g");

const MARKER_START = "<!-- ARGONAUT-DISCIPLINE-START -->";
const MARKER_END = "<!-- ARGONAUT-DISCIPLINE-END -->";

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
}

function setExecutableScripts(skillDir) {
  for (const scriptName of [
    "verify.py",
    "stop_guard.py",
    "pre_edit_guard.py",
    "intent_anchor.py",
  ]) {
    const scriptPath = path.join(skillDir, "scripts", scriptName);
    if (fs.existsSync(scriptPath)) {
      fs.chmodSync(scriptPath, 0o755);
    }
  }
}

function mergeHooksJson(targetHooksPath) {
  const payloadHooks = JSON.parse(
    fs.readFileSync(path.join(PAYLOAD_DIR, "hooks.json"), "utf8")
  );
  let current = {};
  if (fs.existsSync(targetHooksPath)) {
    try {
      current = JSON.parse(fs.readFileSync(targetHooksPath, "utf8"));
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...payloadHooks };
  fs.mkdirSync(path.dirname(targetHooksPath), { recursive: true });
  fs.writeFileSync(targetHooksPath, JSON.stringify(merged, null, 2) + "\n");
}

function removeFromHooksJson(targetHooksPath) {
  if (!fs.existsSync(targetHooksPath)) return;
  try {
    const current = JSON.parse(fs.readFileSync(targetHooksPath, "utf8"));
    delete current["argonaut-stop-guard"];
    delete current["argonaut-pre-edit-guard"];
    delete current["argonaut-intent-anchor"];
    if (Object.keys(current).length === 0) {
      fs.rmSync(targetHooksPath, { force: true });
    } else {
      fs.writeFileSync(targetHooksPath, JSON.stringify(current, null, 2) + "\n");
    }
  } catch {
    // Ignore malformed user hooks.json on uninstall
  }
}

function ensureGitignore(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entries = [
    ".agents/argonaut-state.md",
    ".agents/.argonaut-verify.stamp.json",
    ".agents/.argonaut-intent.lock.json",
  ];

  let content = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf8")
    : "";

  const missing = entries.filter((entry) => !content.includes(entry));
  if (missing.length === 0) return;

  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  const header = content.includes("# Argonaut ephemeral loop state")
    ? ""
    : `${prefix}# Argonaut ephemeral loop state\n`;
  const addition = `${header}${missing.join("\n")}\n`;

  if (fs.existsSync(gitignorePath)) {
    fs.appendFileSync(gitignorePath, addition);
  } else {
    fs.writeFileSync(gitignorePath, addition);
  }
}

function installWorkspace() {
  const cwd = process.cwd();
  const agentsDir = path.join(cwd, ".agents");
  copyRecursive(path.join(PAYLOAD_DIR, "rules"), path.join(agentsDir, "rules"));
  copyRecursive(path.join(PAYLOAD_DIR, "skills"), path.join(agentsDir, "skills"));

  setExecutableScripts(path.join(agentsDir, "skills", "argonaut"));
  mergeHooksJson(path.join(agentsDir, "hooks.json"));

  const verifyJson = path.join(agentsDir, "verify.json");
  if (!fs.existsSync(verifyJson)) {
    fs.writeFileSync(verifyJson, JSON.stringify({ commands: [] }, null, 2) + "\n");
  }

  ensureGitignore(cwd);
  console.log("✅ Argonaut installed into workspace (.agents/)");
  console.log("   • Rule:  .agents/rules/argonaut-discipline.md");
  console.log("   • Skill: .agents/skills/argonaut/SKILL.md");
  console.log("   • Gate:  .agents/skills/argonaut/scripts/verify.py");
  console.log(
    "   • Hooks: .agents/hooks.json (PreInvocation -> intent_anchor.py, PreToolUse -> pre_edit_guard.py, Stop -> stop_guard.py)"
  );
  console.log("\n🚀 Usage in Antigravity: Enable Turbo Mode and type `/argonaut <your task>`");
}

function installGlobal() {
  const home = os.homedir();
  const geminiConfig = path.join(home, ".gemini", "config");
  const globalSkillDest = path.join(geminiConfig, "skills", "argonaut");
  copyRecursive(path.join(PAYLOAD_DIR, "skills", "argonaut"), globalSkillDest);
  setExecutableScripts(globalSkillDest);

  // Also install native Antigravity plugin bundle in ~/.gemini/config/plugins/argonaut
  const globalPluginDest = path.join(geminiConfig, "plugins", "argonaut");
  fs.mkdirSync(globalPluginDest, { recursive: true });
  fs.copyFileSync(
    path.join(PAYLOAD_DIR, "plugin.json"),
    path.join(globalPluginDest, "plugin.json")
  );
  fs.copyFileSync(
    path.join(PAYLOAD_DIR, "hooks.json"),
    path.join(globalPluginDest, "hooks.json")
  );
  copyRecursive(
    path.join(PAYLOAD_DIR, "skills", "argonaut"),
    path.join(globalPluginDest, "skills", "argonaut")
  );
  setExecutableScripts(path.join(globalPluginDest, "skills", "argonaut"));

  const ruleRaw = fs.readFileSync(
    path.join(PAYLOAD_DIR, "rules", "argonaut-discipline.md"),
    "utf8"
  );
  const ruleBody = stripFrontmatter(ruleRaw);
  // Remove any legacy duplicate plugin rules/AGENTS.md so Antigravity does not inject the global rule twice alongside GEMINI.md
  fs.rmSync(path.join(globalPluginDest, "rules"), { recursive: true, force: true });

  // Append or update Always-On Rule in ~/.gemini/GEMINI.md
  const geminiMdPath = path.join(home, ".gemini", "GEMINI.md");
  const block = `${MARKER_START}\n${ruleBody}\n${MARKER_END}`;

  fs.mkdirSync(path.dirname(geminiMdPath), { recursive: true });
  if (fs.existsSync(geminiMdPath)) {
    const existing = fs.readFileSync(geminiMdPath, "utf8");
    if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
      const updated = existing.replace(
        new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`),
        block
      );
      fs.writeFileSync(geminiMdPath, updated);
    } else {
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
      fs.appendFileSync(geminiMdPath, `${prefix}${block}\n`);
    }
  } else {
    fs.writeFileSync(geminiMdPath, `${block}\n`);
  }

  console.log("🌐 Argonaut installed GLOBALLY for all Antigravity workspaces!");
  console.log(`   • Global Skill:  ${globalSkillDest}`);
  console.log(`   • Global Plugin: ${globalPluginDest}`);
  console.log(`   • Global Rules:  ${geminiMdPath}`);
}

function runDoctor() {
  const localVerify = path.join(
    process.cwd(),
    ".agents",
    "skills",
    "argonaut",
    "scripts",
    "verify.py"
  );
  const globalVerify = path.join(
    os.homedir(),
    ".gemini",
    "config",
    "skills",
    "argonaut",
    "scripts",
    "verify.py"
  );
  const packagedVerify = path.join(
    PAYLOAD_DIR,
    "skills",
    "argonaut",
    "scripts",
    "verify.py"
  );

  const target = fs.existsSync(localVerify)
    ? localVerify
    : fs.existsSync(globalVerify)
    ? globalVerify
    : packagedVerify;

  console.log(`🔍 Running Argonaut Doctor using: ${target}\n`);
  const res = spawnSync("python3", [target], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

function uninstall() {
  if (isGlobal) {
    const home = os.homedir();
    const globalSkillDest = path.join(home, ".gemini", "config", "skills", "argonaut");
    const globalPluginDest = path.join(home, ".gemini", "config", "plugins", "argonaut");
    fs.rmSync(globalSkillDest, { recursive: true, force: true });
    fs.rmSync(globalPluginDest, { recursive: true, force: true });

    const geminiMdPath = path.join(home, ".gemini", "GEMINI.md");
    if (fs.existsSync(geminiMdPath)) {
      const existing = fs.readFileSync(geminiMdPath, "utf8");
      if (existing.includes(MARKER_START)) {
        const cleaned = existing
          .replace(new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`), "\n")
          .trim();
        if (cleaned.length === 0) {
          fs.rmSync(geminiMdPath, { force: true });
        } else {
          fs.writeFileSync(geminiMdPath, cleaned + "\n");
        }
      }
    }
    console.log("🗑️  Removed global Argonaut skill, plugin, and GEMINI.md rules.");
  } else {
    const cwd = process.cwd();
    fs.rmSync(path.join(cwd, ".agents", "rules", "argonaut-discipline.md"), { force: true });
    fs.rmSync(path.join(cwd, ".agents", "skills", "argonaut"), { recursive: true, force: true });
    fs.rmSync(path.join(cwd, ".agents", "argonaut-state.md"), { force: true });
    fs.rmSync(path.join(cwd, ".agents", ".argonaut-verify.stamp.json"), { force: true });
    fs.rmSync(path.join(cwd, ".agents", ".argonaut-intent.lock.json"), { force: true });
    removeFromHooksJson(path.join(cwd, ".agents", "hooks.json"));
    console.log("🗑️  Removed Argonaut from current workspace.");
  }
}

if (command === "init" || command === "install") {
  isGlobal ? installGlobal() : installWorkspace();
} else if (command === "doctor" || command === "verify") {
  runDoctor();
} else if (command === "uninstall" || command === "remove") {
  uninstall();
} else {
  console.log("Usage: npx argonaut-ai [init | init --global | doctor | uninstall | uninstall --global]");
}
