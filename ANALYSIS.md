# Throughliner → Kilo Code — Harness Analysis

**Analyst:** KiloScout (analysis-phase scout, three-harness port batch) · **Date:** 2026-08-28
**Subject:** Kilo Code 7.4.23 (VS Code extension + bundled `kilo` CLI) vs. the Throughliner Claude Code plugin (upstream v1.21.1, pinned `743aa63166ce4875305c7d97041a1b462b0fdc2c`)
**Method:** local install is ground truth (binary string probes, installed SDK type declarations, the user's live config files); the Kilo-Org/kilocode fork source on `main` confirms hook-pipeline semantics; official kilo.ai docs (7.x-current) for documented behavior. Everything the shim author must not guess is quoted verbatim in §4 with the file it came from.

> **Port-repo state at analysis time:** `vendor/throughliner/` is already vendored byte-identical (sha256 manifest, `tools/vendor.sh`, `PROVENANCE.md`, `LICENSE`). All port additions live outside `vendor/`; this analysis assumes that layout.

---

## 0. Verdicts at a glance

| # | Claude Code mechanism | Kilo Code equivalent | Verdict |
|---|----------------------|----------------------|---------|
| 1 | Five `SKILL.md` skills (`/setup /plan /next /rescan /done`) | Native **Agent Skills**: `.kilo/skills/<name>/SKILL.md` — the same file format Claude Code uses; each skill **automatically becomes a slash command** of the same name | **adapted (near-exact)** |
| 2 | `PreToolUse` hook — scope-lock + git guard + subagent ask-gate | Plugin hook `tool.execute.before` (throw = deny, reason visible to model; fires **before** the permission check) + declarative `permission` config for the subagent ask-gate | **adapted** |
| 3 | `PostToolUse` hook — QUEUE.md lint advisory | Plugin hook `tool.execute.after` (rewrite the `output.output` the model sees) | **adapted** |
| 4 | `SessionStart` hook — `additionalContext` | `session.created` bus event (shim runs `session_start.py`, stashes context) + `experimental.chat.system.transform` (append to system prompt) | **adapted** |
| 5 | `Stop` hook — block-once + reason fed back | `session.idle` bus event (shim runs `stop.py`) + `client.session.prompt` synthetic user turn to force continuation | **adapted (risk: one-shot process exit, §5.4)** |
| 6 | Output style (`brevity.md`) | No native equivalent → `/setup` writes a marked block into the project's `AGENTS.md` (mirrors the verified omp port's CLAUDE.md approach) | **adapted (missing natively)** |
| 7 | `.claude-plugin/plugin.json` + marketplace packaging | No agent-plugin marketplace; manual install (git clone + copy into project `.kilo/` + `vendor/`). Vendored `.claude-plugin/` is inert. | **missing (manual install)** |

**Strategy (identical to the verified omp port):** the vendored Python hooks stay pristine. One thin TypeScript shim (a single Kilo plugin file) translates Kilo plugin events ↔ the Claude hook JSON protocol: it builds the Claude-protocol payload (**with absolute paths — see §5.8**), spawns the vendored Python script, parses its Claude-protocol stdout, and acts (throw / append / prompt). Fail-open everywhere: every Python spawn is wrapped so any unexpected error resolves silently; the only intentional failures are scope-lock denials.

---

## 1. Harness overview + exact version installed

