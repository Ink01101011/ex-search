import { deserialize, serialize } from 'v8';
import { runInNewContext } from 'vm';
import { __WORKER_SOURCE__ } from '../../src/core/search';

/** Deep-clones like the structured clone algorithm; throws on functions / symbols, like a browser. */
export function cloneLikeBrowser<T>(value: T): T {
  return deserialize(serialize(value)) as T;
}

// Under `jest --coverage` the serialised worker source contains istanbul
// counters (`cov_xxx().s[0]++`). Give the isolated context inert stand-ins so
// the real source still runs end to end.
const inert: unknown = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : inert),
  set: () => true,
  apply: () => inert,
});

export interface WorkerSelf {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (m: unknown) => void;
}

/** Evaluates `source` (default: the library's real worker source) in a fresh V8 context. */
export function runWorkerSource(self: WorkerSelf, source: string = __WORKER_SOURCE__, extra: object = {}): void {
  const sandbox: Record<string, unknown> = { self, ...extra };
  for (const name of new Set(source.match(/cov_[A-Za-z0-9]+/g) ?? [])) sandbox[name] = () => inert;
  runInNewContext(source, sandbox);
}

export type FakeWorkerMode = 'ok' | 'ctor-throws' | 'post-throws' | 'error' | 'hang';

/** A browser-like Worker that runs the library's real worker source in an isolated context. */
export class FakeWorker {
  static mode: FakeWorkerMode = 'ok';
  static all: FakeWorker[] = [];
  static reset(mode: FakeWorkerMode = 'ok'): void {
    FakeWorker.mode = mode;
    FakeWorker.all = [];
  }

  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  private readonly inner: WorkerSelf;

  constructor(readonly url: string) {
    if (FakeWorker.mode === 'ctor-throws') throw new Error('SecurityError: worker blocked');
    FakeWorker.all.push(this);
    this.inner = {
      onmessage: null,
      postMessage: (m) => {
        const data = cloneLikeBrowser(m);
        queueMicrotask(() => {
          if (!this.terminated) this.onmessage?.({ data });
        });
      },
    };
    runWorkerSource(this.inner);
  }

  postMessage(m: unknown): void {
    const data = cloneLikeBrowser(m); // DataCloneError for functions / symbols
    if (FakeWorker.mode === 'post-throws') throw new Error('DataCloneError');
    if (FakeWorker.mode === 'hang') return;
    if (FakeWorker.mode === 'error') {
      queueMicrotask(() => {
        if (!this.terminated) this.onerror?.(new Error('worker crashed'));
      });
      return;
    }
    queueMicrotask(() => {
      if (!this.terminated) this.inner.onmessage?.({ data });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Installs the fake as the global Worker and stubs the Blob URL API when missing. */
export function installFakeWorker(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prevWorker = g.Worker;
  const urlApi = URL as unknown as Record<string, unknown>;
  const prevCreate = urlApi.createObjectURL;
  g.Worker = FakeWorker;
  urlApi.createObjectURL = () => 'blob:fake';
  return () => {
    if (prevWorker === undefined) delete g.Worker;
    else g.Worker = prevWorker;
    urlApi.createObjectURL = prevCreate;
  };
}
