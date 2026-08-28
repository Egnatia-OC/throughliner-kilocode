/**
 * Throughliner Kilo Code shim test harness (node --test).
 *
 * Drives the esbuild bundle (.test/plugin.mjs) directly with a mock
 * PluginInput (client + directory) and a temp-project fixture tree. The
 * vendored Python hooks are the real ones — this suite asserts the SHIM's
 * translation contract: event -> Claude-protocol JSON -> decision.
 *
 * Event shapes are the REAL bus shapes (kilo 7.4.23 binary-verified; Kilo is
 * an OpenCode fork with identical dispatch):
 *   server dispatch: hook["event"]({ event: { id, type, properties: <bus data> } })
 *   session.created / session.idle:  properties { sessionID, ... }
 *   tool.execute.after:              input { tool, sessionID, callID, args },
 *                                    output = tool result { title, output: string, metadata }
 *
 * Kilo-specific: there is NO permission.create on the client — the subagent
 * cost gate is the native "task": "ask" permission in kilo.jsonc, and the
 * shim's Python "ask" decision degrades to allow+log.
 *
 * Build first:
 *   npx esbuild kilo/plugin.ts --bundle --format=esm --platform=node --outfile=.test/plugin.mjs
 * Run:
 *   node --test test/harness.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const BUNDLE = path.join(REPO, ".test", "plugin.mjs");
const VENDOR = path.join(REPO, "vendor", "throughliner");
assert.ok(existsSync(BUNDLE), "bundle missing — run the esbuild command in the header first");

// Hermetic home: skill materialization must not touch the developer's real
// ~/.config. Set before the bundle import (SKILLS_DIR and VENDOR_ROOT are
// module-level).
const HOME = mkdtempSync(path.join(os.tmpdir(), "tl-home-"));
process.env.HOME = HOME;
process.env.THROUGHLINER_ROOT = VENDOR;
process.env.THROUGHLINER_PYTHON = "python3";

const pluginMod = await import(BUNDLE);
const throughliner = pluginMod.default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = { timeout: 30_000 }; // per-test watchdog: a hang must fail, not stall

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProject({ adopted = true, buildFiles = null, queue = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-proj-"));
  if (queue) {
    writeFileSync(
      path.join(dir, "QUEUE.md"),
      "# Queue\n\n## Unprocessed\n\n#### fix the login bug [fix-login-bug]\nwhy: users cannot log in\n",
    );
  }
  if (adopted) {
    writeFileSync(path.join(dir, "SPEC.md"), "# Spec\n\nstub project spec\n");
  }
  if (buildFiles !== null) {
    const bullets = buildFiles.map((f) => `- ${f}`).join("\n");
    writeFileSync(path.join(dir, `_build-test-sid.md`), `# Build: test-sid\n\nFiles:\n${bullets}\n`);
  }
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.py"), "print('hi')\n");
  return dir;
}

function makeClient(state) {
  return {
    session: {
      messages: async ({ sessionID }) => ({ data: state.messages[sessionID] ?? [] }),
      prompt: async (args) => {
        state.prompts.push(args);
      },
    },
  };
}

async function makePlugin(dir, state) {
  state ??= { messages: {}, prompts: [], permissions: [] };
  const input = { client: makeClient(state), directory: dir };
  return { hooks: await throughliner(input), state };
}

async function waitForPermission(state, ms = 5_000) {
  const t0 = Date.now();
  while (state.permissions.length === 0 && Date.now() - t0 < ms) await sleep(50);
}

async function waitForPrompts(state, n, ms = 10_000) {
  const t0 = Date.now();
  while (state.prompts.length < n && Date.now() - t0 < ms) await sleep(100);
}

function busEvent(type, properties) {
  return { event: { id: `evt-${type}`, type, properties } };
}

// ---------------------------------------------------------------------------
// 1. Session-start + brevity injection (system.transform)
// ---------------------------------------------------------------------------

test("system.transform injects brevity (always) and session orientation (once stashed)", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  const output = { system: ["base system prompt"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "test-sid" }, output);
  const joined = output.system.join("\n");
  assert.ok(joined.includes("base system prompt"), "base system preserved");
  assert.match(joined, /Throughliner output style/, "brevity section present");
  assert.match(joined, /session orientation/i, "session orientation present");
  // The model cannot know the harness session id natively, so the shim says
  // it — the vendored hooks name per-session files from it.
  assert.match(joined, /Session ID for this session: test-sid/, "session id stated");
  assert.match(joined, /_build-test-sid\.md/, "build file name spelled out");
  // A second transform call gets a FRESH array (the host rebuilds system per
  // LLM call) — appending per call is idempotent, never cumulative.
  const again = { system: ["base system prompt"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "test-sid" }, again);
  assert.equal(again.system.filter((s) => /session orientation/i.test(s)).length, 1, "orientation not cumulative");
});

// ---------------------------------------------------------------------------
// 2-4. Scope-lock (build working file Files: list)
// ---------------------------------------------------------------------------

test("scope-lock: write to a file OUTSIDE the build's Files: list is denied", T, async () => {
  const dir = makeProject({ buildFiles: ["src/app.py"] });
  const { hooks } = await makePlugin(dir);
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "write", sessionID: "test-sid", callID: "c1" },
      { args: { filePath: path.join(dir, "rogue.py"), content: "x" } },
    ),
    /file list|not in/i,
  );
});

test("scope-lock: write to a LISTED file is allowed", T, async () => {
  const dir = makeProject({ buildFiles: ["src/app.py"] });
  const { hooks } = await makePlugin(dir);
  await hooks["tool.execute.before"](
    { tool: "write", sessionID: "test-sid", callID: "c2" },
    { args: { filePath: path.join(dir, "src", "app.py"), content: "print('v2')" } },
  );
});

test("scope-lock: the session's own build working file is always editable", T, async () => {
  const dir = makeProject({ buildFiles: [] });
  const { hooks } = await makePlugin(dir);
  await hooks["tool.execute.before"](
    { tool: "write", sessionID: "test-sid", callID: "c3" },
    { args: { filePath: path.join(dir, "_build-test-sid.md"), content: "tick" } },
  );
});

// ---------------------------------------------------------------------------
// 5. Git guard
// ---------------------------------------------------------------------------

test("git guard: `git push --force` bash is denied", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "test-sid", callID: "c4" },
      { args: { command: "git push --force origin main" } },
    ),
    /force/i,
  );
});

test("git guard: plain `git status` bash is allowed", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "test-sid", callID: "c5" },
    { args: { command: "git status" } },
  );
});

// ---------------------------------------------------------------------------
// 6. Subagent ask-gate (Task tool) -> native kilo gate
// ---------------------------------------------------------------------------

test("ask-gate: a Python ask on the task tool degrades to allow (native kilo gate)", T, async () => {
  const dir = makeProject();
  const { hooks, state } = await makePlugin(dir);
  // No prompt is created — the shim cannot create one on Kilo (no
  // permission.create); the native "task": "ask" permission in kilo.jsonc is
  // the gate. The tool call itself must pass.
  await hooks["tool.execute.before"](
    { tool: "task", sessionID: "test-sid", callID: "tg" },
    { args: { description: "audit", prompt: "audit the queue", subagent_type: "general" } },
  );
  assert.equal(state.permissions.length, 0, "no shim-side prompt created");
});

// ---------------------------------------------------------------------------
// 9. Post-tool: advisory context appended to tool output
// ---------------------------------------------------------------------------

test("post-tool: QUEUE.md lint finding is appended to the tool output", T, async () => {
  const dir = makeProject();
  // An entry heading without a trailing [slug] — a deterministic lint hit.
  writeFileSync(
    path.join(dir, "QUEUE.md"),
    "# Queue\n\n## Unprocessed\n\n#### Fix the login bug\nwhy: users cannot log in\n",
  );
  const { hooks } = await makePlugin(dir);
  // Real tool.execute.after shape: input carries args, output is the tool result.
  const input = { tool: "write", sessionID: "test-sid", callID: "c9", args: { filePath: path.join(dir, "QUEUE.md"), content: "see fixture" } };
  const output = { title: "Wrote", output: "wrote QUEUE.md", metadata: {} };
  await hooks["tool.execute.after"](input, output);
  assert.match(output.output, /QUEUE\.md structure lint/, "lint advisory appended");
  assert.match(output.output, /no \[slug\]/, "the slug finding is named");
});

test("post-tool: non-mapped tools are untouched", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  const output = { title: "Glob", output: "glob results", metadata: {} };
  await hooks["tool.execute.after"]({ tool: "glob", sessionID: "test-sid", callID: "c10", args: { pattern: "**/*.py" } }, output);
  assert.equal(output.output, "glob results");
});

