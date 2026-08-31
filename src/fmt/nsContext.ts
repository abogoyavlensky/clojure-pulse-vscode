// Per-document cache of cljfmt-js NsContext handles. The Enter probe formats
// a small window that lacks the file's `ns` form, so alias/refer/ns-name
// resolution must be derived from the whole text and passed alongside — but
// re-deriving on every keystroke would parse the full file each Enter. One
// entry per document, keyed by version; the wiring drops entries on close.

import { NsContext, readNsContext } from "@abogoyavlensky/cljfmt-js";

export interface NsContextCache {
  /** The context for document `key` at `version`; `text` is only called on
   *  a cache miss. */
  contextFor(key: string, version: number, text: () => string): NsContext;
  /** Forgets `key` (document closed). */
  drop(key: string): void;
}

export function createNsContextCache(): NsContextCache {
  const cache = new Map<string, { version: number; ctx: NsContext }>();
  return {
    contextFor(key, version, text) {
      const hit = cache.get(key);
      if (hit && hit.version === version) {
        return hit.ctx;
      }
      const ctx = readNsContext(text());
      cache.set(key, { version, ctx });
      return ctx;
    },
    drop(key) {
      cache.delete(key);
    },
  };
}
