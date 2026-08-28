/**
 * Throughliner plugin for Kilo Code.
 *
 * Translates the host's plugin hooks into the Claude Code hook contract that
 * the vendored Throughliner Python hooks speak (vendor/throughliner/hooks/).
 * The vendored files are pristine upstream content; this file is the entire
 * port surface.
 *
 * Mapping (host event -> vendored hook):
 *   tool.execute.before  -> pre_tool_use.py   (deny -> throw; ask -> allow + log,
 *                                               the native `"task": "ask"`
 *                                               permission in kilo.jsonc is the gate)
 *   tool.execute.after   -> post_tool_use.py  (additionalContext appended to tool output)
 *   session.created      -> session_start.py  (context stashed, injected per
 *                                                            LLM call via system.transform)
 *   experimental.chat.system.transform -> output-styles/brevity.md (always-on)
 *
 * The five method skills (setup/plan/next/rescan/done) are materialized at
 * plugin init into the host's global skills directory (~/.kilocode/skills),
 * with ${CLAUDE_PLUGIN_ROOT} rewritten to the vendored tree's absolute path.
 *
 * Kilo Code is an OpenCode fork; the bus event shapes (event wrapper,
 * requestID, tool.execute.after args-on-input) are identical to OpenCode's,
 *
 * Everything fails open: any error here degrades to "no Throughliner", never
 * to a broken session.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Port configuration

const SKILLS_DIR = path.join(homedir(), ".kilocode", "skills");
const LOG_PREFIX = "[throughliner]";

// ---------------------------------------------------------------------------
// Root resolution: this file lives at <repo>/kilo/plugin.ts
// ---------------------------------------------------------------------------

function repoRoot(): string | null {
  let root: string | null = null;
  if (process.env.THROUGHLINER_ROOT) {
    root = process.env.THROUGHLINER_ROOT;
  } else {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      root = path.join(path.dirname(here), "vendor", "throughliner");
    } catch {
      return null;
    }
  }
  // A path that is not a usable vendor tree is the same as none: the plugin
  // disables itself instead of running inert hooks against missing files.
  try {
    if (!existsSync(path.join(root, "hooks", "pre_tool_use.py"))) return null;
  } catch {
    return null;
  }
  return root;
}

const VENDOR_ROOT = repoRoot();

function log(msg: string): void {
  try {
    console.error(LOG_PREFIX + " " + msg);
  } catch {
    // never throw from logging
  }
}

// Best-effort debug channel: one JSON line per hook fire, appended to
// <cwd>/.throughliner/.shim-<sessionID>.jsonl — the primary observation
// channel for live runs. Never throws.
function trace(cwd: string, sid: string | undefined, entry: Record<string, unknown>): void {
  try {
    if (!cwd || !sid) return;
    const dir = path.join(cwd, ".throughliner");
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), session: sid, ...entry });
    writeFileSync(path.join(dir, `.shim-${sid.slice(0, 40)}.jsonl`), line + "\n", { flag: "a" });
  } catch {
    // tracing must never affect the session
  }
}
// ---------------------------------------------------------------------------
// Hook runner: spawn the vendored Python, feed Claude-protocol JSON, parse
// the JSON reply. Fail-open on every failure mode.
// ---------------------------------------------------------------------------

interface HookReply {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

function runHook(script: string, payload: unknown, timeoutMs: number): Promise<HookReply | null> {
  const { promise, resolve } = Promise.withResolvers<HookReply | null>();
  if (!VENDOR_ROOT) {
    resolve(null);
    return promise;
  }
  const bin = process.env.THROUGHLINER_PYTHON ?? "python3";
  const hookPath = path.join(VENDOR_ROOT, "hooks", script);
  let child;
  try {
    child = spawn(bin, [hookPath], {
      cwd: (payload as { cwd?: string }).cwd || process.cwd(),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: VENDOR_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    log(`${script} spawn failed: ${String(err)}`);
    resolve(null);
    return promise;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (reply: HookReply | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(reply);
  };
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    log(`${script} timed out after ${timeoutMs}ms — failing open`);
    finish(null);
  }, timeoutMs);
  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
  child.on("error", (err) => {
    log(`${script} failed to start (${bin}): ${String(err)} — failing open`);
    finish(null);
  });
  child.on("close", (code) => {
    if (code !== 0 && !stdout) {
      log(`${script} exited ${code}: ${stderr.slice(0, 400)} — failing open`);
      finish(null);
      return;
    }
    const text = stdout.trim();
    if (!text) {
      finish(null);
      return;
    }
    try {
      finish(JSON.parse(text) as HookReply);
      return;
    } catch { /* fall through */ }
    const last = text.split("\n").filter((l) => l.trim()).pop();
    if (last) {
      try {
        finish(JSON.parse(last) as HookReply);
        return;
      } catch { /* fall through */ }
    }
    log(`${script} returned non-JSON output — failing open`);
    finish(null);
  });
  child.stdin?.on("error", () => { /* EPIPE on fast exit; close handler covers it */ });
  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
  return promise;
}

