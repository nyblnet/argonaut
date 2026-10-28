import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "argonaut.mjs");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");
const VERIFY_PY = path.join(
  REPO_ROOT,
  "payload",
  "skills",
  "argonaut",
  "scripts",
  "verify.py"
);
const STOP_GUARD_PY = path.join(
  REPO_ROOT,
  "payload",
  "skills",
  "argonaut",
  "scripts",
  "stop_guard.py"
);
const PRE_EDIT_GUARD_PY = path.join(
  REPO_ROOT,
  "payload",
  "skills",
  "argonaut",
  "scripts",
  "pre_edit_guard.py"
);
const INTENT_ANCHOR_PY = path.join(
  REPO_ROOT,
  "payload",
  "skills",
  "argonaut",
  "scripts",
  "intent_anchor.py"
);

function makeTempDir(prefix = "argonaut-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("CLI workspace init and uninstall manage .agents/ and .gitignore cleanly", (t) => {
  const tmpWs = makeTempDir("argonaut-ws-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const initRes = spawnSync(process.execPath, [CLI_PATH, "init"], {
    cwd: tmpWs,
    encoding: "utf8",
  });
  assert.equal(initRes.status, 0, initRes.stderr);

  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "rules", "argonaut-discipline.md")));
  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "skills", "argonaut", "SKILL.md")));
  assert.ok(
    fs.existsSync(path.join(tmpWs, ".agents", "skills", "argonaut", "scripts", "verify.py"))
  );
  assert.ok(
    fs.existsSync(
      path.join(tmpWs, ".agents", "skills", "argonaut", "scripts", "stop_guard.py")
    )
  );
  assert.ok(
    fs.existsSync(
      path.join(tmpWs, ".agents", "skills", "argonaut", "scripts", "pre_edit_guard.py")
    )
  );
  assert.ok(
    fs.existsSync(
      path.join(tmpWs, ".agents", "skills", "argonaut", "scripts", "intent_anchor.py")
    )
  );
  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "hooks.json")));
  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "verify.json")));

  const gitignore = fs.readFileSync(path.join(tmpWs, ".gitignore"), "utf8");
  assert.match(gitignore, /\.agents\/argonaut-state\.md/);
  assert.match(gitignore, /\.agents\/\.argonaut-verify\.stamp\.json/);

  const uninstRes = spawnSync(process.execPath, [CLI_PATH, "uninstall"], {
    cwd: tmpWs,
    encoding: "utf8",
  });
  assert.equal(uninstRes.status, 0, uninstRes.stderr);
  assert.ok(
    !fs.existsSync(path.join(tmpWs, ".agents", "rules", "argonaut-discipline.md"))
  );
  assert.ok(!fs.existsSync(path.join(tmpWs, ".agents", "skills", "argonaut")));
  assert.ok(!fs.existsSync(path.join(tmpWs, ".agents", "hooks.json")));
});

test("CLI global init and uninstall manage ~/.gemini/ and GEMINI.md idempotently", (t) => {
  const tmpHome = makeTempDir("argonaut-home-");
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const geminiDir = path.join(tmpHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, "GEMINI.md"), "# Existing User Rules\n");

  const env = { ...process.env, HOME: tmpHome };
  const initRes = spawnSync(process.execPath, [CLI_PATH, "init", "--global"], {
    cwd: tmpHome,
    env,
    encoding: "utf8",
  });
  assert.equal(initRes.status, 0, initRes.stderr);

  assert.ok(
    fs.existsSync(
      path.join(tmpHome, ".gemini", "config", "skills", "argonaut", "SKILL.md")
    )
  );
  assert.ok(
    fs.existsSync(
      path.join(tmpHome, ".gemini", "config", "plugins", "argonaut", "plugin.json")
    )
  );

  const geminiMd = fs.readFileSync(path.join(geminiDir, "GEMINI.md"), "utf8");
  assert.match(geminiMd, /# Existing User Rules/);
  assert.match(geminiMd, /<!-- ARGONAUT-DISCIPLINE-START -->/);

  // Re-run global init to verify idempotency (no duplicate blocks)
  spawnSync(process.execPath, [CLI_PATH, "init", "--global"], {
    cwd: tmpHome,
    env,
    encoding: "utf8",
  });
  const geminiMdSecond = fs.readFileSync(path.join(geminiDir, "GEMINI.md"), "utf8");
  assert.equal(
    (geminiMdSecond.match(/<!-- ARGONAUT-DISCIPLINE-START -->/g) || []).length,
    1
  );

  // Global uninstall removes skill, plugin, and marker block while keeping existing user content
  const uninstRes = spawnSync(
    process.execPath,
    [CLI_PATH, "uninstall", "--global"],
    {
      cwd: tmpHome,
      env,
      encoding: "utf8",
    }
  );
  assert.equal(uninstRes.status, 0, uninstRes.stderr);
  assert.ok(
    !fs.existsSync(path.join(tmpHome, ".gemini", "config", "skills", "argonaut"))
  );
  assert.ok(
    !fs.existsSync(path.join(tmpHome, ".gemini", "config", "plugins", "argonaut"))
  );
  const geminiMdCleaned = fs.readFileSync(path.join(geminiDir, "GEMINI.md"), "utf8");
  assert.match(geminiMdCleaned, /# Existing User Rules/);
  assert.doesNotMatch(geminiMdCleaned, /ARGONAUT-DISCIPLINE/);
});

test("verify.py executes custom gates, writes verification stamp, and prevents recursion", (t) => {
  const tmpWs = makeTempDir("argonaut-verify-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(tmpWs, "app.py"), "x = 1\n");
  fs.writeFileSync(
    path.join(tmpWs, ".agents", "verify.json"),
    JSON.stringify({
      commands: [{ name: "Sanity Check", cmd: "python3 -c 'print(\"ok\")'" }],
    })
  );

  // Exclude ARGONAUT_VERIFY_ACTIVE so verify.py runs its full harness in the isolated workspace
  const cleanEnv = { ...process.env };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;

  const passRes = spawnSync("python3", [VERIFY_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    encoding: "utf8",
  });
  assert.equal(passRes.status, 0, passRes.stdout);
  assert.match(passRes.stdout, /ALL ARGONAUT VERIFICATION GATES PASSED/);

  const stampPath = path.join(tmpWs, ".agents", ".argonaut-verify.stamp.json");
  assert.ok(fs.existsSync(stampPath));
  const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  assert.equal(stamp.passed, true);
  assert.equal(typeof stamp.fingerprint, "string");

  // Re-entrancy guard test: when ARGONAUT_VERIFY_ACTIVE=1, verify.py skips immediately
  const reentrantRes = spawnSync("python3", [VERIFY_PY], {
    cwd: tmpWs,
    env: { ...cleanEnv, ARGONAUT_VERIFY_ACTIVE: "1" },
    encoding: "utf8",
  });
  assert.equal(reentrantRes.status, 0);
  assert.match(reentrantRes.stdout, /Re-entrant invocation detected/);
});

test("stop_guard.py enforces active Argonaut state and Law 3 verification stamp", (t) => {
  const tmpWs = makeTempDir("argonaut-stop-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;

  const hookInput = JSON.stringify({
    terminationReason: "NO_TOOL_CALL",
    workspacePaths: [tmpWs],
  });

  // 1. No .agents/argonaut-state.md -> allow stop ({})
  const idleRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(idleRes.stdout), {});

  // 2. Active state (Status: IMPLEMENTING) -> force continuation
  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(tmpWs, "index.js"), "export const a = 1;\n");
  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 1 / 10\n- **Status:** IMPLEMENTING\n"
  );

  const midLoopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  const midLoopJson = JSON.parse(midLoopRes.stdout);
  assert.equal(midLoopJson.decision, "continue");
  assert.match(midLoopJson.reason, /Argonaut Loop Active/);

  // 3. Status marked COMPLETED without running verify.py -> block stop (Law 3 violation)
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n"
  );
  const unverifiedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  const unverifiedJson = JSON.parse(unverifiedRes.stdout);
  assert.equal(unverifiedJson.decision, "continue");
  assert.match(unverifiedJson.reason, /Law 3 Violation/);

  // 4. Run verify.py (creates stamp), but leave an unchecked item (- [ ]) in state -> block stop!
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 2 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] **Product Goal:** Build feature\n- [ ] **Constraint 1:** Must not break v1 API\n"
  );
  const uncheckedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  const uncheckedJson = JSON.parse(uncheckedRes.stdout);
  assert.equal(uncheckedJson.decision, "continue");
  assert.match(uncheckedJson.reason, /Unchecked user constraints or acceptance criteria/);

  // 5. Check off all items (- [x]), but omit ## Adversarial Diff Audit -> block stop!
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 2 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] **Product Goal:** Build feature\n- [x] **Constraint 1:** Must not break v1 API\n"
  );
  const missingAuditRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  const missingAuditJson = JSON.parse(missingAuditRes.stdout);
  assert.equal(missingAuditJson.decision, "continue");
  assert.match(missingAuditJson.reason, /Adversarial Diff Audit/);

  // 6. Include checked-off ## Adversarial Diff Audit and valid stamp -> allow stop ({})
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 2 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] **Product Goal:** Build feature\n- [x] **Constraint 1:** Must not break v1 API\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** Independent audit confirmed root-level structural fix with zero shortcuts.\n"
  );
  const verifiedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(verifiedRes.stdout), {});

  // 7. Modify source file after verify.py passed without re-verifying -> block stop!
  fs.writeFileSync(path.join(tmpWs, "index.js"), "export const a = 2;\n");
  const dirtyRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: hookInput,
    encoding: "utf8",
  });
  const dirtyJson = JSON.parse(dirtyRes.stdout);
  assert.equal(dirtyJson.decision, "continue");
  assert.match(dirtyJson.reason, /Source files were modified after `verify\.py` last passed/);
});

