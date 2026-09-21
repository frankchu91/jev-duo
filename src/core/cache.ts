import type { Item, QuestionPack } from './types';

/** Fixed-capacity LRU cache backed by a `Map`, whose keys iterate oldest -> newest. `get`/`set` both touch (re-insert) a key to mark it most-recently-used; `has` does not. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(k: string): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k) as V;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(k: string): boolean {
    return this.map.has(k);
  }

  get size(): number {
    return this.map.size;
  }

  entries(): [string, V][] {
    return [...this.map.entries()];
  }
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256(pack.compiledAt + '|' + item.id + '|' + item.text) as lowercase hex, via the Web Crypto API
 * (`globalThis.crypto.subtle`, not `node:crypto`) so this runs unchanged in Node 20+ and in a browser
 * extension service worker. */
export async function verdictKey(pack: QuestionPack, item: Item): Promise<string> {
  const input = `${pack.compiledAt}|${item.id}|${item.text}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}
