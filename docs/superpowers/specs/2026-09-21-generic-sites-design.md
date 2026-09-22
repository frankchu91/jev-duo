# jev-duo — generic sites (design addendum)

Date: 2026-09-21
Status: approved for implementation (owner delegated all design decisions)
Extends: `2026-09-20-jev-duo-design.md`

## 1. Goal

Let the extension work on feed-like pages of any site the user opts into,
without writing a per-site adapter. The three built-in adapters (x, reddit,
hn) stay as they are; a fourth, generic adapter handles everything else.

## 2. Principles

- **Opt-in per site, one click.** The extension never reads a page the user
  has not enabled. Enabling a site is a click in the popup that triggers
  Chrome's own permission prompt for that origin.
- **No `<all_urls>`.** The manifest declares the two optional host patterns
  (`https://*/*`, `http://*/*`) and only ever holds the origins the user
  granted.
- **Same loop, same UI.** A generic post goes through the same judge,
  fold/dim/badge, feedback and stats paths; nothing downstream knows the
  difference except `platform: 'generic'`.
- **Fail-closed on recognition, fail-open on judgment.** If the heuristic
  cannot find a feed it reports zero posts (the popup shows the "0 posts
  seen" line); it never guesses on a page with no repeated structure. Once a
  post is found, judgment errors keep it visible as everywhere else.

## 3. Generic adapter

`platform: 'generic'`; `matches(url)` is true for any URL not owned by a
built-in adapter (the content script only runs where registered, so this is
safe).

**Feed detection (`findPosts`)**:

1. Consider every element that has at least `MIN_SIBLINGS = 4` children that
   share a *signature*: `tagName` plus the sorted class list truncated to the
   first three classes (classes that look generated, i.e. contain digits or
   are longer than 24 characters, are dropped from the signature).
2. A sibling group qualifies when at least 4 members have visible text of
   `MIN_TEXT = 40` characters or more, and the group's median text length is
   at least 40.
3. Among qualifying groups choose the one with the largest number of
   qualifying members; ties go to the largest total text.
4. Return the qualifying members of that group. Outermost-only holds *by
   construction*, not by a filter: every member of a group is a direct child
   of the same parent, so no member can contain another, and nothing
   downstream re-checks it. The landmark rule (`nav`, `header`, `footer`,
   `aside`, `form`) is applied once to the candidate parent, which for the
   same reason is equivalent to applying it to every member.
5. Results are cached per parent for the lifetime of the page and refreshed
   on the observer's rescans (new siblings with the same signature are
   picked up). A different group replaces the cached one only while the
   cached parent is still attached to the document and still has
   `MIN_SIBLINGS` qualifying children of its own, and only when the new
   group has at least twice as many members, to avoid flapping; once the
   cached parent is detached (or no longer qualifies on its own), the next
   qualifying group found anywhere is adopted regardless of size. While the
   cached parent stays attached and healthy, the (comparatively expensive)
   full scan that a replacement check needs is itself throttled to at most
   once every 20 calls or 5 seconds, whichever comes first — every call in
   between is the cheap per-parent recount. The same budget covers the case
   where there is nothing cached at all: a page whose scan found no feed
   (a documentation page, an app shell) is re-scanned at most once every 20
   calls or 5 seconds and returns nothing in between, rather than paying a
   full document scan on every rescan for as long as the tab stays open —
   while the very first call on a page always scans, and a detached or
   thinned cached parent still scans immediately.

**Extraction (`extract`)**: `text` = the element's text with whitespace
collapsed, capped at 2000 chars; `null` when shorter than `MIN_TEXT`.
`id` = `g:<fnv1a(location.host + text.slice(0, 500))>`. `author` = the first
match of `[rel="author"]`, `a[href*="/@"]`, `[class*="author" i]`,
`[data-author]`, trimmed and capped at 60 chars, else undefined.
`meta.hasLink` = an `a[href^="http"]` exists inside; `meta.hasMedia` = an
`img`, `video` or `picture` exists inside; `url` = the first `a[href^="http"]`
that is not the author link, else the page URL.

**Targets**: `[el]`.

## 4. Enabling a site

Manifest: `permissions: ["storage", "activeTab", "scripting"]`,
`optional_host_permissions: ["https://*/*", "http://*/*"]`. The static
`content_scripts` entry for the three built-in sites is unchanged.

Popup section **This site** (below Sites): shows the active tab's origin
(readable thanks to `activeTab` once the popup is open) and one button:

- built-in site → text `built in`, no button;
- not enabled → **Enable on this site**: the click calls
  `chrome.permissions.request({ origins: [origin + '/*'] })` (must run in the
  popup's click handler, Chrome requires a user gesture), then sends
  `{ type: 'enableSite', origin }`;
- enabled → **Disable on this site**: sends `{ type: 'disableSite', origin }`.

Below the button, a list of every enabled generic origin with a `remove`
link (same as disable).

Background handlers:

- `enableSite { origin }`: `chrome.scripting.registerContentScripts([{ id:
  'jd-' + fnv1a(origin), matches: [origin + '/*'], js: ['content.js'], css:
  ['styles.css'], runAt: 'document_idle', persistAcrossSessions: true }])`
  (updating if already registered), then adds the origin to
  `settings.genericSites` (sorted, unique) and saves.
- `disableSite { origin }`: unregisters the script, removes the origin from
  settings, calls `chrome.permissions.remove({ origins: [origin + '/*'] })`
  (ignore failures), saves.
- `isSiteEnabled { platform: 'generic', origin }`: true when
  `settings.genericSites` contains the origin.
- On `init()`, reconcile: for every origin in `settings.genericSites`, if
  `chrome.permissions.contains` is false drop it from settings; otherwise
  ensure the script is registered (`getRegisteredContentScripts` then
  register the missing ones).

`Settings.genericSites: string[]` (default `[]`).

Newly enabled sites need a reload of their open tabs to start judging; the
popup says so after enabling.

## 5. Privacy

Unchanged: post text goes only to the configured provider, keys never reach
content scripts, and the extension holds host permissions only for the
three built-in sites plus the origins the user granted. Disabling a site
revokes its permission.

Disabling only unregisters the content script for *future* page loads: a tab
that already loaded it keeps judging until it is reloaded, exactly mirroring
the reload a newly enabled site needs. The popup says so (`disabled — reload
the tab to stop judging`).

## 6. Testing

- Unit (jsdom): generic adapter on four synthetic pages — a Mastodon-like
  list of `<article>`s (6 posts, 1 nested quoted `<article>` inside a post),
  a forum `ul > li` list with generated class names, a documentation page
  with no repeated blocks (0 posts), and a page whose largest repeated
  group is a `nav > li` menu (must be excluded, the feed below chosen).
  Extraction fields, id stability, outermost-only, author detection.
- Unit: background `enableSite`/`disableSite`/reconcile against a chrome
  stub that implements `permissions.{request,remove,contains}` and
  `scripting.{registerContentScripts,unregisterContentScripts,getRegisteredContentScripts}`;
  `isSiteEnabled` for generic origins.
- Unit: popup **This site** section for the three states, the enable click
  calling `chrome.permissions.request` before `enableSite`, the remove link.
- E2E: a `generic.html` fixture (Mastodon-like feed) served from the fixture
  origin with no `?jd-platform` override; `genericSites` seeded with the
  fixture origin; expect the fixture-mapped posts folded, one kept, and the
  popup's This-site section showing the origin as enabled. Also assert that
  with `genericSites` empty the page shows no fold bars (the gate holds).

## 7. Non-goals

Shadow DOM feeds, single-page apps that render posts without repeated DOM
structure, automatic enabling, Firefox.