test("pre_edit_guard.py blocks blind source edits until .agents/argonaut-state.md is initialized with user constraints and contrastive plan", (t) => {
  const tmpWs = makeTempDir("argonaut-pre-edit-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const stateFile = path.join(tmpWs, ".agents", "argonaut-state.md");
  const srcFile = path.join(tmpWs, "src", "feature.ts");
  const externalArtifact = path.join(os.tmpdir(), "brain-artifact-plan.md");

  const makeInput = (targetFile) =>
    JSON.stringify({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: targetFile },
      },
      workspacePaths: [tmpWs],
    });

  // 1. Always allow writing to .agents/argonaut-state.md or external artifacts
  const allowStateRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(stateFile),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowStateRes.stdout).decision, "allow");

  const allowArtifactRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(externalArtifact),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowArtifactRes.stdout).decision, "allow");

  // 2. Deny source file edit when .agents/argonaut-state.md does not exist
  const denyMissingRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  const denyMissingJson = JSON.parse(denyMissingRes.stdout);
  assert.equal(denyMissingJson.decision, "deny");
  assert.match(denyMissingJson.reason, /Law 0 & Law 1 Violation/);

  // 3. Deny source file edit when .agents/argonaut-state.md is stale (Status: COMPLETED from previous task)
  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.writeFileSync(
    stateFile,
    "# Argonaut Loop State\n- **Task:** Old\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Done\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** Existing module\n- **Forbidden Lazy Shortcut:** Shallow patch\n- **Required Root-Level Solution:** Full fix\n"
  );
  const denyStaleRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  const denyStaleJson = JSON.parse(denyStaleRes.stdout);
  assert.equal(denyStaleJson.decision, "deny");
  assert.match(denyStaleJson.reason, /still marked COMPLETED/);

  // 4. Deny source file edit if ## User Intent & Constraints section is missing
  fs.writeFileSync(
    stateFile,
    "# Argonaut Loop State\n- **Task:** New\n- **Iteration:** 0 / 10\n- **Status:** IMPLEMENTING\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** Existing module\n- **Forbidden Lazy Shortcut:** Shallow patch\n- **Required Root-Level Solution:** Full fix\n"
  );
  const denyNoIntentRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  const denyNoIntentJson = JSON.parse(denyNoIntentRes.stdout);
  assert.equal(denyNoIntentJson.decision, "deny");
  assert.match(denyNoIntentJson.reason, /User Intent & Constraints/);

  // 5. Deny source file edit if Contrastive Anti-Shortcut Planning (Reference Benchmark / Forbidden Lazy Shortcut / Required Root-Level Solution) is missing
  fs.writeFileSync(
    stateFile,
    "# Argonaut Loop State\n- **Task:** New\n- **Iteration:** 0 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] **Product Goal:** Honor user instruction\n\n## Root-Cause & Architecture Plan\n- Just a generic plan without contrastive anti-shortcut analysis\n"
  );
  const denyNoContrastiveRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  const denyNoContrastiveJson = JSON.parse(denyNoContrastiveRes.stdout);
  assert.equal(denyNoContrastiveJson.decision, "deny");
  assert.match(denyNoContrastiveJson.reason, /Forbidden Lazy Shortcut/);

  // 5b. Deny source file edit if Reference Benchmark / Prior Art is omitted from Contrastive Plan
  fs.writeFileSync(
    stateFile,
    "# Argonaut Loop State\n- **Task:** New\n- **Iteration:** 0 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] **Product Goal:** Honor user instruction\n\n## Root-Cause & Architecture Plan\n- **Forbidden Lazy Shortcut:** Tweaking surface parameters only.\n- **Required Root-Level Solution:** Refactoring the underlying state engine.\n"
  );
  const denyNoBenchmarkRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  const denyNoBenchmarkJson = JSON.parse(denyNoBenchmarkRes.stdout);
  assert.equal(denyNoBenchmarkJson.decision, "deny");
  assert.match(denyNoBenchmarkJson.reason, /Reference Benchmark \/ Prior Art/);

  // 6. Allow source file edit once .agents/argonaut-state.md is active and records User Intent & Constraints and all 3 Contrastive Plan fields
  fs.writeFileSync(
    stateFile,
    "# Argonaut Loop State\n- **Task:** New\n- **Iteration:** 0 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] **Product Goal:** Honor user instruction\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** src/core/engine.ts\n- **Forbidden Lazy Shortcut:** Tweaking surface parameters only.\n- **Required Root-Level Solution:** Refactoring the underlying state engine.\n"
  );
  const allowSrcRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: makeInput(srcFile),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowSrcRes.stdout).decision, "allow");
});

