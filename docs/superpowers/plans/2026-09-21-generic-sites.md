# Generic sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let jev-duo judge feed-like pages on any site the user opts into, through one generic adapter plus a per-site permission flow, without per-site code.

**Architecture:** A fourth adapter (`generic`) finds the largest group of structurally repeated sibling blocks and treats each as a post. The manifest gains `activeTab`, `scripting` and optional host permissions; the popup requests an origin's permission on click and the background registers `content.js` for that origin with `chrome.scripting.registerContentScripts`. The content script's site gate asks `isSiteEnabled` with the page origin; everything downstream is unchanged.

**Tech Stack:** as the main plan (TypeScript strict ESM, vitest + jsdom, Playwright, esbuild, Manifest V3).

**Spec:** `docs/superpowers/specs/2026-09-21-generic-sites-design.md` (extends `2026-09-20-jev-duo-design.md`).

## Global Constraints

- `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` green after every task; every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The three built-in adapters and their fixtures are untouched. `Adapter.platform` widens to `'x' | 'reddit' | 'hn' | 'generic'`; `SiteId` (the three popup toggles) stays as is; a new `PagePlatform = SiteId | 'generic'` is used by `isSiteEnabled` and `pageSeen`.
- Heuristic constants (exact): `MIN_SIBLINGS = 4`, `MIN_TEXT = 40`, generated-class rule = contains a digit or longer than 24 chars, signature = tagName + first three surviving classes sorted, replacement rule = a new group replaces the cached one only with at least twice as many members, excluded ancestors = `nav, header, footer, aside, form`.
- Ids: `g:<fnv1a(location.host + text.slice(0, 500))>`; author capped at 60 chars; text capped at 2000.
- Manifest after Task 2: `permissions: ["storage", "activeTab", "scripting"]`, `optional_host_permissions: ["https://*/*", "http://*/*"]`; static `content_scripts` and `host_permissions` unchanged.
- Registered script id = `'jd-' + fnv1a(origin)` (decimal), `matches: [origin + '/*']`, `js: ['content.js']`, `css: ['styles.css']`, `runAt: 'document_idle'`, `persistAcrossSessions: true`.
- `Settings.genericSites: string[]` (origins, sorted, unique; default `[]`). `chrome.permissions.request` is called only from the popup click handler.
- Fail-closed recognition (no feed → zero posts), fail-open judgment (unchanged).

---

### Task 1: Generic adapter, platform widening, origin-aware site gate

**Files:**
- Create: `src/extension/adapters/generic.ts`, `tests/unit/extension/generic-adapter.test.ts`, `tests/e2e/fixtures/generic.html`
- Modify: `src/extension/adapters/types.ts` (platform union), `src/extension/adapters/index.ts` (fallback), `src/extension/messages.ts` (`PagePlatform`, `Settings.genericSites`, `isSiteEnabled` gains `origin?: string`, `pageSeen`/`PageSeenReport` use `PagePlatform`), `src/extension/content.ts` (`boot` sends `origin: location.origin`), `src/extension/background.ts` (`isSiteEnabled` for `generic` checks `settings.genericSites.includes(origin)`; `pageSeen` accepts generic; `DEFAULT_SETTINGS.genericSites = []`), `src/extension/popup/popup.ts` only if the type change breaks compilation (no UI yet), existing tests that construct `Settings` literals.
- Test: the new unit file plus updated `content.test.ts`/`background.test.ts` cases.

**Interfaces:**
- Produces: `export const genericAdapter: Adapter` (`platform: 'generic'`, `matches: () => true`); `pickAdapter(url)` returns a built-in adapter when one matches, else `genericAdapter` (the `jd-platform` override still wins; an unknown override value falls through to hostname matching, then generic). `export type PagePlatform = SiteId | 'generic'`. Request `{ type: 'isSiteEnabled'; platform: PagePlatform; origin?: string }`.

