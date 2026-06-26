/**
 * Minimal stand-in for the parts of the `vscode` API that our unit-tested
 * modules touch at runtime. Loaded via module aliasing in `.mocharc.json`'s
 * setup so tests can run in plain Node without the Electron host.
 */

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** In-memory implementation of the subset of `Memento` we rely on. */
export class FakeMemento {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

/** Builds a fake ExtensionContext exposing a globalState memento. */
export function createFakeContext(): { globalState: FakeMemento } {
  return { globalState: new FakeMemento() };
}