- **Installed:** the VS Code extension `kilocode.kilo-code-<version>-<platform>` (7.4.23 tested). The extension directory pins the bundled binary's version and its log banner reads `opencode` (it is an opencode fork).
- **Architecture (verified):** the extension is a thin Solid.js webview shell. The actual agent is the bundled standalone Bun-compiled binary `bin/kilo` (175,491,200 bytes). The extension delegates all agent work to the CLI — orchestration, MCP, tool execution, search, session storage, permissions, custom commands, skills (extension `docs/opencode-migration-plan.md`; Kilo's own whats-new docs: the extension is "rebuilt" on the portable CLI core). **Consequence for smoke: the CLI *is* the runtime. Headless `kilo run` exercises exactly the code paths a VS Code session would; no VS Code/Xvfb needed.**
- **Upstream fork:** `github.com/Kilo-Org/kilocode` (agent core = `packages/opencode`, an opencode fork). Plugin SDK: `@kilocode/plugin` (this machine pins 7.2.22 in `~/.kilocode/package.json` and `~/.config/kilo/package.json`); Kilo docs: plugin behavior is "identical to OpenCode".
- **Hook surface present in the 7.4.23 binary** (string-occurrence probe on `bin/kilo`, run by Main):

  | hook string | occurrences |
  |---|---|
  | `permission.ask` | 14 |
  | `tool.execute.before` / `tool.execute.after` | 6 / 6 |
  | `chat.system.transform` / `experimental.chat.system.transform` | 4 / 4 |
  | `tool.definition` | 9 |
  | `chat.message` | 4 |
  | `command.execute.before` | 2 |
  | `session.idle` | 2 |

  And **zero** hits for `PreToolUse|PostToolUse|SessionStart|StopHook|hooks.json` — Kilo has **no Claude-Code-style hooks**. The extension points are the opencode plugin hook system + declarative `permission` config.
- **Machine state:** `~/.config/kilo/kilo.jsonc` exists (global config; has the local `mercury` provider — §7); `~/.kilo/` does not exist yet (Kilo creates config dirs on demand); `~/.kilocode/` exists (legacy global, stale `skills/firecrawl`); no project-level `.kilo/` dirs on disk yet. `xvfb-run` exists at `/usr/bin/xvfb-run` but is not needed.

---

## 2. Extension model (what exists, where, in what format)

### 2.1 Config files (fork `src/config/paths.ts`, `src/config/config.ts`; docs "Config File Location")

| Scope | Paths |
|---|---|
| Global | `~/.config/kilo/` — candidates in order: `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json`, `config.json` (first that exists) |
| Project | `kilo.json[c]` / `opencode.json[c]` found walking **up from cwd to the project root (worktree)**; plus config **directories** `.kilo/` and legacy `.kilocode/` (same up-walk) |
| Home-level dirs | `~/.kilo/` and `~/.kilocode/` are also config directories — this is where `~/.kilo/skills/` lives |
| Override | `KILO_CONFIG_DIR` env adds a config dir; `KILO_CONFIG` / `KILO_CONFIG_CONTENT` inject config |

Precedence: project overrides global; arrays (`instructions`, `plugin`) merge. **Kilo does NOT read `.opencode/` or `~/.config/opencode/`** (explicit migration warning; this machine's opencode config is invisible to Kilo). JSONC supported. `{env:VAR}` / `{file:...}` substitution only in **trusted** config (global / `KILO_CONFIG` / org); project `{env:}` ignored, project `{file:...}` confined to project root.

### 2.2 Skills — native Agent Skills (Claude Code's `SKILL.md` format)

Discovery (fork `src/skill/index.ts`), in order:
1. Built-in skills (seeded first; a user skill with the same name overrides).
2. Global external: `~/.claude/skills/**/SKILL.md` (Claude-compat, **trusted**) and `~/.agents/skills/**/SKILL.md` (trusted); disable-able via `KILO_DISABLE_EXTERNAL_SKILLS` / `KILO_DISABLE_CLAUDE_CODE_SKILLS`-style flags.
3. Project external: `.claude/skills/`, `.agents/skills/` walked up from cwd to project root (**untrusted**).
4. Config dirs: pattern `{skill,skills}/**/SKILL.md` in every config dir — i.e. **`~/.config/kilo/skills/`**, **`~/.kilo/skills/`**, **`.kilo/skills/`**, `.kilocode/skills/`. Global/config-dir skills are **trusted**; project-local ones are **untrusted**.
5. `skills.paths` (config; abs/`~/`/relative dirs, `**/SKILL.md`) and `skills.urls` (remote index).

Frontmatter validation (the `isSkillFrontmatter` check): only `name` (string, required) and `description` (string, optional) are validated — **extra fields like `disable-model-invocation` / `user-invocable` are tolerated, not enforced** (kept in the parsed frontmatter data; nothing reads them). The docs' "name must match the directory name" convention is **not enforced in code** — skills register by frontmatter `name`; duplicates log a warning, first wins.

Runtime usage:
- `name` + `description` are injected into the system prompt (`## Available Skills` list, or an `<available_skills>` block in verbose mode).
- The model loads the full body via the built-in **`skill` tool** — `Parameters = { name: string }` (fork `src/tool/skill.ts`); the tool first calls `ctx.ask({ permission: "skill", patterns: [name] })` (skill use is **permission-gated by name**; unmatched rules default to `ask`), then returns `<skill_content name="...">` body + `Base directory for this skill: <dir>` + a sampled file list of the skill dir (limit 10).
- **Every skill also registers as a slash command** (fork `src/command/index.ts`): `commands[item.name] = fromSkill(item, dir)`; template = skill content + base-directory note; `source: "skill"`; `trusted` propagated. The `/name:skill` alias resolves the skill even when a same-named command exists. If a command of the same name is already registered (built-ins: `init`, `review`, `resume-claude`, `resume-codex`, plus user/MCP commands), the skill does **not** create a competing command.
- Untrusted (project) skills: no `!`command`` shell injection; `{env:}/{file:}` confined to project root. Trusted (global) skills may run `!`command`` with a forced **human** approval (`skillShell` metadata forces a prompt that machine auto-approve cannot answer).
- `/reload` re-scans.
- Throughliner's skills contain no `!`command`` blocks — the untrusted restriction is moot.

### 2.3 Commands / workflows (slash commands)

- Files: `**/*.md` under `{command,commands}/` in any config dir — i.e. **`.kilo/commands/`** (or `.kilo/command/`; fork glob is `{command,commands}/**/*.md`, both work), global `~/.config/kilo/commands/`, legacy `.kilocode/commands/`. Name = path relative to the `command/`/`commands/` prefix (filename minus `.md`). Frontmatter (schema `ConfigCommandV1.Info`): `description`, `agent`, `model`, `variant`, `subtask`. Template substitutions: `$1..$N`, `$ARGUMENTS`.
- Invocation: `/name` in TUI/extension; **headless: `kilo run --command <name> [args...]`** (verbatim flag help: `--command  the command to run, use message for args`).
- **The port needs no command files** — the five skills auto-register the five slash commands (§2.2).

### 2.4 Plugins (the hook surface)

Loading (fork `src/config/plugin.ts`, `src/plugin/index.ts`):
- **Plugin dirs, auto-registered:** `{plugin,plugins}/*.{ts,js}` in every config dir → `.kilo/plugin/`, `.kilocode/plugin/`, `~/.config/kilo/plugin/`, `~/.kilo/plugin/`. **No config entry needed.**
- **Config `plugin` array** (optional, for options or npm specs): npm spec (auto `bun install` at startup, cached; install scripts blocked), `["pkg", {options}]`, `"./path/plugin.ts"` (relative to the config file), `"file:///abs/plugin.ts"`. `options` are passed to the plugin function as `PluginOptions` (`Record<string, unknown>`).
- Module shape for local files: `export default { id: "throughliner", server }` where `server` is `(input: PluginInput, options?) => Promise<Hooks>`. Legacy named-function exports also accepted.
- `PluginInput` (verbatim, §4.1): `{ client, project, directory, worktree, experimental_workspace, serverUrl, $ }` — `client` is the full SDK client (used for the Stop continuation prompt), `$` is Bun's shell API, `directory`/`worktree` are the session's cwd/project root.
- **Hook execution semantics (fork `src/plugin/index.ts`, `src/session/tools.ts`):** `trigger` runs hooks **sequentially** via `Effect.promise(async () => fn(input, output))` — a hook that **throws rejects the tool call with that error** (the documented deny mechanism; Kilo's own docs example: `throw new Error("reading .env files is blocked")`). The `event` hook receives `{ event: { id, type, properties } }` for **every** bus event whose `location.directory` matches the plugin directory; dispatch is fire-and-forget (`void hook["event"]?.(...)` — handlers are **not awaited**, §5.4).
- **Failure posture:** a plugin that fails to load publishes a session-error event and is skipped — the harness continues (fail-open at plugin level). `KILO_PURE=1` disables external plugins entirely. Debug: `kilo --print-logs --log-level DEBUG`; structured logs via `client.app.log({ body: { service, level, message, extra } })`.
- Dependencies: `package.json` in the config dir → `bun install` at startup. **The shim needs no dependencies** (node builtins + Bun `$` only).

### 2.5 Agents (custom modes) and permissions

- Agents: Markdown with YAML frontmatter in `.kilo/agents/` / `.kilo/agent/` (project) or `~/.config/kilo/agent/` (global); body = system prompt; frontmatter: `description`, `model`, `mode: primary|subagent|all`, `steps`, `temperature`/`top_p`, `permission`, `color`, `hidden`. Built-ins include `code`, `plan`, `debug`, `ask`, `orchestrator` (deprecated), `explore`, `general` (+ Kilo's `ask`/`plan`/`architect`). `kilo agent list` prints each agent with its permission ruleset JSON (e.g. the `ask` agent's `{"permission":"*","action":"allow","pattern":"*"}` array). **The port needs no custom agent** — the built-in `code` agent runs the method; the shim is agent-agnostic.
- Permissions (fork `src/permission/index.ts`): config `permission` key — per tool class a scalar (`"allow"|"ask"|"deny"`) or pattern map; **last matching rule wins** (`findLast`); patterns are simple `*`/`?` wildcards with `~`/`$HOME` expansion; file tools match **workspace-relative** resolved paths; `bash` matches **parsed** multi-command patterns (one denied segment denies the whole command). Tool→permission class: `edit`/`write`/`apply_patch` → `edit`; reads → `read`; others by name (`bash`, `task`, `skill`, `webfetch`, `doom_loop`, `external_directory`, `mcp:<server>:*`, ...). A `*`-deny on a class hides the tool from the model entirely.
- `--auto` mode (docs + fork `src/kilocode/permission/headless.ts`): asks are auto-answered per config — **explicit `deny` is still enforced**; without `--auto`, a non-interactive run auto-rejects asks and exits 1. Subagent asks from a plain `kilo run` root session are denied outright (fork issue #11903). Interactive "Always" approvals **write to the global config** (`config.updateGlobal`) — another reason smoke must use `--auto` with a self-contained fixture, never interactive approvals.

### 2.6 Rules / instructions / AGENTS.md

- `instructions` config key (global or project `kilo.jsonc`): array of paths/globs (e.g. `["CONTRIBUTING.md", ".kilo/rules/*.md"]`) loaded into context; project overrides global on conflict. `.kilo/rules/` is the conventional dir; legacy `.kilocode/rules/` auto-included. Best-effort model adherence.
- `AGENTS.md`: documented project instruction file (root, `AGENT.md` fallback, uppercase required; per-directory `AGENTS.md` injected on file access; write-protected). The built-in `/init` command is literally "guided AGENTS.md setup" and its template (fork `src/command/template/initialize.txt`) references `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/` as the instruction-file family. Instruction priority (docs): agent prompt > project `kilo.jsonc instructions` > `AGENTS.md` > global `instructions` > skills (on demand).
  - **Open item:** a case-sensitive binary string probe found **no** `AGENTS.md`/`CLAUDE.md` literals in `bin/kilo` (probe 3); the case-insensitive re-probe and a live headless capture were still pending when this analysis was written. Docs are current and the init template proves the convention; §6 phase 3 includes a cheap marker test to confirm on this exact binary, with a fallback (§5.11).
- No output styles, no hook scripts, no `.claude/`-style `settings.json` hooks — confirmed by binary probes (zero hits for Claude hook vocabulary).

### 2.7 Marketplaces

- **No agent-plugin marketplace.** The extension "Marketplace" is skills/themes-only (community `kilo-marketplace` repo); `skills.urls` can pull remote skill dirs (with `index.json`). Plugin distribution = manual (clone/copy) or self-publishing the shim to npm.

---

## 3. Mapping table — Claude Code mechanism → Kilo equivalent

### Row 1 — The five SKILL.md skills → **adapted (near-exact)**

- **Claude:** `plugin/throughliner/skills/{setup,plan,next,rescan,done}/SKILL.md`; frontmatter `name`, `description`, `disable-model-invocation: true`, `user-invocable: true`; bodies reference `${CLAUDE_PLUGIN_ROOT}/docs/*.md`; user invokes `/name`; the model may **not** self-invoke.
- **Kilo:** `.kilo/skills/<name>/SKILL.md` (project) — native Agent Skills, **identical file format**. Port changes: (a) rewrite each body's `${CLAUDE_PLUGIN_ROOT}/docs/...` → project-relative `vendor/throughliner/docs/...` (Kilo does not expand `${CLAUDE_PLUGIN_ROOT}`; the skill tool injects only `Base directory for this skill: <skill-dir>`, and the docs live *outside* the skill dir, so explicit project-relative paths in the body are the robust choice); (b) keep frontmatter `name` = bare name and directory = name (registration is by frontmatter `name`; dir match is not enforced but keep it for hygiene); (c) the two non-spec fields are **tolerated but inert** — keep or drop, behavior is the same.
- **Model invocation:** not disabled natively. Mitigation = the `skill` permission class: unmatched rules default to `ask`, so a model-initiated `skill` tool call prompts the user first (verified: fork `src/tool/skill.ts` calls `ctx.ask({ permission: "skill", patterns: [name] })`). The shipped `kilo.jsonc` pins it explicitly: `"skill": { "setup": "ask", "plan": "ask", "next": "ask", "rescan": "ask", "done": "ask" }`. User slash invocations are never prompted.
- **Slash UX:** `/setup /plan /next /rescan /done` auto-exist (skill→command auto-registration) and work headless via `kilo run --command <name>`. No collisions with built-ins (`init`, `review`, `resume-claude`, `resume-codex`). A user project's own `.kilo/commands/next.md` would shadow the skill's command (registry check `if (commands[item.name]) continue`) — README note.

### Row 2 — PreToolUse (scope-lock + git guard + subagent ask-gate) → **adapted**

- **Claude:** `hooks.json` matchers `Edit|Write|MultiEdit`, `Bash|PowerShell`, `Task|Agent` → `pre_tool_use.py`; Claude JSON on stdin; decisions `deny`/`ask` + reason on stdout.
- **Kilo:** plugin hook **`tool.execute.before`** for Kilo tools `edit`, `write`, `bash`, `task` (lowercase; **no MultiEdit/PowerShell exist** — the vendored Python tolerates unknown tool names by early-returning). The shim builds the Claude payload: `tool_name` = mapped name (`Edit`/`Write`/`Bash`/`Task`), `tool_input` = `{file_path: <ABSOLUTE>}` (edit/write), `{command}` (bash), `{skill: name}` (skill tool, if mapped); `cwd` = `input.directory`; `session_id` = `input.sessionID`. Python says `deny` → shim **`throw new Error(reason)`** → tool call fails and the model sees the reason. Verified ordering (fork `src/session/tools.ts`): `tool.execute.before` fires **before** `item.execute`, and the permission `ctx.ask` happens *inside* `item.execute` — so the scope-lock enforces **before any permission resolution, independent of the permission config**.
- **Subagent cost ask-gate** (upstream: `Task|Agent` → ask, never block): **native** — `"task": "ask"` in project `kilo.jsonc`. In `--auto` the ask auto-approves (documented; matches the omp port's headless ask→allow); interactive users get the prompt. The shim does not reimplement this gate (its Python `Task` arm returning `ask` is ignored by the shim — the native permission is the gate; keep the Python arm running only for its side-effects, which are none on that path).
- **Fidelity:** exact behavior (deny + model-visible reason), adapted mechanism. Git-guard bash denials ride the same throw path.

### Row 3 — PostToolUse (QUEUE.md lint advisory) → **adapted**

- **Claude:** matchers `Edit|Write|MultiEdit` + `Bash|PowerShell` → `post_tool_use.py`; stdout `additionalContext` appended for the model.
- **Kilo:** plugin hook **`tool.execute.after`** (in: `tool, sessionID, callID, args`; out: `{ title, output, metadata }` — mutable). Fires after a **successful** tool execution (the pipeline wraps the completed `item.execute`). The shim runs `post_tool_use.py` with the same Claude payload as row 2 and, if `additionalContext` is non-empty, appends it to `output.output` — the model sees it inside the tool result. `post_tool_use.py` is self-gating ("only active when the project has adopted") — no shim change needed.

### Row 4 — SessionStart (`additionalContext`) → **adapted**

- **Claude:** SessionStart hook → `session_start.py` → stdout `additionalContext` injected into the session.
- **Kilo:** no SessionStart hook; use the bus: the `event` hook sees `session.created` (`{ type: "session.created", properties: { info: Session } }`; `Session` carries `id` and `directory`). The shim runs `session_start.py` once per session (dedupe by sessionID — the event fires once per session, but dedupe anyway) with `{ cwd: info.directory, session_id: info.id }`, stashes `additionalContext` keyed by sessionID. Injection: **`experimental.chat.system.transform`** (`input: { sessionID?, model }`, `output: { system: string[] }`) — append the stashed context to `output.system` for that sessionID. Fires per LLM call → the append must be **idempotent** (append the stashed string verbatim each call; the transform receives the base system array each time, so a plain push is idempotent by construction). Only sessions the shim handled (stash hit) get the block.

### Row 5 — Stop (block-once + reason fed back) → **adapted (risk: §5.4)**

- **Claude:** Stop hook → `stop.py` with `{ session_id, cwd, last_assistant_message }` → `"decision":"block"` + reason; Claude feeds the reason back invisibly; `stop.py` has internal loop protection (blocks once per identical claim, then downgrades to stderr-only).
- **Kilo:** `session.idle` bus event (`{ type: "session.idle", properties: { sessionID } }`) fires after every assistant turn completes — the same trigger point as Claude Stop. The shim needs `last_assistant_message`: track it incrementally in the `event` hook (`message.updated` / `message.part.updated` parts, last assistant text) — no extra client calls. If `stop.py` returns `block`, the shim calls `client.session.prompt({ path: { id: sessionID }, body: { parts: [ { type: "text", text: reason } ] } })` (SDK `SessionPromptData`, §4.4) → a **visible synthetic user turn** → the agent continues. Semantics differ from Claude's invisible block (the continuation is a user message in the transcript); acceptable — `stop.py`'s reason text is phrased as an instruction to the agent.
- **One-shot caveat:** in `kilo run`, event dispatch is fire-and-forget and the CLI may exit the server before the async continuation lands (§5.4); mitigations: pending-continuation marker + next-session reminder via the SessionStart path.

### Row 6 — Output style (`brevity.md`) → **adapted (missing natively)**

- No output-style mechanism in Kilo (no setting, no dir, no binary string). Port: the `/setup` skill body (port-rewritten, not the vendored docs) instructs writing the brevity rules as a **marked block** in the project's `AGENTS.md` (`<!-- throughliner:brevity:begin -->` … `<!-- throughliner:brevity:end -->`), sourced from the vendored `output-styles/brevity.md`. `AGENTS.md` is auto-loaded per §2.6 (marker-verified in smoke phase 3; fallback §5.11). User removes the block to opt out — exactly the omp port's CLAUDE.md approach.

### Row 7 — Plugin/marketplace packaging → **missing (manual install)**

- No agent-plugin packaging format; `.claude-plugin/plugin.json` is inert on Kilo (kept inside `vendor/` for provenance). The port ships as a git repo; install = clone + copy (§8). No version negotiation, no enable/disable switch beyond deleting files (or `KILO_PURE=1` disabling all external plugins).

---

## 4. Verbatim event/payload schemas (the shim author must not guess a field)

### 4.1 Plugin API — from the installed `@opencode-ai/plugin` types

File: the installed `@opencode-ai/plugin` types (`node_modules/@opencode-ai/plugin/dist/index.d.ts` of the opencode SDK install; Kilo's `@kilocode/plugin` has the identical shape per Kilo docs — Kilo's own plugin loader reads `PluginModule.server` or a legacy named export, fork `src/plugin/index.ts`).

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;          // session cwd
    worktree: string;           // project root
    experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void; };
    serverUrl: URL;
    $: BunShell;
};
export type PluginOptions = Record<string, unknown>;
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
export type PluginModule = { id?: string; server: Plugin; tui?: never; };
```

`Hooks` members the port uses (verbatim):

```ts
event?: (input: { event: Event; }) => Promise<void>;
"tool.execute.before"?: (input: { tool: string; sessionID: string; callID: string; },
                        output: { args: any; }) => Promise<void>;
"tool.execute.after"?: (input: { tool: string; sessionID: string; callID: string; args: any; },
                       output: { title: string; output: string; metadata: any; }) => Promise<void>;
"experimental.chat.system.transform"?: (input: { sessionID?: string; model: Model; },
                                        output: { system: string[]; }) => Promise<void>;
"command.execute.before"?: (input: { command: string; sessionID: string; arguments: string; },
                           output: { parts: Part[]; }) => Promise<void>;   // (not needed; noted for completeness)
"permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow"; }) => Promise<void>; // (see §5.3 — unverified, do not rely on)
```

### 4.2 Tool pipeline — fork `packages/opencode/src/session/tools.ts` (Kilo-Org/kilocode @ main, the 7.x runtime)

Every registered tool is wrapped so that its `execute` does, in order (operative lines verbatim):

```ts
await plugin.trigger("tool.execute.before", { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID }, { args })
// then (inside item.execute, where the permission ctx.ask lives):
output = yield* plugin.trigger("tool.execute.after", { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args }, {
    metadata: item.execute.metadata, title: item.execute.title, output: result.data
})
```

Consequences (verified in `src/plugin/index.ts`): `trigger` = `Effect.promise(async () => fn(input, output))` run sequentially per hook — **a throwing `tool.execute.before` hook fails the tool call and the hook's error message surfaces to the model**; `output.args` in `before` is mutable (the shim does not need to mutate it); `output.output` in `after` is what gets stored on the tool part. **`tool.execute.before` fires before the permission check** — scope-lock ordering is guaranteed.

### 4.3 Bus events — from the installed `@opencode-ai/sdk` types

File: the installed `@opencode-ai/sdk` types (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`; verbatim):