test("install.sh installs and uninstalls workspace cleanly", (t) => {
  const tmpWs = makeTempDir("argonaut-sh-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const installRes = spawnSync("bash", [INSTALL_SH], {
    cwd: tmpWs,
    encoding: "utf8",
  });
  assert.equal(installRes.status, 0, installRes.stderr);
  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "rules", "argonaut-discipline.md")));
  assert.ok(fs.existsSync(path.join(tmpWs, ".agents", "hooks.json")));

  const uninstallRes = spawnSync("bash", [INSTALL_SH, "--uninstall"], {
    cwd: tmpWs,
    encoding: "utf8",
  });
  assert.equal(uninstallRes.status, 0, uninstallRes.stderr);
  assert.ok(!fs.existsSync(path.join(tmpWs, ".agents", "skills", "argonaut")));
});

test("intent_anchor.py automatically recognizes intent from transcript.jsonl and enforces off-script safeguards", (t) => {
  const tmpWs = makeTempDir("argonaut-intent-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpWs, "src", "allowed.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(tmpWs, "src", "forbidden.js"), "export const y = 1;\n");
  fs.writeFileSync(path.join(tmpWs, "README.md"), "# Docs\n");

  const transcriptPath = path.join(tmpWs, "transcript.jsonl");

  // Case A: User asks a READ_ONLY question -> intent_anchor locks allowSourceEdits: false
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nhow does src/allowed.js work?\n</USER_REQUEST>",
    }) + "\n"
  );

  const readOnlyAnchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(readOnlyAnchorRes.status, 0, readOnlyAnchorRes.stderr);
  const lockPath = path.join(tmpWs, ".agents", ".argonaut-intent.lock.json");
  assert.ok(fs.existsSync(lockPath));
  const readOnlyLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(readOnlyLock.intentMode, "READ_ONLY");
  assert.equal(readOnlyLock.allowSourceEdits, false);

  // Even if state file exists, pre_edit_guard blocks editing source files during a READ_ONLY turn!
  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 0 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] Goal\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** src/allowed.js\n- **Forbidden Lazy Shortcut:** None\n- **Required Root-Level Solution:** Full fix\n"
  );
  const denyReadOnlyEdit = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(tmpWs, "src", "allowed.js") },
      },
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  const denyReadOnlyJson = JSON.parse(denyReadOnlyEdit.stdout);
  assert.equal(denyReadOnlyJson.decision, "deny");
  assert.match(denyReadOnlyJson.reason, /READ_ONLY/);

  // Case B: User gives a CODING prompt with explicit forbidden files, followed by "Ok, let's do this" confirmation
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 2,
        type: "USER_INPUT",
        content:
          "<USER_REQUEST>\nUpdate src/allowed.js to export x = 2. Do not touch src/forbidden.js or README.md.\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 3,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nOk, let's do this\n</USER_REQUEST>",
      }),
    ].join("\n") + "\n"
  );

  const codingAnchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(codingAnchorRes.status, 0, codingAnchorRes.stderr);
  const anchorOutput = JSON.parse(codingAnchorRes.stdout);
  assert.ok(Array.isArray(anchorOutput.injectSteps));
  assert.match(anchorOutput.injectSteps[0].ephemeralMessage, /ARGONAUT AUTO-INTENT SAFEGUARD/);

  const codingLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(codingLock.intentMode, "CODING");
  assert.equal(codingLock.allowSourceEdits, true);
  assert.ok(codingLock.forbiddenFiles.includes("src/forbidden.js"));
  assert.ok(codingLock.forbiddenFiles.includes("README.md"));

  // pre_edit_guard allows editing src/allowed.js
  const allowTargetRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(tmpWs, "src", "allowed.js") },
      },
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowTargetRes.stdout).decision, "allow");

  // pre_edit_guard hard-denies editing src/forbidden.js!
  const denyForbiddenRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      toolCall: {
        name: "replace_file_content",
        args: { TargetFile: path.join(tmpWs, "src", "forbidden.js") },
      },
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  const denyForbiddenJson = JSON.parse(denyForbiddenRes.stdout);
  assert.equal(denyForbiddenJson.decision, "deny");
  assert.match(denyForbiddenJson.reason, /FORBIDDEN/i);

  // If a forbidden file was modified via a shell command behind write_to_file's back, stop_guard catches it!
  fs.writeFileSync(path.join(tmpWs, "README.md"), "# Tampered via shell\n");
  const cleanEnv = { ...process.env };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Goal\n\n## Root-Cause & Architecture Plan\n- **Forbidden Lazy Shortcut:** None\n- **Required Root-Level Solution:** Full fix\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** Verified.\n"
  );
  const stopTamperedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  const stopTamperedJson = JSON.parse(stopTamperedRes.stdout);
  assert.equal(stopTamperedJson.decision, "continue");
  assert.match(stopTamperedJson.reason, /README\.md/);
});

