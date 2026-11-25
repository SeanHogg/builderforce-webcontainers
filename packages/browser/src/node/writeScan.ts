/**
 * Write-time code scanning for the page's file system: files a process wrote are sent, debounced and
 * batched, to the embedder's {@link CodeScanner}. A block / quarantine verdict marks that exact VERSION
 * of the file blocked, so spawning it is refused; a newer write invalidates the old verdict (the file
 * is unblocked until its own rescan finishes) because the verdict is keyed on the file's version.
 *
 * The scan is asynchronous (the file system's apply path is synchronous), so a file can run in the
 * window before its verdict: the spawn gate reports that window as `code.scan_incomplete`.
 */
import {
  deny,
  normalizePath,
  refuses,
  type CodeScanner,
  type CodeScanSubject,
  type CodeScanVerdict,
  type SecurityContext,
  type ShieldDecision,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';

const DEBOUNCE_MS = 50;

/** A verdict the scanner never returned, or a scan that threw: incomplete, never clean. */
export const incompleteVerdict = (path: string): CodeScanVerdict => ({ path, action: 'review', complete: false, score: 0, ruleIds: [] });

/** The shield decision a verdict stands for, or undefined when it needs no report. Evidence is rule ids and score, never content. */
export function decisionFor(verdict: CodeScanVerdict): { decision: ShieldDecision; evidence: Readonly<Record<string, unknown>> } | undefined {
  const evidence = { path: verdict.path, ruleIds: verdict.ruleIds, score: verdict.score };
  if (refuses(verdict)) return { decision: deny('code.blocked'), evidence };
  if (!verdict.complete) return { decision: deny('code.scan_incomplete'), evidence };
  return undefined;
}

interface PendingWrite {
  readonly context: SecurityContext | undefined;
  readonly version: number;
}

export class WriteScanGate {
  private readonly pending = new Map<string, PendingWrite>();
  /** Path → the file version a scan in flight is for. */
  private readonly scanning = new Map<string, number>();
  /** Path → the file version a refusing verdict was for. */
  private readonly blocked = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly scanner: CodeScanner,
    private readonly onVerdict: (context: SecurityContext | undefined, verdict: CodeScanVerdict) => void,
  ) {}

  /** Queue freshly written files; their previous verdicts no longer apply. */
  enqueue(context: SecurityContext | undefined, paths: readonly string[]): void {
    for (const raw of paths) {
      const path = normalizePath(raw);
      const version = this.fs.version(path);
      if (version === undefined) continue;
      this.blocked.delete(path);
      this.pending.set(path, { context, version });
    }
    if (this.pending.size && this.timer === undefined) this.timer = setTimeout(() => void this.scanPending(), DEBOUNCE_MS);
  }

  /** Whether the file's CURRENT content was refused by the scanner. */
  isBlocked(path: string): boolean {
    const key = normalizePath(path);
    const version = this.blocked.get(key);
    return version !== undefined && this.fs.version(key) === version;
  }

  /** Whether a write to the file is waiting for, or in, its scan. */
  isPending(path: string): boolean {
    const key = normalizePath(path);
    return this.pending.has(key) || (this.scanning.has(key) && this.scanning.get(key) === this.fs.version(key));
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.scanning.clear();
    this.blocked.clear();
  }

  private async scanPending(): Promise<void> {
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [path, write] of batch) this.scanning.set(path, write.version);
    const subjects: CodeScanSubject[] = [];
    for (const [path] of batch) {
      const content = this.fs.readFile(path);
      if (content !== undefined) subjects.push({ path, content });
    }
    if (!subjects.length) return this.settle(batch);
    let verdicts: readonly CodeScanVerdict[];
    try {
      verdicts = await this.scanner.scan('write', subjects);
    } catch {
      // error-logging: a scanner fault fails to INCOMPLETE below (reported as code.scan_incomplete), never to clean
      verdicts = [];
    }
    const byPath = new Map(verdicts.map((v) => [normalizePath(v.path), v]));
    for (const [path, write] of batch) {
      if (this.fs.version(path) !== write.version) continue; // rewritten since: its own scan decides
      const verdict = byPath.get(path) ?? incompleteVerdict(path);
      if (refuses(verdict)) this.blocked.set(path, write.version);
      try {
        this.onVerdict(write.context, { ...verdict, path });
      } catch {
        // error-logging: telemetry fails open; the verdict above already stands
      }
    }
    this.settle(batch);
  }

  /** The batch's scans are over: a path rewritten since keeps the entry its newer scan set. */
  private settle(batch: readonly (readonly [string, PendingWrite])[]): void {
    for (const [path, write] of batch) if (this.scanning.get(path) === write.version) this.scanning.delete(path);
  }
}