```ts
export type EventSessionIdle = { type: "session.idle"; properties: { sessionID: string; } };
export type EventSessionCreated = { type: "session.created"; properties: { info: Session; } };
export type EventCommandExecuted = { type: "command.executed"; properties: { name: string; sessionID: string; arguments: string; messageID: string; } };
export type EventSessionUpdated = { type: "session.updated"; properties: { info: Session; } };
export type EventMessagePartUpdated = { type: "message.part.updated"; properties: { sessionID: string; messageID: string; part: Part; /* ... */ } };
export type Session = { id: string; projectID: string; directory: string; parentID?: string; /* summary?, share? */ title: string; version: string; time: { created: number; updated: number; compacting?: number; }; /* revert? */ };
export type Permission = { id: string; type: string; pattern?: string | Array<string>; sessionID: string; messageID: string; callID?: string; title: string; metadata: { [key: string]: unknown }; time: { created: number; } };
export type GlobalEvent = { directory: string; payload: Event; };
```

The plugin `event` hook receives `{ event: { id: ev.id, type: ev.type, properties: ev.data } }` for every bus event whose `location.directory` equals the plugin's `directory` (fork `src/plugin/index.ts`; dispatch is `void` fire-and-forget — §5.4). For `last_assistant_message` (Stop), track `message.part.updated` parts of type `text` on assistant messages in that session.