test("global plugin hooks automatically yield when workspace .agents/hooks.json is installed", (t) => {
  const tmpHome = makeTempDir("argonaut-dedup-home-");
  const tmpWs = makeTempDir("argonaut-dedup-ws-");
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  const env = { ...process.env, HOME: tmpHome };
  // Install both globally and in workspace
  spawnSync(process.execPath, [CLI_PATH, "init", "--global"], { cwd: tmpHome, env });
  spawnSync(process.execPath, [CLI_PATH, "init"], { cwd: tmpWs, env });

  const globalIntentPy = path.join(
    tmpHome,
    ".gemini",
    "config",
    "plugins",
    "argonaut",
    "skills",
    "argonaut",
    "scripts",
    "intent_anchor.py"
  );
  const globalPreEditPy = path.join(
    tmpHome,
    ".gemini",
    "config",
    "plugins",
    "argonaut",
    "skills",
    "argonaut",
    "scripts",
    "pre_edit_guard.py"
  );
  const globalStopPy = path.join(
    tmpHome,
    ".gemini",
    "config",
    "plugins",
    "argonaut",
    "skills",
    "argonaut",
    "scripts",
    "stop_guard.py"
  );

  // Global intent_anchor yields {} when workspace .agents/hooks.json exists
  const globalIntentRes = spawnSync("python3", [globalIntentPy], {
    cwd: tmpWs,
    input: JSON.stringify({ workspacePaths: [tmpWs] }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(globalIntentRes.stdout), {});

  // Global pre_edit_guard yields {"decision": "allow"} (workspace hook handles enforcement)
  const globalPreEditRes = spawnSync("python3", [globalPreEditPy], {
    cwd: tmpWs,
    input: JSON.stringify({
      toolCall: { name: "write_to_file", args: { TargetFile: path.join(tmpWs, "src", "app.js") } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(globalPreEditRes.stdout), { decision: "allow" });

  // Global stop_guard yields {} (workspace hook handles enforcement)
  const globalStopRes = spawnSync("python3", [globalStopPy], {
    cwd: tmpWs,
    input: JSON.stringify({ terminationReason: "NO_TOOL_CALL", workspacePaths: [tmpWs] }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(globalStopRes.stdout), {});
});

test("stop_guard.py exempts read-only subagent transcripts and allows parent to yield while waiting for active subagent", (t) => {
  const tmpWs = makeTempDir("argonaut-subagent-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Audit test\n- **Iteration:** 1 / 10\n- **Status:** AUDITING\n"
  );

  // 1. Subagent transcript (no USER_INPUT entries, only SYSTEM_MESSAGE + PLANNER_RESPONSE) -> allow stop ({})
  const subTranscript = path.join(tmpWs, "subagent-transcript.jsonl");
  fs.writeFileSync(
    subTranscript,
    [
      JSON.stringify({
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=parent-conv content=Audit the diff",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        content: "Audit complete; PASS verdict sent to parent agent.",
      }),
    ].join("\n") + "\n"
  );

  const subStopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath: subTranscript,
      conversationId: "subagent-conv-1",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(subStopRes.stdout), {});

  // 2. Parent transcript that invoked a subagent (subagent-conv-1) and is waiting for its reply -> allow stop ({})
  const parentTranscript = path.join(tmpWs, "parent-transcript.jsonl");
  fs.writeFileSync(
    parentTranscript,
    [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nBuild the feature\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "invoke_subagent", arguments: { Role: "Adversarial Diff Critic" } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "subagent-conv-1"\n}',
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        content: "Waiting for the reviewer's verdict.",
      }),
    ].join("\n") + "\n"
  );

  const parentWaitingRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath: parentTranscript,
      conversationId: "parent-conv",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(parentWaitingRes.stdout), {});

  // 3. Once the subagent replies (`sender=subagent-conv-1`), parent can no longer stop while Status is AUDITING!
  fs.appendFileSync(
    parentTranscript,
    JSON.stringify({
      step_index: 4,
      type: "SYSTEM_MESSAGE",
      content: "[Message] timestamp=2026-10-24T00:00:00Z sender=subagent-conv-1 content=VERDICT: PASS",
    }) + "\n"
  );

  const parentAfterReplyRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath: parentTranscript,
      conversationId: "parent-conv",
    }),
    encoding: "utf8",
  });
  const parentAfterReplyJson = JSON.parse(parentAfterReplyRes.stdout);
  assert.equal(parentAfterReplyJson.decision, "continue");
  assert.match(parentAfterReplyJson.reason, /Argonaut Loop Active/);
});

test("parallel conversations in the same workspace do not block each other on .agents/argonaut-state.md", (t) => {
  const tmpWs = makeTempDir("argonaut-parallel-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");

  // Conversation A writes .agents/argonaut-state.md (pre_edit_guard records conv-A ownership)
  const convAPreEdit = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      conversationId: "conv-A",
      toolCall: { name: "write_file", args: { Path: statePath } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(convAPreEdit.stdout).decision, "allow");

  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Conv A Task\n- **Iteration:** 1 / 10\n- **Status:** IMPLEMENTING\n"
  );

  // Conversation A is blocked from stopping prematurely
  const convAStop = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      conversationId: "conv-A",
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(convAStop.stdout).decision, "continue");

  // Unrelated Conversation B in the same workspace is NOT blocked by Conversation A's in-progress state
  const convBStop = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      conversationId: "conv-B",
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(convBStop.stdout), {});
});

test("Git-accelerated workspace snapshotting keeps .argonaut-intent.lock.json compact while catching forbidden file edits", (t) => {
  const tmpWs = makeTempDir("argonaut-git-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  // Initialize a Git repo with 20 committed files
  spawnSync("git", ["init"], { cwd: tmpWs });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpWs });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: tmpWs });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmpWs });

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(tmpWs, "src", `module_${i}.js`), `export const v = ${i};\n`);
  }
  fs.writeFileSync(path.join(tmpWs, "README.md"), "# Original Docs\n");
  spawnSync("git", ["add", "."], { cwd: tmpWs });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: tmpWs });

  const transcriptPath = path.join(tmpWs, ".agents", "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nUpdate src/module_0.js. Do not touch README.md.\n</USER_REQUEST>",
    }) + "\n"
  );

  const anchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(anchorRes.status, 0, anchorRes.stderr);

  const lockPath = path.join(tmpWs, ".agents", ".argonaut-intent.lock.json");
  const lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.ok(lockData.forbiddenFiles.includes("README.md"));
  // In a clean Git repo, baselineFiles only needs __git_head__ (not all 20 clean committed files!)
  assert.ok("__git_head__" in lockData.baselineFiles);
  assert.ok(Object.keys(lockData.baselineFiles).length <= 3);

  // Modify forbidden committed file README.md -> stop_guard.py catches it via Git dirty status!
  fs.writeFileSync(path.join(tmpWs, "README.md"), "# Modified Forbidden Docs\n");
  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Test\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Goal\n\n## Root-Cause & Architecture Plan\n- **Forbidden Lazy Shortcut:** None\n- **Required Root-Level Solution:** Full fix\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** PASS\n"
  );

  const stopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  const stopJson = JSON.parse(stopRes.stdout);
  assert.equal(stopJson.decision, "continue");
  assert.match(stopJson.reason, /README\.md/);
});

