/**
 * Bounded log history for the launcher page: per service and merged, each capped
 * (2,000 lines by default), counting what it dropped so the view can say so.
 */
export interface LogLine {
  serviceId: string;
  source: 'output' | 'runtime';
  text: string;
}

export const LOG_LINE_CAP = 2_000;

class BoundedLines {
  lines: LogLine[] = [];
  dropped = 0;
  constructor(private readonly cap: number) {}
  push(line: LogLine): void {
    this.lines.push(line);
    if (this.lines.length > this.cap) {
      const excess = this.lines.length - this.cap;
      this.lines.splice(0, excess);
      this.dropped += excess;
    }
  }
}

export class LogBuffer {
  private readonly all: BoundedLines;
  private readonly byService = new Map<string, BoundedLines>();
  constructor(private readonly cap: number = LOG_LINE_CAP) {
    this.all = new BoundedLines(cap);
  }

  push(line: LogLine): void {
    this.all.push(line);
    let service = this.byService.get(line.serviceId);
    if (!service) this.byService.set(line.serviceId, (service = new BoundedLines(this.cap)));
    service.push(line);
  }

  /** One service's lines (or every service's, merged, for `undefined`) and how many were dropped. */
  view(serviceId?: string): { lines: readonly LogLine[]; dropped: number } {
    const source = serviceId === undefined ? this.all : this.byService.get(serviceId);
    return source ? { lines: source.lines, dropped: source.dropped } : { lines: [], dropped: 0 };
  }
}
