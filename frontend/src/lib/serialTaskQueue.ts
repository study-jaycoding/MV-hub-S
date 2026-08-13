export interface SerialTaskQueueState {
  active: boolean;
  queued: number;
  total: number;
}

/** 화면을 막지 않고 받은 작업을 한 번에 하나씩 실행한다. */
export class SerialTaskQueue<T> {
  private readonly items: T[] = [];
  private draining = false;
  private active = false;

  constructor(
    private readonly worker: (item: T) => Promise<void>,
    private readonly onState: (state: SerialTaskQueueState) => void,
    private readonly onError: (error: unknown, item: T) => void,
  ) {}

  snapshot(): SerialTaskQueueState {
    return {
      active: this.active,
      queued: this.items.length,
      total: this.items.length + (this.active ? 1 : 0),
    };
  }

  enqueue(item: T): void {
    this.items.push(item);
    this.emit();
    void this.drain();
  }

  private emit(): void {
    this.onState(this.snapshot());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length) {
        const item = this.items.shift()!;
        this.active = true;
        this.emit();
        try {
          await this.worker(item);
        } catch (error) {
          this.onError(error, item);
        } finally {
          this.active = false;
          this.emit();
        }
      }
    } finally {
      this.draining = false;
      // onState/onError 같은 외부 콜백에서 작업이 추가된 경우도 놓치지 않는다.
      if (this.items.length) void this.drain();
    }
  }
}