test("stop_guard.py blocks self-certified Critic Verdict when source files were edited without calling invoke_subagent, and intent_anchor.py flags architectural rework prompts", (t) => {
  const tmpWs = makeTempDir("argonaut-loopholes-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpWs, "src", "layout.ts"), "export const ROAD = [0, 0];\n");

  const transcriptPath = path.join(tmpWs, ".agents", "transcript.jsonl");

  // 1. User gives an architectural rework / "wrong approach" prompt -> intent_anchor injects ARCHITECTURAL REDESIGN SAFEGUARD
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 1,
        type: "USER_INPUT",
        content:
          "<USER_REQUEST>\nNo, that was the wrong approach — completely rework the underlying road network and layout so it is unique.\n</USER_REQUEST>",
      }),
    ].join("\n") + "\n"
  );

  const reworkAnchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(reworkAnchorRes.status, 0, reworkAnchorRes.stderr);
  const reworkAnchorJson = JSON.parse(reworkAnchorRes.stdout);
  assert.match(
    reworkAnchorJson.injectSteps[0].ephemeralMessage,
    /ARCHITECTURAL REDESIGN SAFEGUARD/
  );

  // 2. Agent edits src/layout.ts, runs verify.py, and writes a self-certified "- [x] **Critic Verdict:** PASS" WITHOUT calling invoke_subagent
  fs.appendFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 2,
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "edit_file",
          arguments: { Path: path.join(tmpWs, "src", "layout.ts") },
        },
      ],
    }) + "\n"
  );
  fs.writeFileSync(path.join(tmpWs, "src", "layout.ts"), "export const PLAZA = [10, 20];\n");
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });

  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Rework layout\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Rework layout\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** apps/candil/layout.ts\n- **Forbidden Lazy Shortcut:** Shifting coordinates\n- **Required Root-Level Solution:** New topology\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** PASS (self-certified without subagent)\n"
  );

  const selfCertifiedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-conv-rework",
    }),
    encoding: "utf8",
  });
  const selfCertifiedJson = JSON.parse(selfCertifiedRes.stdout);
  assert.equal(selfCertifiedJson.decision, "continue");
  assert.match(selfCertifiedJson.reason, /Self-certified `Critic Verdict` detected/i);

  // 3. Once the agent calls invoke_subagent and receives the subagent's reply, Status: COMPLETED is allowed!
  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "invoke_subagent",
            arguments: { TypeName: "research", Role: "Adversarial Diff Critic" },
          },
        ],
      }),
      JSON.stringify({
        step_index: 4,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-sub-1"\n}',
      }),
      JSON.stringify({
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-sub-1 content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );

  const auditedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-conv-rework",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(auditedRes.stdout), {});

  // 4. Loophole F: Agent edits src/layout.ts again in a subsequent iteration and tries to reuse the old subagent via send_message instead of spawning a fresh invoke_subagent -> stop_guard.py blocks!
  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "edit_file",
            arguments: { Path: path.join(tmpWs, "src", "layout.ts") },
          },
        ],
      }),
      JSON.stringify({
        step_index: 7,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "send_message",
            arguments: { Recipient: "critic-sub-1", Message: "Please re-verify my latest edit" },
          },
        ],
      }),
      JSON.stringify({
        step_index: 8,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-sub-1 content=VERDICT: APPROVED",
      }),
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(tmpWs, "src", "layout.ts"), "export const BOULEVARD = [30, 40];\n");
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });

  const reusedSubagentRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-conv-rework",
    }),
    encoding: "utf8",
  });
  const reusedSubagentJson = JSON.parse(reusedSubagentRes.stdout);
  assert.equal(reusedSubagentJson.decision, "continue");
  assert.match(reusedSubagentJson.reason, /fresh `invoke_subagent`/i);

  // 5. Once a fresh invoke_subagent (critic-sub-2) is spawned after the final source edit and replies, Status: COMPLETED is allowed!
  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 9,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "invoke_subagent",
            arguments: { TypeName: "research", Role: "Adversarial Diff Critic" },
          },
        ],
      }),
      JSON.stringify({
        step_index: 10,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-sub-2"\n}',
      }),
      JSON.stringify({
        step_index: 11,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-sub-2 content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );

  const freshAuditedRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-conv-rework",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(freshAuditedRes.stdout), {});
});

