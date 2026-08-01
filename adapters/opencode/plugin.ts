/**
 * librarian — OpenCode plugin (spec §4, §14 amendment).
 *
 * THIS FILE IS THE WHOLE INTEGRATION. `librarian init` writes it to
 * `~/.config/opencode/plugins/librarian.ts`; OpenCode loads it in-process at startup. It
 * imports nothing but node builtins — no `ulid`, no `better-sqlite3`, no MCP SDK, no
 * dependency resolution for OpenCode to do — because everything with judgment in it lives
 * behind the installed binary:
 *
 *   plugin  ── {hook, cwd, input, output}  ─▶  librarian hook opencode
 *           ◀─ {brief, recall}                 (mapping, resource facts, collect, recall)
 *
 * The plugin's only jobs are the three things the binary cannot do from outside the host
 * process:
 *
 *   1. locate the binary (config `bin` — see the resolution block below),
 *   2. hold the per-session recall/brief cache (a hook process lives for one event), and
 *   3. splice the cached blocks into the outgoing message array. Claude Code gets
 *      `additionalContext` back over stdout from a spawned command; OpenCode cannot, so
 *      the mutation has to happen here.
 *
 * Nothing else belongs in this file. If a change wants to add mapping, redaction, salience,
 * or storage here, it belongs behind `librarian hook opencode` instead.
 *
 * OpenCode plugin API: https://opencode.ai/docs/plugins — a plugin is an async function
 * returning a hooks object. The hook NAMES are not the canonical contract (they drift across
 * OpenCode versions); the mapping behind `librarian hook opencode` is.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Loose = Record<string, unknown>;

/** How long to wait for `librarian hook opencode`. It bounds its own `librarian inject`
 *  calls to 1s each, so this is a kill-switch for a wedged process, not a latency budget. */
const HOOK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// CLI resolution: find the `librarian` executable without trusting $PATH.
//
// OpenCode is a native (Bun) binary; the PATH its plugin child inherits depends on how
// OpenCode was launched (terminal, desktop app, login service, package manager) and need
// not contain the dir a bare `librarian` was linked into. nvm/asdf/Homebrew/npm-global-bins/
// GUI launches all make bare-name lookup unreliable, and a shell rc (.zshrc) is not
// guaranteed to have run. So bare-name PATH lookup is a *convenience fallback*, never the
// contract. Resolution order (first hit wins):
//
//   1. LIBRARIAN_BIN env var — explicit override (dev, smoke tests).
//   2. ~/.librarian/config.json `{ "bin": "…" }` — written by `librarian init`. This is the
//      production mechanism: it is read from disk at runtime, so it survives whatever launch
//      environment OpenCode came from (unlike an env var or a shell PATH). The supported
//      install points it at ~/.librarian/bin/librarian.
//   3. The built dist/cli.js resolved relative to THIS file — the zero-config default for a
//      repo checkout (the dev inner loop, scripts/opencode-setup.sh).
//   4. Bare `librarian` on PATH — last-resort convenience.
//
// A resolved `.js` path needs a JS runtime to run it. We must NOT assume `process.execPath`
// is one: under OpenCode `process.execPath` is the compiled `opencode` binary, which, given
// a `.js` positional, just re-invokes itself and prints its help (exit 1) — the hook never
// runs. So a `.js` target is paired with a runtime resolved in this order:
//   a. LIBRARIAN_RUNTIME env / config `runtime` — an explicit interpreter path (the setup
//      script records the node it validated here, making the dev path deterministic).
//   b. process.execPath, but ONLY when it actually looks like a JS runtime (node/bun/deno) —
//      true for `node --test` and Node-hosted plugins, false for the opencode binary.
//   c. A node/bun discovered from environment hints (NVM_BIN, BUN_INSTALL) — best effort.
//   d. Last resort: spawn the `.js` directly and let its `#!/usr/bin/env node` shebang find
//      node on PATH (requires the file's exec bit; the setup script sets it).
// A non-.js target (a real executable — the supported install) is always spawned directly.
// The result is an argv PREFIX; the subcommand + args are appended.
// ---------------------------------------------------------------------------

/** The config file the collector owns (src/paths.ts CONFIG_PATH). We do not import it —
 *  this file must stay dependency-free — so we recompute the same path here, lazily (at
 *  call time, not module load) so it honors the current home directory. */