### 4.4 SDK client — the Stop continuation prompt

Same file (`types.gen.d.ts`, verbatim):

```ts
export type SessionPromptData = {
    body?: {
        messageID?: string;
        model?: { providerID: string; modelID: string; };
        agent?: string;
        noReply?: boolean;
        system?: string;
        tools?: { [key: string]: boolean; };
        parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
    };
    path: { id: string; };   // Session ID
    query?: { directory?: string; };
    url: "/session/{id}/message";
};
```

i.e. `client.session.prompt({ path: { id: sessionID }, body: { parts: [ { type: "text", text: reason } ] } })`. (`client` comes from `PluginInput`; the same client exposes `session.messages`, `app.log`, etc.)

### 4.5 Vendored Claude-hook I/O — grepped from `vendor/throughliner/hooks/*.py`

**stdin fields consumed:** `cwd`, `session_id`, `hook_event_name`, `tool_name`, `tool_input` (keys read: `file_path`, `command`, `skill`), and `last_assistant_message` (stop.py only).

**stdout shapes:**
- `pre_tool_use.py`: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":<reason>}}`. Arms: `tool_input["file_path"]` (Edit/Write/MultiEdit — scope-lock), `tool_input["command"]` (Bash/PowerShell — git safety), `tool_input["skill"]` (Skill arm; plugin-qualified names rpartitioned on `:`), Task/Agent arm = subagent cost gate → **ask, never deny**. Side effects: `_fire_once` marker + build working file `working_file(cwd, "build", session_id)` under `<cwd>/.throughliner/`.
- `post_tool_use.py`: tool names in `("Edit","Write","MultiEdit","Bash","PowerShell")`; stdout `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":<message>}}`; writes editing markers via `write_editing_marker(cwd, session_id, filepath, bool)`; active only when the project has adopted the method.
- `session_start.py`: stdout `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<context>}}` (two emit sites; one joins `context_parts`); reads `cwd` + `session_id`, the `VERSION_FILE`, `FAQ/index.md`, plugin.json version, and Claude settings' `outputStyle` (last read is Claude-specific and harmless — it tolerates absence).
- `stop.py`: stdout `{"decision":"block","reason":<reason>}` — or **stderr-only** after one block (loop protection: blocks once per identical claim, then downgrades); compares `last_assistant_message` claims against `QUEUE.md` work-item slugs; blocked-once markers under `<cwd>/.throughliner/`.
- All four are pure-stdlib Python 3. **Non-matching/unknown input → no decision JSON on stdout** (early returns; unknown tool names pass through) — the shim must treat empty/missing/non-JSON stdout as "no decision" (allow/continue), which is also the fail-open default.