// ---------------------------------------------------------------------------
// Claude tool-name mapping
// ---------------------------------------------------------------------------

/** opencode tool name -> Claude hook tool_name, or null for tools Throughliner does not police. */
function claudeToolName(tool: string): string | null {
  switch (tool) {
    case "write":
      return "Write";
    case "edit":
      return "MultiEdit";
    case "bash":
      return "Bash";
    case "task":
      return "Task";
    case "skill":
      return "Skill";
    default:
      return null;
  }
}

/** Build the Claude tool_input from the host's tool args. The vendored hooks
 * read exactly: file_path (Edit/Write/MultiEdit), command (Bash/PowerShell),
 * skill (Skill). Relative paths are resolved against the session cwd — the
 * Claude protocol is absolute. */
function claudeToolInput(tool: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const filePath = args.filePath ?? args.file_path ?? args.path;
  if (typeof filePath === "string") {
    out.file_path = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  }
  if (typeof args.command === "string") out.command = args.command;
  if (typeof args.name === "string" && tool === "skill") out.skill = args.name;
  if (typeof args.description === "string") out.description = args.description;
  return out;
}

// ---------------------------------------------------------------------------
// Skill materialization
// ---------------------------------------------------------------------------

const SKILL_NAMES = ["setup", "plan", "next", "rescan", "done"];