test("anti-busywork, anti-spec-laundering, and Critic benchmark-inspection safeguards block Borgo Vespero loopholes", (t) => {
  const tmpWs = makeTempDir("argonaut-borgo-");
  const tmpBrain = makeTempDir("argonaut-brain-");
  t.after(() => {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  });

  const cleanEnv = { ...process.env, ARGONAUT_BRAIN_ROOT: tmpBrain };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, "src"), { recursive: true });
  fs.mkdirSync(
    path.join(tmpWs, "apps", "abendheim", "src", "world", "districts", "residential"),
    { recursive: true }
  );
  fs.writeFileSync(path.join(tmpWs, "src", "layout.ts"), "export const ROAD = [0, 0];\n");
  fs.writeFileSync(
    path.join(tmpWs, "apps", "abendheim", "src", "world", "districts", "residential", "plan.ts"),
    "export const ABENDHEIM_MAIN = [0, 100];\n"
  );

  const transcriptPath = path.join(tmpWs, ".agents", "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nCompletely rework the residential district layout.\n</USER_REQUEST>",
    }) + "\n"
  );

  // 1. Fix 1: Before .agents/argonaut-state.md is active, intent_anchor prompts one-time initialization
  const preStateAnchor = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.match(
    JSON.parse(preStateAnchor.stdout).injectSteps[0].ephemeralMessage,
    /once before your first code edit/
  );

  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Rework layout\n- **Iteration:** 1 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] Rework layout\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** apps/abendheim/src/world/districts/residential/plan.ts\n- **Forbidden Lazy Shortcut:** Shifting Abendheim coordinates\n- **Required Root-Level Solution:** New radial layout\n"
  );

  // Once .agents/argonaut-state.md is active (IMPLEMENTING), intent_anchor switches to anti-churn & anti-spec-laundering message
  const activeStateAnchor = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      invocationNum: 2,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.match(
    JSON.parse(activeStateAnchor.stdout).injectSteps[0].ephemeralMessage,
    /already initialized and active — do NOT repeatedly touch or re-edit/
  );

  // 2. Fix 2: pre_edit_guard.py blocks mid-implementation Spec-Laundering of an existing /brain/.../*plan*.md artifact
  const convBrainDir = path.join(tmpBrain, "brain", "conv-borgo");
  fs.mkdirSync(convBrainDir, { recursive: true });
  const planArtifactPath = path.join(convBrainDir, "borgo_vespero_completion_plan.md");
  const walkthroughArtifactPath = path.join(convBrainDir, "walkthrough.md");
  fs.writeFileSync(planArtifactPath, "# Approved Completion Plan\n");
  fs.writeFileSync(walkthroughArtifactPath, "# Walkthrough\n");

  const launderPlanRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: planArtifactPath } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  const launderPlanJson = JSON.parse(launderPlanRes.stdout);
  assert.equal(launderPlanJson.decision, "deny");
  assert.match(launderPlanJson.reason, /Anti-Spec-Laundering Violation/);

  // Editing non-plan artifacts (e.g. walkthrough.md) remains allowed
  const walkthroughEditRes = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: walkthroughArtifactPath } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(walkthroughEditRes.stdout).decision, "allow");

  // 3. Fix 3: stop_guard.py blocks Status: COMPLETED if the Critic subagent skipped reading declared Reference Benchmark / Prior Art files
  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "edit_file", arguments: { Path: path.join(tmpWs, "src", "layout.ts") } }],
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "invoke_subagent", arguments: { TypeName: "research", Role: "Critic" } }],
      }),
      JSON.stringify({
        step_index: 4,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-blind"\n}',
      }),
      JSON.stringify({
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-blind content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(tmpWs, "src", "layout.ts"), "export const RADIAL = [15, 25];\n");
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });

  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Rework layout\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Rework layout\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** apps/abendheim/src/world/districts/residential/plan.ts\n- **Forbidden Lazy Shortcut:** Shifting Abendheim coordinates\n- **Required Root-Level Solution:** New radial layout\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** PASS\n"
  );

  // Create critic-blind's transcript: even though the SYSTEM_MESSAGE mentions the benchmark path, its tool_calls only read argonaut-state.md and src/layout.ts!
  const blindLogsDir = path.join(tmpBrain, "critic-blind", ".system_generated", "logs");
  fs.mkdirSync(blindLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(blindLogsDir, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        content:
          "Audit src/layout.ts against Reference Benchmark / Prior Art: apps/abendheim/src/world/districts/residential/plan.ts",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "view_file", args: { AbsolutePath: path.join(tmpWs, ".agents", "argonaut-state.md") } },
          { name: "view_file", args: { AbsolutePath: path.join(tmpWs, "src", "layout.ts") } },
        ],
      }),
    ].join("\n") + "\n"
  );

  const blindCriticStopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-borgo",
    }),
    encoding: "utf8",
  });
  const blindCriticStopJson = JSON.parse(blindCriticStopRes.stdout);
  assert.equal(blindCriticStopJson.decision, "continue");
  assert.match(
    blindCriticStopJson.reason,
    /did not inspect declared workspace `Reference Benchmark \/ Prior Art`/
  );
  assert.match(
    blindCriticStopJson.reason,
    /apps\/abendheim\/src\/world\/districts\/residential\/plan\.ts/
  );

  // Once a fresh Critic subagent (critic-thorough) actually reads both .agents/argonaut-state.md and apps/abendheim/src/world/districts/residential/plan.ts, Status: COMPLETED is allowed!
  const thoroughLogsDir = path.join(tmpBrain, "critic-thorough", ".system_generated", "logs");
  fs.mkdirSync(thoroughLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(thoroughLogsDir, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        content: "Audit src/layout.ts",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "view_file", args: { AbsolutePath: path.join(tmpWs, ".agents", "argonaut-state.md") } },
          { name: "view_file", args: { AbsolutePath: path.join(tmpWs, "src", "layout.ts") } },
          {
            name: "view_file",
            args: {
              AbsolutePath: path.join(
                tmpWs,
                "apps",
                "abendheim",
                "src",
                "world",
                "districts",
                "residential",
                "plan.ts"
              ),
            },
          },
        ],
      }),
    ].join("\n") + "\n"
  );

  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "invoke_subagent", arguments: { TypeName: "research", Role: "Critic" } }],
      }),
      JSON.stringify({
        step_index: 7,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-thorough"\n}',
      }),
      JSON.stringify({
        step_index: 8,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-thorough content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );

  const thoroughCriticStopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "parent-borgo",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(thoroughCriticStopRes.stdout), {});
});