### 4.6 Kilo tool names + argument shapes (the shim's mapping table)

Kilo tool IDs are **lowercase**: `read`, `edit`, `write`, `bash`, `task`, `skill`, `glob`, `grep`, ... (confirmed via `kilo agent list` permission arrays and docs). Argument shapes: `bash` = `{ command: string }` (docs custom-modes example: `args.command.split(";")`); `edit`/`write` = `{ filePath: string, ... }` (workspace-relative or absolute; the permission layer resolves and matches the **workspace-relative** path — fork `src/permission/index.ts`; provenance code reads `part.state.metadata.filepath`); `skill` = `{ name: string }` (fork `src/tool/skill.ts`); `task` = `{ description, prompt, ... }` (subagent tool — the shim does not inspect its args). **Shim mapping:** `edit`→`Edit`, `write`→`Write` (both use the `file_path` arm; absolutize `filePath` against `input.directory`), `bash`→`Bash`, `task`→`Task`, `skill`→`Skill` with `tool_input.skill = args.name` (optional — the scope-lock does not need the Skill arm; map it anyway for parity). Defensively accept `filePath ?? file_path` on the shim side. `MultiEdit`/`PowerShell` never occur; the Python tolerates them if they did.

### 4.7 Config schemas (docs + fork, for the shipped `kilo.jsonc`)