// ---------------------------------------------------------------------------
// 10-12. Stop: block-once on a claimed-but-unfiled slug, loop protection,
//        and the no-block case
// ---------------------------------------------------------------------------

function idleState(text) {
  return {
    messages: {
      "test-sid": [
        { info: { role: "user" }, parts: [{ type: "text", text: "/next" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text }] },
      ],
    },
    prompts: [],
    permissions: [],
  };
}

test("stop: a claimed slug missing from QUEUE.md re-prompts the session", T, async () => {
  const dir = makeProject();
  const { hooks, state } = await makePlugin(dir, idleState("Done. I filed [ghost-slug] to the queue."));
  await hooks.event(busEvent("session.idle", { sessionID: "test-sid" }));
  await waitForPrompts(state, 1);
  assert.equal(state.prompts.length, 1, "a continuation prompt was sent");
  const sent = state.prompts[0].parts?.[0]?.text ?? "";
  assert.match(sent, /ghost-slug/, "the missing slug is named in the feedback");
});

test("stop: a second idle on the same claim does NOT re-prompt (loop protection)", T, async () => {
  const dir = makeProject();
  const { hooks, state } = await makePlugin(dir, idleState("Done. I filed [ghost-slug] to the queue."));
  await hooks.event(busEvent("session.idle", { sessionID: "test-sid" }));
  await waitForPrompts(state, 1);
  assert.equal(state.prompts.length, 1, "first idle blocked");
  const markerDir = path.join(dir, ".throughliner");
  assert.ok(
    existsSync(markerDir) && readdirSync(markerDir).some((f) => f.includes("ghost-slug")),
    "python-side marker written",
  );
  await hooks.event(busEvent("session.idle", { sessionID: "test-sid" }));
  await sleep(2_000);
  assert.equal(state.prompts.length, 1, "second idle on the same claim did not re-prompt");
});

