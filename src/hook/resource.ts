/**
 * Resource-fact resolution for the hook shells (I/O — deliberately kept out of the pure
 * mappers). The facts are agent-independent (§10.1: facts, not identity), so both
 * `librarian hook claude-code` and `librarian hook opencode` resolve them here.
 *
 * The `Resource` shape below is declared locally rather than imported from either mapper:
 * TypeScript is structural, so one definition satisfies both, and neither mapper gains a
 * dependency on the other.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLibrarian, type LibrarianCommand } from './librarianBin.ts';

export interface Resource {
  agent: string;
  agent_version?: string;
  machine_id: string;
  cwd: string;
  git_root?: string;
  git_remote?: string;
  git_branch?: string;
}

/** Run a command and return trimmed stdout, or undefined on any failure. Facts are
 *  best-effort: a missing git remote or an un-init'd repo yields `undefined`, never a
 *  throw — the hook must not break the agent's session over a missing fact. */
function tryRun(command: string, args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return undefined;
    }
    const out = result.stdout.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The persisted machine-id file the collector owns (src/paths.ts MACHINE_ID_PATH). We
 *  recompute rather than import it (§4 boundary) and resolve lazily so it honors the
 *  current home directory. `librarian machine-id` writes this on first run, so reading it
 *  directly lets the hook skip spawning the CLI on every event. */
function machineIdPath(): string {
  return path.join(os.homedir(), '.librarian', 'machine-id');
}

function readIdFile(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const id = fs.readFileSync(file, 'utf8').trim();
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the machine id the way the spec mandates (§10.1, §11): a generated, persisted
 * id — never the hostname. Prefer `MACHINE_ID_PATH` when set; then the persisted file the
 * collector already owns (the common case — reading it avoids a subprocess per event);
 * only if neither exists, ask the CLI (`librarian machine-id`), which generates-and-
 * persists on first call. If all fail (librarian not on PATH — a misconfiguration the
 * README calls out), fall back to a random UUID so an event still carries a non-empty
 * machine_id and the pipeline does not wedge; a warning is logged so the operator can fix
 * PATH.
 */
export function resolveMachineId(librarian: LibrarianCommand, log: (message: string) => void): string {
  const fromEnv = process.env.MACHINE_ID_PATH;
  if (fromEnv) {
    const id = readIdFile(fromEnv);
    if (id) {
      return id;
    }
  }

  const persisted = readIdFile(machineIdPath());
  if (persisted) {
    return persisted;
  }

  const fromCli = runLibrarian(librarian, ['machine-id'], { cwd: process.cwd(), encoding: 'utf8' });
  if (fromCli.status === 0 && typeof fromCli.stdout === 'string' && fromCli.stdout.trim().length > 0) {
    return fromCli.stdout.trim();
  }

  log(
    'could not resolve machine id with the built CLI or `librarian` on PATH; ' +
      'falling back to an ephemeral id for this run',
  );
  return randomUUID();
}

/** Resolve the git facts for a directory, all best-effort (§10.1: facts, not identity). */
export function resolveGitFacts(cwd: string): Pick<Resource, 'git_root' | 'git_remote' | 'git_branch'> {
  const git_root = tryRun('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!git_root) {
    return {}; // not a git repo — omit all three, don't guess
  }
  return {
    git_root,
    git_remote: tryRun('git', ['remote', 'get-url', 'origin'], cwd),
    git_branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
  };
}

/**
 * Build the `resource` block for one hook invocation. Each hook is a fresh short-lived
 * process, so `resource` is resolved per invocation rather than cached per session.
 * `agent_version` is only stamped when the caller could resolve it (Claude Code's hook
 * payloads never carry one; the OpenCode plugin back-fills it from `Session.version`) —
 * facts we cannot resolve are omitted, never invented.
 */
export function buildResource(
  agent: string,
  cwd: string,
  log: (message: string) => void,
  librarian: LibrarianCommand,
  agentVersion?: string,
): Resource {
  return {
    agent,
    ...(agentVersion ? { agent_version: agentVersion } : {}),
    machine_id: resolveMachineId(librarian, log),
    cwd,
    ...resolveGitFacts(cwd),
  };
}
