// In-memory stand-in for the slice of the `chrome.*` API that storage.ts/background.ts/messages.ts
// touch, so extension unit tests can exercise them without a real browser. `installChromeStub()`
// assigns a fresh instance (empty storage, no listeners) to `globalThis.chrome` — call it again (e.g.
// in `beforeEach`) to reset between tests.

type Listener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void;

/** What `chrome.runtime.getURL('')` resolves against here, i.e. the `sender.origin` every page of
 * this "extension" reports. A content script reports its host page's origin instead. */
export const EXTENSION_ORIGIN = 'chrome-extension://jevduotestextensionid';

/** A single `chrome.storage.local`/`chrome.storage.session` area: get/set/remove/clear, all
 * promise-based (the MV3 form), backed by a plain object. */
function createStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      if (keys === undefined || keys === null) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      }
      // A dictionary of defaults: every named key comes back, falling back to its given default.
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      data = { ...data, ...items };
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear(): Promise<void> {
      data = {};
    },
  };
}

export interface ChromeStub {
  /** Delivers `message` to the registered onMessage listeners with an explicit `sender`, which
   * `chrome.runtime.sendMessage` itself cannot express (it always reports the real caller). Used to
   * exercise background.ts's "this came from a content script" path. */
  dispatch(message: unknown, sender: unknown): Promise<unknown>;
  /** What `chrome.tabs.query` resolves to; the popup reads `[0].id`. */
  setTabs(tabs: Array<{ id?: number }>): void;
}

export function installChromeStub(): ChromeStub {
  const listeners: Listener[] = [];
  let lastError: { message: string } | undefined;
  let tabs: Array<{ id?: number }> = [];

  const runtime = {
    get lastError() {
      return lastError;
    },
    onMessage: {
      addListener(fn: Listener): void {
        listeners.push(fn);
      },
    },
    /** Routes to whichever listener(s) are registered, exactly like a real single-background-page
     * extension: a listener that returns `true` keeps the channel open and must call `sendResponse`
     * itself (possibly asynchronously); one that returns nothing is assumed synchronous. No listener
     * at all mirrors Chrome's "receiving end does not exist" failure via `runtime.lastError`. */
    sendMessage(message: unknown, callback?: (response: unknown) => void): void {
      if (listeners.length === 0) {
        lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        callback?.(undefined);
        lastError = undefined;
        return;
      }
      for (const listener of listeners) {
        const keepAlive = listener(message, {}, (response) => callback?.(response));
        if (keepAlive) return;
      }
      callback?.(undefined);
    },
    getManifest() {
      return { manifest_version: 3, name: 'jev-duo', version: '0.1.0' };
    },
    getURL(p: string) {
      return `${EXTENSION_ORIGIN}/${p}`;
    },
  };

  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: createStorageArea(), session: createStorageArea() },
    runtime,
    tabs: {
      async query(): Promise<Array<{ id?: number }>> {
        return tabs;
      },
    },
  };

  return {
    dispatch(message, sender) {
      return new Promise((resolve) => {
        for (const listener of listeners) {
          const keepAlive = listener(message, sender, resolve);
          if (keepAlive) return;
        }
        resolve(undefined);
      });
    },
    setTabs(next) {
      tabs = next;
    },
  };
}