test("auto-steering core drivers: automatic spec-doc freeze, root-anchor-first ordering, and normalized-skeleton clone detection", (t) => {
  const tmpWs = makeTempDir("argonaut-autosteer-");
  t.after(() => fs.rmSync(tmpWs, { recursive: true, force: true }));

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARGONAUT_VERIFY_ACTIVE;

  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(tmpWs, "docs"), { recursive: true });
  fs.mkdirSync(
    path.join(tmpWs, "apps", "abendheim", "src", "world", "districts", "residential"),
    { recursive: true }
  );
  fs.mkdirSync(
    path.join(tmpWs, "apps", "abendheim", "src", "world", "town"),
    { recursive: true }
  );
  fs.mkdirSync(
    path.join(tmpWs, "apps", "borgo-vespero", "src", "world", "districts", "residential"),
    { recursive: true }
  );

  const specPath = path.join(tmpWs, "docs", "BORGO-VESPERO.md");
  fs.writeFileSync(specPath, "# Borgo Vespero Spec\nRadial fan layout required.\n");

  const abendheimTownPlan = path.join(tmpWs, "apps", "abendheim", "src", "world", "town", "plan.ts");
  fs.writeFileSync(abendheimTownPlan, "export const TOWN = 1;\n");

  const abendheimResPlan = path.join(
    tmpWs,
    "apps",
    "abendheim",
    "src",
    "world",
    "districts",
    "residential",
    "plan.ts"
  );
  const templatePlanLines = [
    "export const MAIN_ROAD = { x0: -28, z0: -120, x1: 28, z1: 120 };",
    "export const NORTH_ROAD = { x0: -80, z0: 40, x1: 80, z1: 52 };",
    "export const SOUTH_ROAD = { x0: -80, z0: -52, x1: 80, z1: -40 };",
    "export const MARKTPLATZ = { x0: -28, z0: -24, x1: 28, z1: 24 };",
    "export const NORDZEILE_A = { x0: -76, z0: 54, x1: -12, z1: 88 };",
    "export const NORDZEILE_B = { x0: 12, z0: 54, x1: 76, z1: 88 };",
    "export const SUEDZEILE_A = { x0: -76, z0: -88, x1: -12, z1: -54 };",
    "export const SUEDZEILE_B = { x0: 12, z0: -88, x1: 76, z1: -54 };",
    "export const WESTHOF_A = { x0: -76, z0: -38, x1: -30, z1: -4 };",
    "export const WESTHOF_B = { x0: -76, z0: 4, x1: -30, z1: 38 };",
    "export const OSTHOF_A = { x0: 30, z0: -38, x1: 76, z1: -4 };",
    "export const OSTHOF_B = { x0: 30, z0: 4, x1: 76, z1: 38 };",
    "export const BRUNNEN = { x: 0, z: 0, r: 4.5 };",
    "export const LATERNE_N = { x: -10, z: 20, h: 3.2 };",
    "export const LATERNE_S = { x: 10, z: -20, h: 3.2 };",
    "export const BAUM_NW = { x: -20, z: 18, r: 2.5 };",
    "export const BAUM_NE = { x: 20, z: 18, r: 2.5 };",
    "export const BAUM_SW = { x: -20, z: -18, r: 2.5 };",
    "export const BAUM_SE = { x: 20, z: -18, r: 2.5 };",
  ].join("\n") + "\n";
  fs.writeFileSync(abendheimResPlan, templatePlanLines);

  const bvResPlan = path.join(
    tmpWs,
    "apps",
    "borgo-vespero",
    "src",
    "world",
    "districts",
    "residential",
    "plan.ts"
  );
  const bvResDress = path.join(
    tmpWs,
    "apps",
    "borgo-vespero",
    "src",
    "world",
    "districts",
    "residential",
    "dress.ts"
  );
  fs.writeFileSync(bvResPlan, templatePlanLines);
  fs.writeFileSync(bvResDress, "export const DRESS = [];\n");

  const transcriptPath = path.join(tmpWs, ".agents", "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      type: "USER_INPUT",
      content:
        "<USER_REQUEST>\nCompletely rework Borgo Vespero's residential district so its layout is unique and not a clone of Abendheim.\n</USER_REQUEST>",
    }) + "\n"
  );

  // 1. Driver 1: intent_anchor.py automatically freezes docs/BORGO-VESPERO.md in lockedSpecFiles without user having to say "Do not touch docs/BORGO-VESPERO.md"
  const anchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      invocationNum: 1,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  assert.equal(anchorRes.status, 0, anchorRes.stderr);
  const lockData = JSON.parse(
    fs.readFileSync(path.join(tmpWs, ".agents", ".argonaut-intent.lock.json"), "utf8")
  );
  assert.ok(lockData.lockedSpecFiles.includes("docs/BORGO-VESPERO.md"));

  const statePath = path.join(tmpWs, ".agents", "argonaut-state.md");
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Completely rework residential layout\n- **Iteration:** 1 / 10\n- **Status:** IMPLEMENTING\n\n## User Intent & Constraints (Must Honor 100%)\n- [ ] Rework residential layout\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** apps/abendheim/src/world/town/plan.ts\n- **Forbidden Lazy Shortcut:** Shifting Abendheim coordinates and renaming identifiers\n- **Required Root-Level Solution:** Radial fan layout\n"
  );

  // pre_edit_guard.py blocks editing docs/BORGO-VESPERO.md (Anti-Spec-Laundering Safeguard)
  const denySpecEdit = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: specPath } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  const denySpecJson = JSON.parse(denySpecEdit.stdout);
  assert.equal(denySpecJson.decision, "deny");
  assert.match(denySpecJson.reason, /Anti-Spec-Laundering Safeguard/);

  // 2. Driver 2: pre_edit_guard.py blocks editing downstream dress.ts BEFORE root anchor plan.ts is modified!
  const denyDownstreamFirst = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: bvResDress } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  const denyDownstreamJson = JSON.parse(denyDownstreamFirst.stdout);
  assert.equal(denyDownstreamJson.decision, "deny");
  assert.match(denyDownstreamJson.reason, /Root-Anchor-First Violation/);
  assert.match(
    denyDownstreamJson.reason,
    /apps\/borgo-vespero\/src\/world\/districts\/residential\/plan\.ts/
  );

  // Editing root anchor plan.ts first IS allowed
  const allowAnchorFirst = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: bvResPlan } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowAnchorFirst.stdout).decision, "allow");

  // 3. Driver 3: Agent performs a lazy parametric/identifier-rename mutation on bvResPlan (renaming German -> Italian and shifting numbers by 4m)
  const lazyRenamedClone = templatePlanLines
    .replace("MAIN_ROAD", "VIA_PRINCIPALE")
    .replace("NORTH_ROAD", "VIA_SETTENTRIONALE")
    .replace("SOUTH_ROAD", "VIA_MERIDIONALE")
    .replace("MARKTPLATZ", "PIAZZA_DEL_POZZO")
    .replace("NORDZEILE", "CORTINA_NORD")
    .replace("SUEDZEILE", "CORTINA_SUD")
    .replace(/-28/g, "-32")
    .replace(/28/g, "32")
    .replace(/40/g, "44");
  fs.writeFileSync(bvResPlan, lazyRenamedClone);

  // Now that plan.ts is modified, editing downstream dress.ts is allowed!
  const allowDownstreamAfter = spawnSync("python3", [PRE_EDIT_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      toolCall: { name: "edit_file", args: { Path: bvResDress } },
      workspacePaths: [tmpWs],
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(allowDownstreamAfter.stdout).decision, "allow");

  // Record edit + Critic pass in transcript, run verify.py, and try to mark COMPLETED
  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "edit_file", arguments: { Path: bvResPlan } }],
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "invoke_subagent", arguments: { TypeName: "research", Role: "Critic" } }],
      }),
      JSON.stringify({
        step_index: 4,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-1"\n}',
      }),
      JSON.stringify({
        step_index: 5,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-1 content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });
  fs.writeFileSync(
    statePath,
    "# Argonaut Loop State\n- **Task:** Completely rework residential layout\n- **Iteration:** 1 / 10\n- **Status:** COMPLETED\n\n## User Intent & Constraints (Must Honor 100%)\n- [x] Rework residential layout\n\n## Root-Cause & Architecture Plan\n- **Reference Benchmark / Prior Art:** apps/abendheim/src/world/town/plan.ts\n- **Forbidden Lazy Shortcut:** Shifting Abendheim coordinates and renaming identifiers\n- **Required Root-Level Solution:** Radial fan layout\n\n## Adversarial Diff Audit\n- [x] **Critic Verdict:** PASS\n"
  );

  // Even though Reference Benchmark only listed apps/abendheim/src/world/town/plan.ts AND Critic said PASS, stop_guard.py's cross-app counterpart mapping + normalized-skeleton clone detector catches that residential/plan.ts is a >90% structural clone of apps/abendheim/src/world/districts/residential/plan.ts!
  const cloneStopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "conv-autosteer",
    }),
    encoding: "utf8",
  });
  const cloneStopJson = JSON.parse(cloneStopRes.stdout);
  assert.equal(cloneStopJson.decision, "continue");
  assert.match(cloneStopJson.reason, /Structural Clone Violation/);
  assert.match(cloneStopJson.reason, /structural skeleton match/);

  // 4. Once bvResPlan is rewritten with a genuinely new structural topology (<78% similarity), verify.py runs, and a fresh Critic audits, stop_guard.py allows completion!
  const genuineRadialPlan = [
    "export interface RadialSpoke { angleRad: number; innerR: number; outerR: number; width: number }",
    "export const PIAZZA_CENTER = { cx: 0, cz: 0, radius: 18 };",
    "export const RADIAL_SPOKES: RadialSpoke[] = [",
    "  { angleRad: 0.0, innerR: 18, outerR: 95, width: 7 },",
    "  { angleRad: 1.047, innerR: 18, outerR: 95, width: 6 },",
    "  { angleRad: 2.094, innerR: 18, outerR: 95, width: 6 },",
    "  { angleRad: 3.141, innerR: 18, outerR: 95, width: 7 },",
    "  { angleRad: 4.188, innerR: 18, outerR: 95, width: 6 },",
    "  { angleRad: 5.235, innerR: 18, outerR: 95, width: 6 },",
    "];",
    "export function computeSectorWedge(spokeIdx: number, ringIdx: number) {",
    "  const spoke = RADIAL_SPOKES[spokeIdx % RADIAL_SPOKES.length];",
    "  const r0 = spoke.innerR + ringIdx * 22;",
    "  const r1 = r0 + 18;",
    "  return { angle: spoke.angleRad, r0, r1, arcWidth: spoke.width };",
    "}",
    "export const RING_PROMENADES = [40, 64, 88].map((r, idx) => ({ ringIndex: idx, radius: r }));",
  ].join("\n") + "\n";
  fs.writeFileSync(bvResPlan, genuineRadialPlan);

  fs.appendFileSync(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "edit_file", arguments: { Path: bvResPlan } }],
      }),
      JSON.stringify({
        step_index: 7,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "invoke_subagent", arguments: { TypeName: "research", Role: "Critic" } }],
      }),
      JSON.stringify({
        step_index: 8,
        type: "GENERIC",
        content: 'Created the following subagent:\n{\n  "conversationId": "critic-2"\n}',
      }),
      JSON.stringify({
        step_index: 9,
        type: "SYSTEM_MESSAGE",
        content: "[Message] sender=critic-2 content=VERDICT: PASS",
      }),
    ].join("\n") + "\n"
  );
  spawnSync("python3", [VERIFY_PY], { cwd: tmpWs, env: cleanEnv });

  const genuineStopRes = spawnSync("python3", [STOP_GUARD_PY], {
    cwd: tmpWs,
    env: cleanEnv,
    input: JSON.stringify({
      terminationReason: "NO_TOOL_CALL",
      workspacePaths: [tmpWs],
      transcriptPath,
      conversationId: "conv-autosteer",
    }),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(genuineStopRes.stdout), {});
});

