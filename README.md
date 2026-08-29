# Throughliner for Kilo Code

[Throughliner](https://github.com/FlintcraftTech/throughliner) is a spec-driven
workflow for agentic coding: a `QUEUE.md` of work items, a `SPEC.md` contract,
session-scoped build files, and five method commands that move work through
plan → build → queue. This port runs the **unmodified** upstream hooks
(vendored pristine at `vendor/throughliner/`, pinned to upstream
`v1.21.1` / commit `743aa63`) under [Kilo Code](https://kilo.ai) via a thin
plugin shim.

Kilo Code is an OpenCode fork; the plugin contract is the same bus, verified
against the 7.4.23 binary and `@kilocode/{plugin,sdk}`.

## Requirements

- Kilo Code (the shim was verified against 7.4.23)
- Python 3 (`python3` on `PATH`) — the vendored hooks are Python
- git

The model is whatever Kilo is configured with; Throughliner is
model-agnostic and makes no model choice.

## Install

1. Put this repository anywhere on disk, e.g. `git clone <url> ~/dev/throughliner-kilocode`.
2. At the project root, create `kilo.jsonc` (merge into an existing one) from
   [`example/kilo.jsonc`](example/kilo.jsonc) — replace the `plugin` path with
   the real location of this repo:

   ```jsonc
   {
     "plugin": ["/home/you/dev/throughliner-kilocode/kilo/plugin.ts"],
     "permission": {
       "task": "ask",
       "skill": { "setup": "ask", "plan": "ask", "next": "ask", "rescan": "ask", "done": "ask" }
     }
   }
   ```

   The `plugin` line loads the shim (absolute paths, paths relative to the
   config file, and `file://` URLs all work). The `permission` block is the
   native gate for the two "ask" behaviors — see below.

3. Done. On load the plugin:
   - verifies the vendored hook tree next to `plugin.ts`
     (`<repo>/vendor/throughliner/hooks/pre_tool_use.py` must exist — without
     it the plugin disables itself and logs one line), and
   - materializes the five method skills into `~/.kilocode/skills/<name>/SKILL.md`,
     rewriting `${CLAUDE_PLUGIN_ROOT}` to the real vendor path (idempotent).

## The five commands

Type these yourself in the Kilo prompt — the shim **denies model
self-invocation** of all five before the native skill permission even fires,
exactly as upstream intends:

| Command   | Purpose                                                        |
|-----------|----------------------------------------------------------------|
| `/setup`  | Create `SPEC.md` + `QUEUE.md` for a new or adopted project     |
| `/plan`   | Turn the next queued item into a build plan                    |
| `/next`   | Execute the current build (scope-locked to the build's `Files:`) |
| `/rescan` | Re-read project state into the session context                 |
| `/done`   | Close out the build: file results, commit, queue updates       |

**Headless automation note:** `kilo run` inherits opencode's stdin handling —
a non-TTY *open* stdin is treated as piped input and waited on (verified on
opencode 1.18.x, the shared CLI). When scripting runs, redirect stdin:
`kilo run … < /dev/null`.

## What the shim enforces

All decisions come from the vendored Python hooks; the shim only translates
Kilo events to the Claude hook protocol and back:

- **Session orientation** — `session_start.py` output is appended to the
  system prompt (fresh per LLM call, never cumulative), plus the `brevity.md`
  output style.
- **Scope lock** — while a build file `_build-<session>.md` exists, writes
  outside its `Files:` list are denied; the session's own build file is always
  editable.
- **Git guard** — `git push --force` etc. denied.
- **Subagent cost gate** — *native, not shimmed.* Kilo's client cannot create
  permission prompts, so the shim lets the `task` tool through and the
  `"task": "ask"` rule in your `kilo.jsonc` does the gating: interactive
  prompt in the TUI, auto-approve under `kilo run --auto`.
- **Queue lint** — after `QUEUE.md` writes, structural findings (e.g. a
  `####` entry with no trailing `[slug]`) are appended to the tool output as
  advisory context.
- **Stop check** — when a session goes idle, a claim like "I filed
  [some-slug]" that is not actually in `QUEUE.md` re-prompts the session to
  fix it (loop-capped). **One-shot safety net:** `kilo run` may exit before an
  async continuation is processed; the shim also writes
  `.throughliner/pending-continuation.json`, and the *next* session's
  session-start surfaces it ("a previous session ended claiming: …").
- **Shim trace** — every hook fire appends a JSON line to
  `.throughliner/.shim-<sessionID>.jsonl` in the project. The fastest way to
  see what the port did.

## Rule gate — the mechanical half

The vendored method ships the *judgment* side of the rule gate: at close, a
session whose work touched the project's rules records a disposition
(`Rule gate: <slug> — run, …` / `— not needed, <why>`; see
`vendor/throughliner/docs/next.md`). Upstream pairs that judgment with a
small script that re-checks the mechanical half against the project's own
records; their script is hardwired to their repo's paths, so this port ships
a layout-agnostic re-implementation of the same four checks:

```sh
python3 kilo/scripts/rule_corpus_check.py <project-dir> \
    [--rules PATH ...] [--log-dir DIR] [--dup-threshold 0.85] \
    [--retired NAME ...] [--capture-queue QUEUE.md]
```

Checks: `gate-line` (every rule-authoring session's record carries a
`Rule gate:` line), `not-needed-growth` (a "not needed" disposition is not
contradicted by rule text growing in the entry's own commit), `near-dup`
(no two rule segments say nearly the same thing), `retired-name` (no live
rule names a retired mechanism — names from any `## Retired` section in the
rules files plus `--retired` flags). Exit codes: 0 clean, 1 findings, 2
usage/setup error. `--capture-queue` files the findings as work items in
the queue's Unprocessed section (stable slugs; re-runs never duplicate).
Rule-authoring sessions are detected conservatively: the entry's
`**Files touched:**` line or its title must name a rules file.

The session-start orientation points the model at the script, so a session
that must run a rule-gate pass can find it. A clean run proves the checks
ran, never that the rules are good — the checks verify record-keeping
consistency, not rule quality; that stays with the judgment gate.


## Headless runs

- `kilo run --auto …` — recommended for automation. `task`/`skill` asks are
  auto-approved; explicit denies (scope lock, git guard) still apply.
- `kilo run` without `--auto` auto-REJECTS asks and exits non-zero — the
  native gates will block headless runs; use `--auto`.

## Environment overrides

| Variable             | Meaning                                              |
|----------------------|------------------------------------------------------|
| `THROUGHLINER_ROOT`  | Override the vendored hook tree location             |
| `THROUGHLINER_PYTHON`| Python interpreter for the hooks (default `python3`) |

## Notes & limits

- `KILO_PURE=1` in your environment disables external plugins — the port
  silently becomes inert (skills still load; hooks don).
- Kilo telemetry is your choice; the port does not touch it.
- If your project defines `.kilo/commands/<name>.md` for any of the five
  names, the command shadows the skill (registry order).
- Eval-equivalent write surfaces (custom/MCP tools that write files) are not
  covered by the scope lock — the lock polices `edit`/`write`/`bash`/`task`/`skill`.
- Subagents spawned under a plain `kilo run` root session have their own asks
  denied outright (KiloHeadless behavior, fork issue #11903) — expected path
  noise in headless runs, not a port bug.

## Uninstall

Remove the `plugin` line from your `kilo.jsonc`. The materialized skills
remain in `~/.kilocode/skills/` — delete those five directories if you want
them gone.

## Provenance

`vendor/throughliner/` is byte-identical to upstream
`FlintcraftTech/throughliner` at `743aa63166ce4875305c7d97041a1b462b0fdc2c`
(`v1.21.1`), pinned and verified by `vendor/MANIFEST.sha256`
(`tools/vendor.sh` re-checks it). Every port change lives outside `vendor/`
and is a reviewable diff. See `PROVENANCE.md` and `ANALYSIS.md` (full
platform mapping, source-verified).

## Tests

```sh
npm install
npx tsc -p .test/tsconfig.check.json
npx esbuild kilo/plugin.ts --bundle --format=esm --platform=node --outfile=.test/plugin.mjs
node --test test/harness.mjs   # 19 tests, ~10s
python3 test/rule_corpus_check.py   # 6 tests, throwaway git projects
```

The suite drives the real bundle with a mock Kilo client and the **real
vendored Python hooks**, asserting the translation contract end-to-end
(denies, allows, ask delegation, stop blocks, skill materialization,
fail-open).