function materializeSkills(): void {
  for (const name of SKILL_NAMES) {
    try {
      const src = path.join(VENDOR_ROOT as string, "skills", name, "SKILL.md");
      const body = readFileSync(src, "utf8").replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, VENDOR_ROOT as string);
      const dir = path.join(SKILLS_DIR, name);
      mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, "SKILL.md");
      let current = "";
      try { current = readFileSync(dest, "utf8"); } catch { /* first install */ }
      if (current !== body) writeFileSync(dest, body);
    } catch (err) {
      log(`skill materialization failed for ${name}: ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface PluginInputLike {
  client: {
    session: {
      messages(params: { sessionID: string }): Promise<{ data?: Array<{ info?: { role?: string; id?: string } & Record<string, unknown>; parts?: Array<{ type?: string; text?: string }> & Record<string, unknown>}>, [k: string]: unknown }>;
      prompt(params: { sessionID: string; parts: Array<{ type: "text"; text: string }> }): Promise<unknown>;
    };
    [k: string]: unknown;
  };
  directory?: string;
  [k: string]: unknown;
}

export default function throughlinerPlugin(input: PluginInputLike) {
  if (!VENDOR_ROOT) {
    log("vendored tree not found next to the plugin (expected vendor/throughliner/) — plugin disabled");
    return Promise.resolve({});
  }
  materializeSkills();

  const startContext = new Map<string, Promise<string | null>>();
  const stopBlocks = new Map<string, number>();

  function sessionStart(sid: string, cwd: string): Promise<string | null> {
    let p = startContext.get(sid);
    if (!p) {
      p = runHook("session_start.py", { cwd, session_id: sid }, 60_000).then((out) => {
        let ctx = out?.hookSpecificOutput?.additionalContext ?? null;
        // One-shot safety net: a previous `kilo run` may have died before its
        // stop-block continuation was processed. Surface the pending claim to
        // this session, then clear the marker.
        try {
          const marker = path.join(cwd, ".throughliner", "pending-continuation.json");
          if (existsSync(marker)) {
            const claim = readFileSync(marker, "utf8").trim();
            try { unlinkSync(marker); } catch { /* best-effort */ }
            const note = `[Throughliner] A previous session ended claiming: ${claim}\nIf that work was never filed to QUEUE.md, file it before starting new work.`;
            ctx = ctx ? `${note}\n\n${ctx}` : note;
          }
        } catch {
          // best-effort
        }
        if (!ctx) startContext.delete(sid);
        return ctx;
      }).catch((err) => {
        log(`session_start failed: ${String(err)}`);
        startContext.delete(sid);
        return null;
      });
      startContext.set(sid, p);
    }
    return p;
  }

  function cwdOf(): string {
    return input.directory || process.cwd();
  }

  // Claude "ask" (the subagent cost gate) -> delegate to Kilo's native
  // permission system. Kilo's client has no permission.create, so the shim
  // cannot surface a prompt itself; instead the project's kilo.jsonc pins
  // "task": "ask", which the fork's permission layer enforces INSIDE
  // item.execute — i.e. AFTER tool.execute.before (ordering source-verified).
  // Allowing here lets that native gate do its job: interactive prompt in the
  // TUI, auto-approve under --auto.
  function noteSubagentGate(tool: string, reason: string): void {
    log(`subagent cost gate for ${tool} delegated to the native "task" permission (kilo.jsonc): ${reason}`);
  }

  async function onStopIdle(sid: string): Promise<void> {
    const cwd = cwdOf();
    let messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }> = [];
    try {
      const res = await input.client.session.messages({ sessionID: sid });
      messages = (res?.data ?? []) as typeof messages;
    } catch (err) {
      log(`stop: message fetch failed: ${String(err)}`);
      return;
    }
    const assistant = messages.filter((m) => m.info?.role === "assistant");
    const last = assistant[assistant.length - 1];
    if (!last) return;
    const text = (last.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    if (!text) return;
    const out = await runHook("stop.py", { last_assistant_message: text, cwd, session_id: sid }, 30_000);
    if (out?.decision !== "block" || !out.reason) return;
    const count = (stopBlocks.get(sid) ?? 0) + 1;
    if (count > 2) {
      log(`stop-block cap (2) reached for ${sid} — stopping the loop`);
      return;
    }
    stopBlocks.set(sid, count);
    try {
      // One-shot safety net: if the CLI exits before the continuation is
      // processed, the NEXT session's session_start surfaces this claim.
      const dir = path.join(cwd, ".throughliner");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "pending-continuation.json"), out.reason);
    } catch {
      // best-effort
    }
    try {
      await input.client.session.prompt({ sessionID: sid, parts: [{ type: "text", text: out.reason }] });
      log(`stop-block fired for ${sid} (block ${count}/2)`);
    } catch (err) {
      log(`stop-block re-prompt failed: ${String(err)}`);
    }
    trace(cwd, sid, { hook: "stop", decision: "block", block: count });
  }


  // Intentional denial from the vendored Python; must propagate even through fail-open catches.
  class ToolDenied extends Error {}

  return Promise.resolve({
    async "tool.execute.before"(
      _input: { tool: string; sessionID: string; callID: string; [k: string]: unknown },
      output: { args: Record<string, unknown> },
    ): Promise<void> {
      try {
        const claudeName = claudeToolName(_input.tool);
        if (!claudeName) return;
        const cwd = cwdOf();
        const payload = {
          cwd,
          session_id: _input.sessionID,
          tool_name: claudeName,
          tool_input: claudeToolInput(_input.tool, output.args ?? {}, cwd),
        };
        const out = await runHook("pre_tool_use.py", payload, 30_000);
        const decision = out?.hookSpecificOutput?.permissionDecision;
        const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? "blocked by Throughliner";
        if (decision === "deny") {
          trace(cwd, _input.sessionID, { hook: "pre_tool_use", tool: claudeName, decision: "deny", action: "throw" });
          throw new ToolDenied(reason);
        }
        if (decision === "ask") {
          trace(cwd, _input.sessionID, { hook: "pre_tool_use", tool: claudeName, decision: "ask", action: "allow(native gate)" });
          noteSubagentGate(_input.tool, reason);
        } else {
          trace(cwd, _input.sessionID, { hook: "pre_tool_use", tool: claudeName, decision: "none", action: "allow" });
        }
      } catch (err) {
        // Fail-open: the ONLY tool denial path is an explicit Python "deny" decision
        // (ToolDenied). Any unexpected shim error must not block the user's tools.
        if (err instanceof ToolDenied) throw err;
        log(`tool.execute.before error — allowing (fail-open): ${String(err)}`);
      }
    },

    // Trigger: ({ tool, sessionID, callID, args }, <tool result: { title, output, metadata, ... }>)
    // — args arrive on the INPUT; the result object is the mutable OUTPUT.
    async "tool.execute.after"(
      _input: { tool: string; sessionID: string; callID: string; args?: Record<string, unknown>; [k: string]: unknown },
      output: { output?: string; [k: string]: unknown },
    ): Promise<void> {
      try {
        const claudeName = claudeToolName(_input.tool);
        if (!claudeName) return;
        if (!["Write", "MultiEdit", "Bash"].includes(claudeName)) return;
        const cwd = cwdOf();
        const payload = {
          cwd,
          session_id: _input.sessionID,
          tool_name: claudeName,
          tool_input: claudeToolInput(_input.tool, _input.args ?? {}, cwd),
        };
        const out = await runHook("post_tool_use.py", payload, 30_000);
        const ctx = out?.hookSpecificOutput?.additionalContext;
        if (!ctx) return;
        if (typeof output.output === "string") {
          output.output += `\n\n${ctx}`;
          trace(cwd, _input.sessionID, { hook: "post_tool_use", tool: claudeName, action: "context-appended" });
        }
      } catch (err) {
        log(`tool.execute.after error — ignoring (fail-open): ${String(err)}`);
      }
    },

    // The server dispatches as hook["event"]({ event: { id, type, properties: <bus data> } })
    // — identical to OpenCode's dispatch (kilo 7.4.23 binary, verified).
    async event(input: {
      event?: { type?: string; properties?: { sessionID?: string; [k: string]: unknown }; [k: string]: unknown };
    }): Promise<void> {
      const event = input.event;
      if (!event) return;
      const sid = event.properties?.sessionID;
      if (!sid) return;
      if (event.type === "session.created") {
        void sessionStart(sid, cwdOf());
      } else if (event.type === "session.deleted") {
        startContext.delete(sid);
        stopBlocks.delete(sid);
      } else if (event.type === "session.idle") {
        void onStopIdle(sid);
      }
    },

    async "experimental.chat.system.transform"(
      _input: { sessionID?: string; [k: string]: unknown },
      output: { system: string[] },
    ): Promise<void> {
      try {
        const brevity = readFileSync(path.join(VENDOR_ROOT as string, "output-styles", "brevity.md"), "utf8");
        output.system.push(`[Throughliner output style — always on]\n${brevity}`);
      } catch (err) {
        log(`brevity injection failed: ${String(err)}`);
      }
      if (!_input.sessionID) return;
      const ctx = await sessionStart(_input.sessionID, cwdOf());
      if (ctx) {
        // The vendored hooks name per-session working files _build-<id>.md
        // from the hook payload's session_id; Claude Code shows the model its
        // session id natively, this host does not, so the shim says it.
        const safeId = _input.sessionID.replace(/[^A-Za-z0-9._-]/g, "_");
        const idNote = `Session ID for this session: ${safeId} — per-session working files are named with it, exactly _build-${safeId}.md (and _freeform-${safeId}.md for freeform work).`;
        output.system.push(`[Throughliner session orientation — injected once per session by the session_start hook]\n${ctx}\n${idNote}`);
      }
    },
  });
}

export type { PluginInputLike };
