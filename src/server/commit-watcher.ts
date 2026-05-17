import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { runLearn, type LearnRunResult } from '../knowledge/index.js';
import { loadConfig } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Lifecycle events emitted as the watcher runs. The viewer subscribes to
 * these via SSE so the UI can show "extracted: <subject>" toasts and refresh
 * the by-commit panel as soon as a note lands. Every event is shaped so that
 * a JSON-only consumer (the SSE stream) can read it without further parsing.
 */
export type WatcherEvent =
  | { type: 'started'; ts: string; repos: string[] }
  | { type: 'repo-error'; ts: string; repo: string; reason: string }
  | { type: 'commit-detected'; ts: string; repo: string; sha: string }
  | { type: 'learn-started'; ts: string; repo: string; sha: string }
  | { type: 'learn-completed'; ts: string; repo: string; result: LearnRunResult }
  | { type: 'stopped'; ts: string };

const DEBOUNCE_MS = 500;

/**
 * In-process commit watcher. Replaces the old `.git/hooks/post-commit`
 * mechanism: instead of git itself spawning `contextberg learn` synchronously
 * (and blocking the user's `git commit` for the duration of the LLM call),
 * the running viewer tails `.git/logs/HEAD` for every repo in
 * `config.knowledge.watchedRepos` and dispatches `runLearn` in the background.
 *
 * Design:
 *   - One `fs.watch` handle per repo, on the file `.git/logs/HEAD`. That file
 *     is the journal git appends to on every ref movement, so any commit
 *     produces an event. We lean on it instead of polling `git log` because
 *     the cost of being wrong (a missed commit) is "the user reruns
 *     `contextberg learn` manually", not data corruption.
 *   - 500ms debounce per repo absorbs bursts (rebase, multi-line commit
 *     editor saves) into a single dispatch.
 *   - Per-repo serialisation: a fresh commit while a previous learn is still
 *     running queues behind the in-flight Promise. Different repos run in
 *     parallel.
 *   - `runLearn` already returns a structured `LearnRunResult` and never
 *     calls `process.exit`, so a bad commit can't take the viewer down.
 */
export class CommitWatcher {
  private readonly emitter = new EventEmitter();
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly lastSeen = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private started = false;

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<T extends WatcherEvent['type']>(
    type: T,
    fn: (ev: Extract<WatcherEvent, { type: T }>) => void,
  ): () => void {
    this.emitter.on(type, fn as (ev: WatcherEvent) => void);
    return () => this.emitter.off(type, fn as (ev: WatcherEvent) => void);
  }

  /** Subscribe to every event regardless of type. Returns an unsubscribe function. */
  onAny(fn: (ev: WatcherEvent) => void): () => void {
    this.emitter.on('*', fn);
    return () => this.emitter.off('*', fn);
  }

  private emit(ev: WatcherEvent): void {
    this.emitter.emit(ev.type, ev);
    this.emitter.emit('*', ev);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const config = await loadConfig();
    const repos = config.knowledge.watchedRepos ?? [];
    this.emit({ type: 'started', ts: new Date().toISOString(), repos });

    for (const repo of repos) await this.watchOne(repo);
  }

  private async watchOne(repo: string): Promise<void> {
    const logsHead = path.join(repo, '.git', 'logs', 'HEAD');
    if (!fs.existsSync(logsHead)) {
      this.emit({
        type: 'repo-error',
        ts: new Date().toISOString(),
        repo,
        reason: `missing logs/HEAD (not a git repo, or no commits yet): ${logsHead}`,
      });
      return;
    }
    // Seed lastSeen so the next change event compares against the current
    // HEAD, not against `undefined` (which would fire a no-op learn the first
    // time the watcher boots and see any movement).
    try {
      this.lastSeen.set(repo, await this.headSha(repo));
    } catch (err) {
      this.emit({
        type: 'repo-error',
        ts: new Date().toISOString(),
        repo,
        reason: `git rev-parse HEAD failed: ${formatError(err)}`,
      });
      return;
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(logsHead, { persistent: false }, () => this.scheduleCheck(repo));
    } catch (err) {
      this.emit({
        type: 'repo-error',
        ts: new Date().toISOString(),
        repo,
        reason: `fs.watch failed: ${formatError(err)}`,
      });
      return;
    }
    watcher.on('error', (err) => {
      this.emit({
        type: 'repo-error',
        ts: new Date().toISOString(),
        repo,
        reason: `watcher error: ${formatError(err)}`,
      });
    });
    this.watchers.push(watcher);
  }

  private scheduleCheck(repo: string): void {
    const existing = this.debounce.get(repo);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      repo,
      setTimeout(() => {
        this.debounce.delete(repo);
        void this.checkAndDispatch(repo);
      }, DEBOUNCE_MS),
    );
  }

  private async checkAndDispatch(repo: string): Promise<void> {
    let sha: string;
    try {
      sha = await this.headSha(repo);
    } catch (err) {
      this.emit({
        type: 'repo-error',
        ts: new Date().toISOString(),
        repo,
        reason: `rev-parse failed: ${formatError(err)}`,
      });
      return;
    }
    if (this.lastSeen.get(repo) === sha) return;
    this.lastSeen.set(repo, sha);
    this.emit({ type: 'commit-detected', ts: new Date().toISOString(), repo, sha });

    // Per-repo serialisation: chain on the existing in-flight Promise. Two
    // commits in quick succession run sequentially, in order.
    const prev = this.inFlight.get(repo) ?? Promise.resolve();
    const next = prev.then(() => this.dispatchLearn(repo, sha));
    this.inFlight.set(repo, next);
    void next.finally(() => {
      if (this.inFlight.get(repo) === next) this.inFlight.delete(repo);
    });
  }

  private async dispatchLearn(repo: string, sha: string): Promise<void> {
    this.emit({ type: 'learn-started', ts: new Date().toISOString(), repo, sha });
    let result: LearnRunResult;
    try {
      result = await runLearn({ commit: sha, repo });
    } catch (err) {
      // runLearn shouldn't escape with the structured-result refactor, but
      // any genuine exception (out-of-disk, etc.) lands here and gets
      // surfaced as an error result rather than killing the watcher.
      result = {
        status: 'error',
        sha,
        repo,
        reason: formatError(err),
      };
    }
    this.emit({ type: 'learn-completed', ts: new Date().toISOString(), repo, result });
  }

  private async headSha(repo: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD']);
    return stdout.trim();
  }

  stop(): void {
    if (!this.started) return;
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers.length = 0;
    this.started = false;
    this.emit({ type: 'stopped', ts: new Date().toISOString() });
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