test("context-window token budget, shared _common.py deduplication, and single-rule global installation", (t) => {
  const tmpHome = makeTempDir("argonaut-size-home-");
  const tmpWs = makeTempDir("argonaut-size-ws-");
  t.after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  // 1. Verify context-bearing markdown files stay within strict token/byte budgets
  const ruleBytes = fs.statSync(path.join(REPO_ROOT, "payload", "rules", "argonaut-discipline.md")).size;
  const skillBytes = fs.statSync(path.join(REPO_ROOT, "payload", "skills", "argonaut", "SKILL.md")).size;
  assert.ok(ruleBytes <= 4200, `Expected argonaut-discipline.md <= 4200 bytes, got ${ruleBytes}`);
  assert.ok(skillBytes <= 7500, `Expected SKILL.md <= 7500 bytes, got ${skillBytes}`);

  // 2. Verify shared _common.py keeps total Python hook script size compact (< 75 KB, down from 98.4 KB)
  const scriptsDir = path.join(REPO_ROOT, "payload", "skills", "argonaut", "scripts");
  assert.ok(fs.existsSync(path.join(scriptsDir, "_common.py")));
  const pyFiles = ["_common.py", "intent_anchor.py", "pre_edit_guard.py", "stop_guard.py", "verify.py"];
  const totalPyBytes = pyFiles.reduce((sum, f) => sum + fs.statSync(path.join(scriptsDir, f)).size, 0);
  assert.ok(totalPyBytes < 75000, `Expected total Python scripts < 75000 bytes, got ${totalPyBytes}`);

  // 3. Verify --global install removes stale plugins/argonaut/rules/AGENTS.md so rule is only injected once via GEMINI.md
  const stalePluginRule = path.join(
    tmpHome,
    ".gemini",
    "config",
    "plugins",
    "argonaut",
    "rules",
    "AGENTS.md"
  );
  fs.mkdirSync(path.dirname(stalePluginRule), { recursive: true });
  fs.writeFileSync(stalePluginRule, "# Duplicate Rule\n");

  const env = { ...process.env, HOME: tmpHome };
  const globalInit = spawnSync(process.execPath, [CLI_PATH, "init", "--global"], {
    cwd: tmpHome,
    env,
    encoding: "utf8",
  });
  assert.equal(globalInit.status, 0, globalInit.stderr);
  assert.ok(fs.existsSync(path.join(tmpHome, ".gemini", "GEMINI.md")));
  assert.ok(!fs.existsSync(stalePluginRule));
  assert.ok(
    fs.existsSync(
      path.join(tmpHome, ".gemini", "config", "skills", "argonaut", "scripts", "_common.py")
    )
  );

  // 4. Verify active-state ephemeralMessage compacts long prompts (>900 chars -> <=350 char prompt excerpt)
  fs.mkdirSync(path.join(tmpWs, ".agents"), { recursive: true });
  const longPrompt = "Implement feature X with detailed specification. ".repeat(25);
  const transcriptPath = path.join(tmpWs, ".agents", "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      step_index: 1,
      type: "USER_INPUT",
      content: `<USER_REQUEST>\n${longPrompt}\n</USER_REQUEST>`,
    }) + "\n"
  );
  fs.writeFileSync(
    path.join(tmpWs, ".agents", "argonaut-state.md"),
    "# Argonaut Loop State\n- **Task:** Feature X\n- **Iteration:** 1 / 10\n- **Status:** IMPLEMENTING\n"
  );

  const anchorRes = spawnSync("python3", [INTENT_ANCHOR_PY], {
    cwd: tmpWs,
    input: JSON.stringify({
      invocationNum: 2,
      workspacePaths: [tmpWs],
      transcriptPath,
    }),
    encoding: "utf8",
  });
  const msg = JSON.parse(anchorRes.stdout).injectSteps[0].ephemeralMessage;
  assert.ok(msg.length < 800, `Expected compact active ephemeralMessage < 800 chars, got ${msg.length}`);
});