function configPath(): string {
  return path.join(os.homedir(), '.librarian', 'config.json');
}

/** Read a string-valued key out of ~/.librarian/config.json, best-effort: a missing file,
 *  malformed JSON, or an absent/blank value yields undefined (fall through to the next
 *  rung), never a throw — resolution must not break the session. */
function stringFromConfig(key: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const value = (parsed as Loose)[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  } catch {
    // absent or unreadable config — fall through
  }
  return undefined;
}

/** Does this executable path look like a JS runtime that can run a `.js` file directly?
 *  We match the basename against known runtimes so we never mistake a host app (e.g. the
 *  `opencode` binary, which is `process.execPath` inside the plugin) for an interpreter. */
function looksLikeJsRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase().replace(/\.exe$/, '');
  return base === 'node' || base === 'bun' || base === 'deno';
}

/** Best-effort discovery of a JS runtime from environment hints, without trusting a bare
 *  PATH lookup. nvm exports NVM_BIN (…/bin containing `node`); Bun exports BUN_INSTALL
 *  (…/bin/bun). Returns the first interpreter that exists on disk, or undefined. */
function discoverRuntime(): string | undefined {
  const candidates: string[] = [];
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) candidates.push(path.join(nvmBin, 'node'));
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) candidates.push(path.join(bunInstall, 'bin', 'bun'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/** Resolve a JS runtime to run a `.js` CLI (see the block comment above for the order and
 *  why `process.execPath` cannot be assumed). Returns undefined when no runtime is known,
 *  in which case the caller spawns the `.js` directly via its shebang. */
function resolveRuntime(): string | undefined {
  const fromEnv = process.env.LIBRARIAN_RUNTIME;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const fromConfig = stringFromConfig('runtime');
  if (fromConfig) return fromConfig;
  if (looksLikeJsRuntime(process.execPath)) return process.execPath;
  return discoverRuntime();
}

/** Turn a resolved CLI location into a spawn argv prefix. A real executable (no `.js`) is
 *  spawned directly. A `.js` is paired with a resolved JS runtime; if none can be found we
 *  fall back to spawning it directly and rely on its shebang + exec bit. */
function argvFor(bin: string): string[] {
  if (!bin.endsWith('.js')) return [bin];
  const runtime = resolveRuntime();
  return runtime ? [runtime, bin] : [bin];
}

/** The built dist/cli.js resolved relative to this source file, if it exists — the dev inner
 *  loop, where this file is symlinked out of a checkout. Returns undefined for the installed
 *  plugin (nothing is two dirs above ~/.config/opencode/plugins/). */
function binFromRepo(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '..', '..', 'dist', 'cli.js');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `librarian` invocation as an argv prefix (see the block comment above for the
 * ordering and rationale). Always returns something: the final rung is the bare name.
 *
 * Exported for the seam test (the only reason this is not module-private).
 */
export function resolveLibrarianArgv(): string[] {
  const fromEnv = process.env.LIBRARIAN_BIN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return argvFor(fromEnv);
  }
  const fromConfig = stringFromConfig('bin');
  if (fromConfig) {
    return argvFor(fromConfig);
  }
  const fromRepo = binFromRepo();
  if (fromRepo) {
    return argvFor(fromRepo);
  }
  return ['librarian'];
}

// ---------------------------------------------------------------------------
// The one call this plugin makes: `librarian hook opencode`.
// ---------------------------------------------------------------------------

/** What the shell prints back for `chat.message`. `*_ok` separates "ran and had nothing to
 *  say" from "the call failed", so a failed brief is retried next turn while a successful
 *  empty one is not re-asked. */
interface HookResult {
  brief_ok?: boolean;
  brief?: string;
  recall_ok?: boolean;
  recall?: string;
}

/**
 * Spawn `librarian hook opencode`, write the envelope to its stdin, and parse its stdout.
 *
 * Every failure mode — the binary missing, a non-zero exit, a hang, unparseable stdout —
 * resolves to `undefined`. Instrumentation must never break the session (§4), so this never
 * rejects and never throws.
 *
 * ponytail (v1 ceiling): one spawn per hook event. Fine for v1 — the shell is stateless and
 * there is no long-lived child to supervise. When it bites, the fix is a single persistent
 * child speaking the same envelope protocol over a pipe, not more logic here.
 */
async function callHook(
  envelope: Loose,
  log: (level: string, message: string) => void,
): Promise<HookResult | undefined> {
  const [cmd, ...prefix] = resolveLibrarianArgv();
  return await new Promise<HookResult | undefined>((resolve) => {
    let stdout = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: HookResult | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      // stderr is inherited so the shell's own diagnostics land in OpenCode's log.
      child = spawn(cmd, [...prefix, 'hook', 'opencode'], { stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (err) {
      log('error', `librarian hook opencode failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      resolve(undefined);
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      log('warn', 'librarian hook opencode timed out; skipping this event');
      finish(undefined);
    }, HOOK_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', (err: Error) => {
      log(
        'error',
        `librarian hook opencode failed to spawn: ${err.message} (set LIBRARIAN_BIN or ` +
          '~/.librarian/config.json "bin" to the installed binary, or run `librarian init`)',
      );
      finish(undefined);
    });
    // A broken stdin pipe means the child died before reading; `error`/`close` reports why.
    child.stdin.on('error', () => finish(undefined));
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        log('warn', `librarian hook opencode exited ${code}; skipping this event`);
        finish(undefined);
        return;
      }
      if (stdout.trim().length === 0) {
        finish(undefined); // nothing to splice — the normal case for non-prompt hooks
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        finish(typeof parsed === 'object' && parsed !== null ? (parsed as HookResult) : undefined);
      } catch {
        log('warn', 'librarian hook opencode printed unparseable output; skipping this event');
        finish(undefined);
      }
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

// ---------------------------------------------------------------------------
// Splicing the cached blocks into the outgoing message array. Pure — and the one piece of
// logic that must run inside OpenCode's process, because it mutates OpenCode's own array.
// ---------------------------------------------------------------------------

const LIBRARIAN_BRIEF_PART = 'librarian-brief';
const LIBRARIAN_RECALL_PART = 'librarian-recall';

export type OpenCodeMessage = {
  info?: { role?: string };
  role?: string;
  parts?: unknown[];
  [key: string]: unknown;
};

type TextPart = {
  type: 'text';
  text: string;
  synthetic: true;
  librarian: typeof LIBRARIAN_BRIEF_PART | typeof LIBRARIAN_RECALL_PART;
};

function roleOf(message: OpenCodeMessage): string | undefined {
  return message.info?.role ?? message.role;
}

/** Ours vs. the user's: we tag every part we add, so ordinary user text that merely mentions
 *  `<librarian-memory>` is never stripped. */
function isLibrarianPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const rec = part as Loose;
  return rec.librarian === LIBRARIAN_BRIEF_PART || rec.librarian === LIBRARIAN_RECALL_PART;
}

function part(text: string, kind: TextPart['librarian']): TextPart {
  return { type: 'text', text, synthetic: true, librarian: kind };
}

function latestUserIndex(messages: OpenCodeMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (roleOf(messages[index]) === 'user') return index;
  }
  return -1;
}

/**
 * Remove any prior librarian parts, then pin the startup brief to the FIRST user message and
 * the latest recall adjacent to the LATEST one. Stripping first is what makes repeated
 * `messages.transform` fires idempotent — the hook is a whole-history transform that fires
 * every round-trip, so without it each turn would stack another copy.
 *
 * Exported for the seam test (the only reason this is not module-private).
 */
export function spliceLibrarianInjection(
  messages: OpenCodeMessage[],
  recallBlock: string | undefined,
  briefBlock?: string | undefined,
): OpenCodeMessage[] {
  const brief = briefBlock && briefBlock.length > 0 ? briefBlock : undefined;
  const recall = recallBlock && recallBlock.length > 0 ? recallBlock : undefined;
  if (brief === undefined && recall === undefined && !messages.some((message) => (message.parts ?? []).some(isLibrarianPart))) {
    return messages;
  }

  const cleaned = messages.map((message) => ({
    ...message,
    parts: (message.parts ?? []).filter((candidate) => !isLibrarianPart(candidate)),
  }));
  if (brief === undefined && recall === undefined) return cleaned;

  const firstUser = cleaned.findIndex((message) => roleOf(message) === 'user');
  if (firstUser < 0) return cleaned;

  if (brief !== undefined) {
    cleaned[firstUser] = { ...cleaned[firstUser], parts: [part(brief, LIBRARIAN_BRIEF_PART), ...(cleaned[firstUser].parts ?? [])] };
  }
  if (recall !== undefined) {
    const latestUser = latestUserIndex(cleaned);
    cleaned[latestUser] = { ...cleaned[latestUser], parts: [part(recall, LIBRARIAN_RECALL_PART), ...(cleaned[latestUser].parts ?? [])] };
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

/** Minimal structural view of what OpenCode passes a plugin (see plugin docs). We do not
 *  import `@opencode-ai/plugin`'s types, so this file needs no dependency resolution at all;
 *  the shapes below are the documented context and hook signatures. */
interface PluginContext {
  directory?: string;
  worktree?: string;
  client?: { app?: { log?: (opts: { body: Loose }) => unknown } };
}

function asRecord(v: unknown): Loose | undefined {
  return typeof v === 'object' && v !== null ? (v as Loose) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const LibrarianPlugin = async (ctx: PluginContext) => {
  const cwd = ctx.worktree ?? ctx.directory ?? process.cwd();

  // Prompt dedup: `chat.message` is a one-shot "new message received" signal, but the same
  // UserMessage.id can still be delivered more than once — remember the ids we have already
  // forwarded and skip repeats. In-memory only, so a plugin restart resets it
  // (at-least-once; an occasional post-restart dup is fine, the collector has no id-dedup
  // today and instrumentation stays dumb).
  const seenMessageIds = new Set<string>();
  const latestRecallBySession = new Map<string, string | undefined>();
  const briefBySession = new Map<string, string | undefined>();
  let latestSessionKey = 'unknown';
  // OpenCode surfaces its version only on the full `Session` object (session.created), so we
  // remember it here and stamp every later envelope with it. The shell is one process per
  // event and cannot carry it forward itself.
  let agentVersion: string | undefined;

  const log = (level: string, message: string): void => {
    try {
      // Prefer structured logging through the SDK; fall back to stderr.
      // Call .log() directly on the app object to preserve `this` (§4).
      if (ctx.client?.app?.log) {
        void ctx.client.app.log({ body: { service: 'librarian', level, message } });
      } else {
        process.stderr.write(`librarian [${level}]: ${message}\n`);
      }
    } catch {
      // Instrumentation must never break the session (§4).
      process.stderr.write(`librarian [${level}]: ${message}\n`);
    }
  };

  /** Every hook goes out through here: the raw native payload plus the two facts only this
   *  process knows (the session cwd and the captured agent version). */
  const send = async (envelope: Loose): Promise<HookResult | undefined> =>
    await callHook({ ...envelope, cwd, ...(agentVersion ? { agent_version: agentVersion } : {}) }, log);

  const keyFor = (sessionId: string | undefined): string => (sessionId && sessionId.length > 0 ? sessionId : 'unknown');

  return {
    /**
     * A new message was received → forwarded for collection, and (for user messages) the
     * turn's recall request.
     *
     * Why `chat.message` and not `experimental.chat.messages.transform`: the latter is a
     * transform over the ENTIRE message history that fires on every chat round-trip, so
     * forwarding per user message there would re-emit every prior prompt each turn.
     * `chat.message` is the one-shot "message received" signal — the natural fit. The prompt
     * is captured at first receipt; later edits to a message are deliberately NOT re-emitted.
     *
     * The three payload reads below are this plugin's own bookkeeping, not mapping: the role
     * gate avoids a pointless spawn per assistant message, and the ids key the caches the
     * shell cannot hold. Interpreting the message is the shell's job.
     */
    'chat.message': async (input: Loose, output: Loose) => {
      const message = asRecord(output.message);
      if (!message || message.role !== 'user') {
        return;
      }
      const messageId = asString(message.id);
      if (messageId !== undefined) {
        if (seenMessageIds.has(messageId)) {
          return;
        }
        seenMessageIds.add(messageId);
      }
      const sessionKey = keyFor(asString(input.sessionID) ?? asString(message.sessionID));
      latestSessionKey = sessionKey;

      const result = await send({
        hook: 'chat.message',
        input,
        output,
        // Ask for the startup brief only until we hold one for this session.
        brief: !briefBySession.has(sessionKey),
      });
      if (!result) {
        latestRecallBySession.set(sessionKey, undefined);
        return;
      }
      if (result.brief_ok) {
        briefBySession.set(sessionKey, result.brief);
      }
      latestRecallBySession.set(sessionKey, result.recall_ok ? result.recall : undefined);
    },

    /**
     * The splice. OpenCode's hook contract is **mutate `output` in place; return `void`** —
     * and for this hook that means mutating the message ARRAY, not rebinding
     * `output.messages`. Verified against OpenCode 1.18.9: the call site is
     * `trigger('experimental.chat.messages.transform', {}, {messages: ze})` followed by
     * `toModelMessagesEffect(ze, …)`, so it converts the array object it handed us.
     * Assigning a new array to `output.messages` (or returning one) is silently dropped and
     * the injection never reaches the model.
     *
     * `input` is `{}` here — no session id is passed — so the `latestSessionKey` fallback
     * below is the only path, not a defensive extra.
     */
    'experimental.chat.messages.transform': async (input: Loose, output: Loose) => {
      const messages = Array.isArray(output.messages) ? (output.messages as OpenCodeMessage[]) : undefined;
      if (!messages) {
        return;
      }
      const sessionId = asString(input.sessionID) ?? asString(output.sessionID);
      // ponytail: fallback assumes one active OpenCode session per plugin instance; key from payload if multi-session interleaving appears.
      const sessionKey = sessionId ? keyFor(sessionId) : latestSessionKey;
      const spliced = spliceLibrarianInjection(messages, latestRecallBySession.get(sessionKey), briefBySession.get(sessionKey));
      if (spliced !== messages) {
        messages.splice(0, messages.length, ...spliced);
      }
    },

    /**
     * A tool finished executing → forwarded for collection.
     *
     * `output` carries what the tool printed, and is forwarded ONLY for shell tools. For a
     * read or a grep, `output.output` is the file's contents or the whole hit list: the
     * collector drops it (capture is confined to command/vcs_* categories), so serializing
     * it into a spawn's stdin on every read is pure cost on the hottest tool there is.
     * `args.command` is the shell-tool marker — the same gate as the role check on
     * `chat.message`, not mapping logic: what the payload MEANS is still the shell's call.
     */
    'tool.execute.after': async (input: Loose, output: Loose) => {
      const args = asRecord(input.args) ?? {};
      const isShellTool = asString(args.command) !== undefined;
      await send({ hook: 'tool.execute.after', input, ...(isShellTool ? { output } : {}) });
    },

    /**
     * Fired BEFORE session compaction runs (hook is "compacting", distinct from the post-hoc
     * `session.compacted` event) → forwarded for collection, then re-supply the cached memory
     * blocks so the summary carries them forward.
     *
     * Same in-place rule as the transform above, and the same verification: OpenCode calls
     * `trigger('experimental.session.compacting', {sessionID}, {context: [], prompt: undefined})`
     * and then uses `out.prompt ?? buildPrompt({previousSummary, context: out.context})` on the
     * object it passed. So `context` arrives as an ARRAY (push onto it), `prompt` arrives
     * undefined (only set if another plugin replaced the whole prompt), and returning a new
     * object is dropped.
     */
    'experimental.session.compacting': async (input: Loose, output: Loose) => {
      await send({ hook: 'experimental.session.compacting', input });
      const sessionId = asString(input.sessionID);
      // ponytail: fallback assumes one active OpenCode session per plugin instance; key from payload if multi-session interleaving appears.
      const sessionKey = sessionId ? keyFor(sessionId) : latestSessionKey;
      const memory = [briefBySession.get(sessionKey), latestRecallBySession.get(sessionKey)]
        .filter((block): block is string => !!block)
        .join('\n');
      if (memory.length === 0) {
        return;
      }
      if (Array.isArray(output.context)) {
        output.context.push(memory);
        return;
      }
      if (typeof output.prompt === 'string') {
        output.prompt = `${output.prompt}\n\n${memory}`;
      }
    },

    /** Session lifecycle. The shell keeps only the one-shot session.created (start) /
     *  session.deleted (stop); anything else lowers to nothing. `Session.version` is captured
     *  here because it appears on no other payload. */
    event: async ({ event }: { event: Loose }) => {
      if (!agentVersion && asString(event.type) === 'session.created') {
        agentVersion = asString(asRecord(asRecord(event.properties)?.info)?.version);
      }
      await send({ hook: 'event', event });
    },
  };
};

export default LibrarianPlugin;