- [ ] **Step 1: Fixture `tests/e2e/fixtures/generic.html`** — a Mastodon-like timeline: `<main><div class="timeline">` containing six `<article class="status status-public">` each with `<a class="display-name" href="/@user">Name</a>`, `<div class="status__content"><p>…</p></div>`, one of them containing a nested `<article class="status quoted">` (must not be counted), an `<img>` in one, an external `<a href="https://…">` in one; plus `<nav><ul><li>` with five short menu items (a repeated group that must lose to the feed) and a `<footer>`. Texts: two crypto shills, one ragebait, one about Rust (kept), two neutral — each ≥ 60 chars.
- [ ] **Step 2: Failing tests** `generic-adapter.test.ts` (jsdom): (a) on the fixture, `findPosts` returns exactly 6 outermost articles (the nested quote excluded; the nav items excluded); (b) `extract` gives `platform 'generic'`, `id` starting with `g:` and stable across two calls, `author` from `.display-name`, `hasMedia` true only for the post with the image, `hasLink` true only for the post with the external link, `url` = that link for it and `location.href` otherwise; (c) a forum page built inline (`<ul class="threads"><li class="thread thread-4821 css-1x9f3k">…` × 7 with generated classes) → 7 posts, proving generated classes are dropped from the signature; (d) a documentation page inline (headings and paragraphs, no group of ≥ 4 similar siblings with ≥ 40 chars) → 0 posts; (e) a page whose largest repeated group is a `nav > li` menu with long labels and a smaller real feed of 4 posts below → the feed wins; (f) `pickAdapter(new URL('https://mastodon.social/home'))` is the generic adapter, `pickAdapter(new URL('https://x.com/home'))` is still x; (g) the cache/replacement rule: after 6 more articles are appended, `findPosts` returns 12; a competing group of 7 elsewhere does not replace it (needs ≥ 12).
- [ ] **Step 3: Implement `generic.ts`** exactly per spec §3 (signature, qualification, choice, outermost-only, ancestor exclusion, cache + replacement rule, extraction). Keep under ~140 lines; pure DOM, no chrome APIs.
- [ ] **Step 4: Wire** `index.ts` fallback; widen types; `content.ts` `boot` passes `origin`; `background.ts` gate; `DEFAULT_SETTINGS.genericSites`. Update `content.test.ts` (`boot` sends `origin`) and `background.test.ts` (`isSiteEnabled` for `generic` true only when the origin is in `genericSites`; the three built-ins unchanged).
- [ ] **Step 5:** `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` green. **Commit:** `feat(extension): generic feed adapter and origin-aware site gate`.

---

### Task 2: Permission flow and dynamic registration in the background

**Files:**
- Modify: `src/extension/manifest.json`, `src/extension/messages.ts` (requests `enableSite`/`disableSite`, responses), `src/extension/background.ts`, `tests/unit/extension/chrome-stub.ts`, `tests/unit/extension/background.test.ts`
- Test: new background cases.

**Interfaces:**
- Produces: `Request` gains `{ type: 'enableSite'; origin: string }` and `{ type: 'disableSite'; origin: string }`; `Response` gains `{ ok: true; type: 'enableSite' | 'disableSite'; genericSites: string[] }`. `getState` unchanged (settings already carry `genericSites`).
- Chrome stub gains `chrome.permissions.{request, remove, contains}` (in-memory granted-origin set; `request` resolves true unless the test flips a `denyNext` flag) and `chrome.scripting.{registerContentScripts, unregisterContentScripts, getRegisteredContentScripts}` (in-memory registry keyed by id; `registerContentScripts` rejects on a duplicate id unless the caller unregisters first — mirror Chrome: use `updateContentScripts` or unregister-then-register; the implementation should call `getRegisteredContentScripts({ ids })` first and `updateContentScripts` when present).