test("stop: a claim whose slug IS in QUEUE.md does not block", T, async () => {
  const dir = makeProject();
  const { hooks, state } = await makePlugin(dir, idleState("Done. I filed [fix-login-bug] to the queue."));
  await hooks.event(busEvent("session.idle", { sessionID: "test-sid" }));
  await sleep(3_000);
  assert.equal(state.prompts.length, 0, "no continuation for a real filing");
});

// ---------------------------------------------------------------------------
// 13. Relative path regression (OpenCode filePath may be relative)
// ---------------------------------------------------------------------------

test("relative filePath is resolved to absolute before Python sees it", T, async () => {
  const dir = makeProject({ buildFiles: ["src/app.py"] });
  const { hooks } = await makePlugin(dir);
  // Relative + listed: only passes if the shim resolved it — Python compares
  // normalised absolute paths, and a relative input could never match.
  await hooks["tool.execute.before"](
    { tool: "edit", sessionID: "test-sid", callID: "c11" },
    { args: { filePath: "src/app.py", oldString: "hi", newString: "v2" } },
  );
  // Relative + unlisted: must still deny.
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "edit", sessionID: "test-sid", callID: "c12" },
      { args: { filePath: "rogue.py", oldString: "a", newString: "b" } },
    ),
    /file list|not in/i,
  );
});

// ---------------------------------------------------------------------------
// 14. Skill materialization
// ---------------------------------------------------------------------------

test("skills are materialized into the global skills dir with rewritten root", T, async () => {
  const dir = makeProject();
  await makePlugin(dir);
  const skillsRoot = path.join(HOME, ".kilocode", "skills");
  for (const name of ["setup", "plan", "next", "rescan", "done"]) {
    const p = path.join(skillsRoot, name, "SKILL.md");
    assert.ok(existsSync(p), `skill ${name} materialized`);
    const body = readFileSync(p, "utf8");
    assert.ok(!body.includes("${CLAUDE_PLUGIN_ROOT}"), `${name}: no unrewritten CLAUDE_PLUGIN_ROOT`);
    assert.ok(body.includes(VENDOR), `${name}: points at the vendored tree`);
    assert.match(body, /^---\nname: /m, `${name}: frontmatter intact`);
  }
});

// ---------------------------------------------------------------------------
// 15. Skill gate: the model cannot self-invoke the five method skills
// ---------------------------------------------------------------------------

test("skill gate: the model cannot self-invoke the five method skills (adopted project)", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "skill", sessionID: "test-sid", callID: "c13" },
      { args: { name: "next" } },
    ),
    /yours to type/i,
  );
});

// ---------------------------------------------------------------------------
// 16-17. Fail-open
// ---------------------------------------------------------------------------

test("fail-open: a missing vendored tree disables the plugin (no hooks, no throw)", T, async () => {
  const code = [
    `import tl from ${JSON.stringify(BUNDLE)};`,
    'const h = await tl({ client: { session: { messages: async () => ({data:[]}), prompt: async () => {} } }, directory: "/tmp" });',
    "console.log(JSON.stringify({ hookCount: Object.keys(h ?? {}).length }));",
  ].join("\n");
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...process.env, THROUGHLINER_ROOT: path.join(os.tmpdir(), "tl-nonexistent-root"), HOME: os.tmpdir() },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `node child exited 0 (stderr: ${r.stderr?.slice(0, 400)}, stdout: ${r.stdout?.slice(0, 200)})`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookCount, 0, "plugin returns no hooks when the vendor tree is missing");
});

test("fail-open: a missing python binary lets tools through", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  const old = process.env.THROUGHLINER_PYTHON;
  process.env.THROUGHLINER_PYTHON = "/nonexistent/python3";
  try {
    await hooks["tool.execute.before"](
      { tool: "bash", sessionID: "test-sid", callID: "c14" },
      { args: { command: "git push --force origin main" } },
    );
  } finally {
    process.env.THROUGHLINER_PYTHON = old;
  }
});

// ---------------------------------------------------------------------------
// 18. Unknown tools pass through untouched
// ---------------------------------------------------------------------------

test("unmapped tools pass through untouched", T, async () => {
  const dir = makeProject();
  const { hooks } = await makePlugin(dir);
  await hooks["tool.execute.before"](
    { tool: "read", sessionID: "test-sid", callID: "c15" },
    { args: { filePath: path.join(dir, "anything") } },
  );
});