```jsonc
// permission — ConfigPermissionV1: scalar per class OR pattern map; last match wins
{ "permission": {
    "task": "ask",                                   // subagent cost gate (row 2)
    "skill": { "setup": "ask", "plan": "ask", "next": "ask", "rescan": "ask", "done": "ask" }
} }
// instructions — array of paths/globs (row 6 fallback only)
{ "instructions": [".kilo/rules/*.md"] }
```

Skill frontmatter (validated): `name` (string, required), `description` (string, optional); extra keys tolerated. Command frontmatter (`ConfigCommandV1.Info`): `name` (from path), `description`, `agent`, `model`, `variant`, `subtask`. Agent frontmatter: `description`, `model`, `mode` (`primary|subagent|all`), `steps`, `temperature`/`top_p`, `permission`, `color`, `hidden`.

---

## 5. Gaps & risks (fail-open posture first)

1. **Fail-open invariant (the one hard rule).** Plugin hooks are in-process and async; `trigger` runs them sequentially and a **throwing** `tool.execute.before` fails that one tool call (fail-closed for exactly that call — that is the scope lock). Therefore the shim wraps **every** Python spawn/parse in try/catch and **resolves silently on any unexpected error**; it throws **only** for an intentional scope-lock/git-guard deny carrying the Python reason. A shim bug must never wedge the user's agent. At the plugin level the harness is already fail-open: load failure = session-error event + skip (fork `src/plugin/index.ts`). This is the same invariant as the omp port — keep it testable (the translation functions are pure and unit-testable with `bun -e`).
2. **`tool.execute.before` throw → model-visible error text.** Verified that the throw rejects the call; the **exact rendering** (tool part error state + error string in the `--format json` stream) is not yet captured — smoke phase 2 verifies it; if Kilo truncates/mangles long reasons, keep deny reasons short (the Python's are already terse).
3. **`permission.ask` plugin hook: unverified wiring in 7.4.23.** Present in the binary (14 string hits) and documented ("auto-allow or auto-deny permission prompts"), but the upstream opencode permission module **never calls it** (verified in upstream source) and the Kilo fork's trigger site was not located in the files read. **The scope-lock must not depend on it.** Enforcement is `tool.execute.before` + native `permission` config only. Treat `permission.ask` as an untested extra.
4. **`session.idle` in one-shot `kilo run` (the Stop risk).** Event dispatch is `void hook["event"]?.(...)` — **not awaited** (fork `src/plugin/index.ts`). The stop.py spawn is async; the CLI may exit the server before the continuation prompt is sent. On Linux the orphaned Python still completes and can write marker files, but the continuation needs a live server. Mitigations (ship all three): (a) on block, the shim writes `.throughliner/pending-continuation-<sessionID>` before attempting the prompt; (b) `session_start.py`'s context (or the shim's stashed SessionStart block) surfaces a "previous session ended with an unfiled claim: … — file it before starting new work" reminder when the marker exists, then deletes it; (c) document that interactive/VS Code sessions get full Stop semantics; one-shot runs get marker + next-session reminder. Smoke phase 2 R5 observes which path actually fires on this binary.
5. **Headless ask behavior.** `kilo run` without `--auto` auto-**rejects** asks and exits 1 → smoke must always use `--auto`. With `--auto`, `task: ask` and `skill: ask` auto-approve (documented) — matching the omp port's headless ask→allow; interactive users still get prompts. The subagent ask-gate is therefore observable only in interactive sessions (fine — it is native).
6. **Headless subagent denials.** Asks from a subagent spawned under a plain `kilo run` root session are denied outright (KiloHeadless, fork issue #11903). If a smoke skill run spawns a subagent, the subagent's own tool asks (e.g. its writes) can be denied — expected path noise, not a port bug. The upstream Task gate sits at the task *invocation* (root level), which `--auto` answers. Interpret smoke results accordingly.
7. **`disable-model-invocation` is inert.** The model *can* call the `skill` tool with any throughliner name; the default `skill` permission = `ask` (unmatched rule → `ask`) gates model-initiated use with a human prompt — close to the upstream intent, not identical. The shipped `kilo.jsonc` pins the five `ask` entries explicitly (§4.7). User slash invocations are never prompted.
8. **Relative-path pitfall.** Kilo edit/write args are workspace-relative; the Claude protocol expects **absolute** `file_path`. The shim must resolve against `input.directory` (session cwd) before spawning Python — the same pitfall the omp port hit. Never pass the raw arg through.
9. **No MultiEdit/PowerShell.** Covered by (8)/Python tolerance; nothing to do.
10. **Eval-equivalent write surfaces.** Custom tools / MCP tools that write files are **not** gated by the scope-lock (same accepted gap as the omp port; the lock covers `edit`/`write`/`bash`/`task`/`skill`). Document in README.
11. **AGENTS.md auto-load on this binary: unconfirmed** (case-sensitive probe miss; re-probe + headless capture pending at writing time). Smoke phase 3 marker test decides. **Fallback:** `/setup` writes the brevity block to `.kilo/rules/throughliner-brevity.md` instead, and the shipped `kilo.jsonc` adds `"instructions": [".kilo/rules/*.md"]` (rules files are a first-class documented mechanism). The port should support both; the marker test picks the default.
12. **Command-name shadowing.** If the user's project defines `.kilo/commands/next.md` (or any of the five names), it wins over the skill's auto-command (registry order, verified in fork `src/command/index.ts`). TUI-level slash commands are a separate layer. README note + the `/name:skill` alias always resolves the skill.
13. **Telemetry on by default** (fork telemetry config; Kilo cloud). Smoke fixture sets `"experimental": { "openTelemetry": false }` for determinism; the **shipped** port does not touch telemetry (user's choice) — README note.
14. **Slow local model** (Qwen3.8-27B Q4, CPU: 3–15 min/agent run) — budget: 5 model runs + 1 short marker run + no-model payload tests for iteration. Do not add model runs to iterate on shim bugs; payload-level tests (§6 phase 1) are the fast loop.
15. **Shim trace file.** The shim writes `.throughliner/.shim-<sessionID>.jsonl` (plain fs, best-effort, one line per hook fire: event/tool, mapped name, python exit, decision, action taken). Primary smoke observation channel — no fragile JSON-event parsing needed. Best-effort write failure = silent (fail-open).
16. **`KILO_PURE=1` in the user's environment disables external plugins** → the port silently becomes inert (skills still load; hooks don't). README note. Also `KILO_DISABLE_EXTERNAL_SKILLS` would kill the global-install skill variant — another reason the **project-level install is the recommended default**.

---

## 6. Smoke-test plan

**Vehicle:** the bundled CLI — `E=<extension-dir>/bin/kilo` (the extension's own runtime; §1) or any installed `kilo` on PATH. **Model:** whatever the machine's Kilo config already defines (global `~/.config/kilo/kilo.jsonc`); the port is model-agnostic (§7). No VS Code needed.

**Phase 0 — fixture (fast, no model):**
```bash
E=<abs-path-to-kilo-binary>
P=<abs-path-to-this-repo>
F=/tmp/kl-thru
rm -rf $F && mkdir -p $F && cd $F && git init -q
cp -r $P/kilo $P/vendor $F/ && cp $P/example/kilo.jsonc $F/   # the port tree + the example project config
```
Smoke-only `kilo.jsonc` additions (shipped file may omit the skill map): `{"permission":{"task":"ask","skill":{"setup":"ask","plan":"ask","next":"ask","rescan":"ask","done":"ask"}},"experimental":{"openTelemetry":false}}`.

**Phase 1 — payload-level tests (no model; the fast iteration loop).** Pipe Claude-protocol JSON into the vendored Python directly (same as the omp port's phase 1), plus `bun -e` unit checks of the shim's pure translation functions (tool-name mapping, path absolutization, payload build, stdout parse):
- `pre_tool_use.py`: post-adoption in-scope `Edit` of `SPEC.md` → no decision/allow; out-of-scope `Write` of `/tmp/kl-thru/outside.txt` → `permissionDecision: deny` + reason; `Bash` `{"command":"git reset --hard"}` → deny; `Bash` `{"command":"ls"}` → no decision; `Task` → `ask` (never deny).
- `post_tool_use.py`: `Edit` of `QUEUE.md` → `additionalContext` advisory present.
- `session_start.py`: adopted project → `additionalContext` mentions project state; fresh dir → minimal/no context.
- `stop.py`: `last_assistant_message` claiming a work item not in `QUEUE.md` → `{"decision":"block",...}`; identical claim again → stderr only (block-once loop protection).
- Plugin-load check (cheap model run, doubles as R0): `$E run --dir $F --print-logs --log-level DEBUG "reply ok"` → DEBUG log shows the plugin loaded with no error (a load failure would publish a session-error event before any model call).

**Phase 2 — headless skill runs (slow; 3–15 min each; `--format json > run-N.jsonl 2>run-N.err`, exit codes 0 ok / 124 timeout / 1 error-auto-reject):**
```bash
$E run --dir $F --auto --format json --command setup   # R1: scaffolds SPEC.md/QUEUE.md/LOG/, adoption, brevity block
$E run --dir $F --auto --format json --command plan    # R2: adds a queue item → PostToolUse advisory on the QUEUE.md edit
$E run --dir $F --auto --format json --command next    # R3: builds the top item → in-scope writes succeed (files on disk)
$E run --dir $F --auto --format json --command rescan  # R4
$E run --dir $F --auto --format json --command done    # R5: session close → Stop path
```
(`kilo run --command <name>` invokes the skill-derived command — the command registry includes skills, fork `src/command/index.ts`; if `--command plan` ever resolves to something else, fall back to a plain message: `"Use the /plan skill to ..."`.) The out-of-scope **denial** is proven deterministically in phase 1 (forcing the model to attempt an out-of-scope write is not reliable); R3 proves the allow path and that a deny never fires spuriously. If the model does attempt an out-of-scope write anyway, the JSON stream shows the tool part error carrying the Python reason (also verifies §5.2 rendering).

**Observing the four hook paths** (primary channel: shim trace `$F/.throughliner/.shim-<sessionID>.jsonl`; secondary: `run-N.jsonl` event stream):
1. **session_start** → trace line per `session.created`: spawn + `additionalContext` (port line naming the project/scratch state); injected block visible in R1's first-turn behavior and confirmable via `experimental.chat.system.transform` trace entries.
2. **pre_tool_use** → trace line per `edit`/`write`/`bash`/`task` fire with mapped name + decision; R3 in-scope writes succeed (files exist); denial rendering per phase 1 + any R3 attempt.
3. **post_tool_use** → trace line + in R2's JSON stream the `QUEUE.md` edit tool part's output contains the appended advisory text.
4. **stop** → trace at end of every run (spawn + decision); R5 is the critical observation: either (a) the JSON stream shows a synthetic user message + an extra assistant turn after the /done turn (full Stop works in one-shot), or (b) the pending-continuation marker appears and the reminder surfaces in the next session's SessionStart block (§5.4). Record which — it sets the documented behavior.

**Phase 3 — AGENTS.md marker test (one short run, decides §5.11):**
```bash
echo "MARKER-THRU-7788: you saw the marker." > $F/AGENTS.md
$E run --dir $F --auto "Reply with exactly: MARKER-THRU-7788"    # marker in reply → AGENTS.md auto-load confirmed on this binary
```

**Budget:** R0–R5 ≈ 6–7 model runs × (3–15 min). Phases 1/3-fast parts and all payload tests are model-free.

---

## 7. Model/provider config (portable — no machine values)

- **Nothing to install:** the port uses whatever provider/model Kilo is already
  configured with (global `~/.config/kilo/kilo.jsonc` or project config). Any
  OpenAI-compatible endpoint works (local llama.cpp, router, cloud); for a
  keyless local endpoint, the provider block needs no `apiKey`.
- **Verify the endpoint before budgeting model time:** `curl -s <baseURL>/models`.
- Optional explicit per-run override: `kilo run -m <provider>/<model>`.
- **The port ships zero model configuration** — see §8.

---

## 8. Universal install contract (what a stranger on any machine with any configured model needs)

- **Requirements:** Kilo CLI 7.x (7.4.23 tested) — via the VS Code extension or `npm i -g @kilocode/cli`; **Python 3** (stdlib only, for the vendored hooks); **git**; **any** configured Kilo provider/model (the port never specifies or requires one — Throughliner is a workflow layer, never a model choice; `kilo run -m <provider>/<model>` stays the user's). No network needed at install (no plugin npm deps); no secrets in the shipped tree (no keys, hostnames, or user paths).
- **Install (clone + project config — the shipped contract):**
  ```bash
  git clone <port-repo-url> <anywhere>
  # at the project root, create/merge kilo.jsonc from the repo's example/kilo.jsonc:
  {
    "plugin": ["<abs-path-to-repo>/kilo/plugin.ts"],
    "permission": {
      "task": "ask",
      "skill": { "setup": "ask", "plan": "ask", "next": "ask", "rescan": "ask", "done": "ask" }
    }
  }
  ```
  The `plugin` line loads the shim (absolute paths, config-relative paths, and
  `file://` URLs all work); the `permission` block is the native gate for the two
  "ask" behaviors. On load the plugin materializes the five method skills into
  `~/.kilocode/skills/<name>/SKILL.md` (idempotent) and verifies the vendored tree
  next to `plugin.ts`.
- **Uninstall:** remove the `plugin`/`permission` lines from the project config and
  delete `~/.kilocode/skills/{setup,plan,next,rescan,done}`.
- **Version floor:** the hook surface used (`tool.execute.before/after`, `event`, `experimental.chat.system.transform`, `skill` tool + skill→command auto-registration, `permission` config) is present in the 7.4.23 binary; `@kilocode/plugin` is API-stable across 7.x. If a future 7.x removes a hook, the shim's fail-open wrapper degrades to skills-only (hooks silently no-op) — an acceptable, documented failure mode.
- **Update policy:** snapshot-and-re-derive from the pinned upstream SHA (`tools/vendor.sh` re-vendors; manifest re-verifies) — per `PROVENANCE.md`.

---

## 9. Sources

- Local install: the Kilo Code VS Code extension (bundled `bin/kilo` string probes; `dist/extension.js`; `docs/opencode-migration-plan.md`); installed SDK types under the opencode SDK's `node_modules` (`@opencode-ai/plugin/dist/index.d.ts`, `@opencode-ai/sdk/dist/gen/types.gen.d.ts`); `kilo run --help` + `kilo agent list` outputs.
- Kilo fork source (main branch): `packages/opencode/src/{session/tools.ts, plugin/index.ts, permission/index.ts, command/index.ts, skill/index.ts, tool/skill.ts, config/{paths,config,command,plugin}.ts, kilocode/permission/headless.ts, command/template/initialize.txt}`.
- Upstream opencode (dev): `packages/opencode/src/{tool/skill.ts, permission/index.ts}` (the `permission.ask` non-call finding).
- Kilo docs (7.x-current): platforms/cli, cli-reference, vscode/whats-new, customize/{custom-modes, workflows, skills, agents-md, agent-permissions, custom-rules}, automate/extending/plugins.
- Upstream Throughliner: pinned at `743aa63` (v1.21.1; vendored to `vendor/throughliner/`, manifest-verified); vendored `hooks/hooks.json` and the four Python hooks' I/O (grep-verified this session).
- Reference port: the omp port, published on the fork's `main` branch (strategy + fail-open invariant + payload-test method).