- [ ] **Step 1: Failing tests**: (a) `enableSite` registers a script with the exact spec shape (id `jd-<fnv1a(origin)>`, matches `origin/*`, js/css, runAt, persistAcrossSessions) and adds the origin to `settings.genericSites` (sorted, unique; enabling twice is idempotent and does not double-register); (b) `disableSite` unregisters, removes from settings, calls `permissions.remove` with `{ origins: [origin + '/*'] }` and tolerates `permissions.remove` rejecting; (c) reconcile on `init()`: a stored origin whose permission is absent is dropped; a stored origin with permission but no registration gets registered; a registered script for an origin no longer in settings is unregistered; (d) `enableSite` from a content-script sender (`sender.tab` set and origin not the extension's) is refused like `getState` (only the popup may change sites); (e) `isSiteEnabled` `{ platform: 'generic', origin }` is true after `enableSite` and false after `disableSite`.
- [ ] **Step 2: Implement** per spec §4; manifest permissions/optional_host_permissions; the `getState`-style sender guard reused for `enableSite`/`disableSite`/`setSettings`? — only `enableSite`/`disableSite` (ruling: keep the scope tight).
- [ ] **Step 3:** green suites; the e2e helper's manifest patch must still work (it appends to `content_scripts[0].matches` and `host_permissions`). **Commit:** `feat(extension): per-site permission flow with dynamic content-script registration`.

---

### Task 3: Popup "This site" section, generic e2e, docs

**Files:**
- Modify: `src/extension/popup/popup.html`, `popup.ts`, `popup.css`, `tests/unit/extension/popup.test.ts`, `tests/unit/extension/chrome-stub.ts` (tabs.query returns `url`), `tests/e2e/extension.spec.ts`, `tests/e2e/helpers.ts` (if a helper is needed), `README.md`, `docs/superpowers/specs/2026-09-20-jev-duo-design.md` (§5 pointer to the addendum), `CONTRIBUTING.md` (fixture rule mentions generic.html).

**Interfaces:**
- Consumes: `enableSite`/`disableSite`, `settings.genericSites`, `chrome.tabs.query` (`url` available via `activeTab`), `chrome.permissions.request`.

- [ ] **Step 1: Failing popup tests**: the section `#this-site` shows `#site-origin` text = the active tab's origin; state `built in` for `https://x.com/home` (no button); state not-enabled for `https://mastodon.social/home` → `#site-toggle` reads `Enable on this site`; clicking it calls `chrome.permissions.request({ origins: ['https://mastodon.social/*'] })` BEFORE sending `enableSite`, and when the request resolves false nothing is sent and `#site-status` says permission was declined; after `enableSite` resolves, the button reads `Disable on this site`, `#site-status` says `enabled — reload the tab to start judging`, and `#generic-sites` lists the origin with a `remove` link that sends `disableSite`; a `chrome://` or `about:` tab shows `not a web page` and no button.
- [ ] **Step 2: Implement** the section (below Sites), styles consistent with the rest.
- [ ] **Step 3: E2E** in `extension.spec.ts`: new tests (serial, after the existing ones): seed `genericSites: [FIXTURE_ORIGIN]` and fixture-map probabilities for the generic ids — derive the ids by loading the fixture in the test's own jsdom? No: compute them with the real adapter is not available in Playwright; instead seed `mockFixtures` keyed by the ids printed by a one-off `page.evaluate` in the first generic test that reads `data-jd-id` attributes… — simpler ruling: content.ts already sets nothing on the element; add `data-jd-id="<item.id>"` to judged elements in `content.ts` (one attribute, harmless) so tests and users can find items; the test opens `generic.html` (no `jd-platform`), waits for 6 judged elements, then reads their ids, seeds fixtures accordingly, reloads, and asserts 3 `.jd-bar` and one `kept` tag; a second test seeds `genericSites: []`, reloads and asserts zero `.jd-bar`/`.jd-tag` and that `#page-seen` in the popup is not rendered for it (the content script never started). Keep the built-in site tests unchanged.
- [ ] **Step 4: Docs**: README — new section "Other sites" (how to enable, what the heuristic needs, privacy note, reload the tab), permissions list updated, known limits (shadow DOM, SPA without repeated DOM); spec §5 pointer; CONTRIBUTING fixture rule.
- [ ] **Step 5:** all suites green (`pnpm test:e2e` and `LIVE=1`), `pnpm package:ext` works. **Commit:** `feat(extension): enable jev-duo on any site from the popup` and `docs: other sites`.

## Self-review

- Spec coverage: §3 → Task 1; §4 → Tasks 2–3; §5 → Task 3 docs; §6 → tests in every task.
- Placeholders: none; the e2e id-seeding question is ruled in Task 3 Step 3 (`data-jd-id`).
- Type consistency: `PagePlatform`, `genericSites`, `enableSite`/`disableSite` names are used identically across tasks.
