/**
 * otlp-buffer — per-service tumbling window buffer for OTLP RRPair records.
 *
 * Accumulates parsed RRPair objects in memory grouped by service name.
 * On each timer tick, all non-empty service buffers are closed and returned
 * as WindowContents for downstream processing.
 */

export interface BufferConfig {
  /** Tumbling window size in milliseconds. Default 60000 (60s). */
  windowMs: number;
  /** Max records per service before oldest are dropped. Default 10000. */
  maxRecordsPerService: number;
}

export interface WindowContents {
  service: string;
  records: Record<string, unknown>[];
  windowStart: string;
  windowEnd: string;
  droppedCount: number;
}

interface ServiceBuffer {
  records: Record<string, unknown>[];
  windowStart: string;
  droppedCount: number;
}

const DEFAULT_CONFIG: BufferConfig = {
  windowMs: 60_000,
  maxRecordsPerService: 10_000,
};

export class OtlpBuffer {
  private readonly config: BufferConfig;
  private readonly buffers = new Map<string, ServiceBuffer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onWindowClose: ((windows: WindowContents[]) => void) | null = null;

  constructor(config: Partial<BufferConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Add a parsed RRPair to the buffer for the given service. */
  push(service: string, record: Record<string, unknown>): void {
    let buf = this.buffers.get(service);
    if (!buf) {
      buf = {
        records: [],
        windowStart: new Date().toISOString(),
        droppedCount: 0,
      };
      this.buffers.set(service, buf);
    }

    if (buf.records.length >= this.config.maxRecordsPerService) {
      buf.records.shift();
      buf.droppedCount++;
    }

    buf.records.push(record);
  }

  /**
   * Close all non-empty windows and return their contents.
   * Resets the internal buffers for the next window.
   */
  closeWindows(): WindowContents[] {
    const now = new Date().toISOString();
    const closed: WindowContents[] = [];

    for (const [service, buf] of this.buffers) {
      if (buf.records.length === 0) continue;

      closed.push({
        service,
        records: buf.records,
        windowStart: buf.windowStart,
        windowEnd: now,
        droppedCount: buf.droppedCount,
      });
    }

    this.buffers.clear();
    return closed;
  }

  /**
   * Flush all windows regardless of state (for graceful shutdown).
   * Same behavior as closeWindows().
   */
  flush(): WindowContents[] {
    return this.closeWindows();
  }

  /** Current buffer stats for metrics reporting. */
  stats(): {
    totalRecords: number;
    serviceCount: number;
    perService: Map<string, number>;
  } {
    let totalRecords = 0;
    const perService = new Map<string, number>();

    for (const [service, buf] of this.buffers) {
      totalRecords += buf.records.length;
      perService.set(service, buf.records.length);
    }

    return {
      totalRecords,
      serviceCount: this.buffers.size,
      perService,
    };
  }

  /**
   * Start the window timer. On each tick, closes all non-empty windows
   * and invokes the provided callback with the closed windows.
   *
   * @returns cleanup function that stops the timer.
   */
  startTimer(onClose: (windows: WindowContents[]) => void): () => void {
    this.onWindowClose = onClose;

    this.timer = setInterval(() => {
      const windows = this.closeWindows();
      if (windows.length > 0 && this.onWindowClose) {
        this.onWindowClose(windows);
      }
    }, this.config.windowMs);

    // Unref so the timer doesn't prevent process exit during shutdown.
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }

    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}
