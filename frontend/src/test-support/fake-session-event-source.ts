/**
 * Controllable fake EventSource for session stream tests.
 * Drives `subscribeSession` without opening a network EventSource.
 */
export class FakeSessionEventSource {
  static instances: FakeSessionEventSource[] = [];

  readonly url: string;
  closeCount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSessionEventSource.instances.push(this);
  }

  close() {
    this.closeCount += 1;
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }
}

/**
 * Replaces global EventSource with FakeSessionEventSource and returns a restore
 * function. Resets the instance list so each session stream test starts clean.
 */
export function installFakeSessionEventSource(): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  FakeSessionEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: FakeSessionEventSource,
  });

  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "EventSource");
    } else {
      Object.defineProperty(globalThis, "EventSource", originalDescriptor);
    }
  };
}
