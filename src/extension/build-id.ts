// The build stamp the popup and the service worker compare (design addendum §3.3). esbuild replaces
// `__JD_BUILD__` in every extension bundle with one ISO timestamp per build (scripts/build.mjs), so
// two bundles from the same build always agree — and a popup from a newer build than the service
// worker still running from the previous one does not, which is the whole point: an unpacked install
// that was updated but never reloaded answers every `readPassages` with `unknown request type`.
//
// `typeof` rather than a bare read is what makes this safe wherever the define never happened (vitest,
// a plain `tsx` import, any bundler that does not know the name): reading an undeclared identifier
// throws a ReferenceError, but `typeof` on one never does.

declare const __JD_BUILD__: string | undefined;

export const BUILD_ID: string = typeof __JD_BUILD__ === 'string' ? __JD_BUILD__ : 'dev';
