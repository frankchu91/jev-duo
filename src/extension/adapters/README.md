# Site adapters

Each adapter implements `Adapter` (`types.ts`): `matches(url)` picks it for a page, `findPosts(root)`
lists every candidate post currently in `root`, `extract(el)` turns one post into a judgeable `Item`
(or `null` when it isn't judgeable yet), and `targets(el)` lists the element(s) `ui/fold.ts` should
fold/dim/badge for that post.

Selectors below were confirmed on **2026-09-21** — live fetch for Hacker News, a Wayback capture
(2026-07-31) for Reddit, and code-level agreement across seven open-source X extensions for X (X
itself could not be fetched directly: login + JS-rendered). Full sourcing and raw captures live in
`docs/superpowers/research/selectors.md`. The fixtures in `tests/e2e/fixtures/{x,reddit,hn}.html` were
authored from that same research pass and are the source of truth the adapter tests run against; if a
site changes its markup, re-run the research, update the fixture, and the fixture + this file move
together.

## x.com / twitter.com / pro.x.com (`x.ts`)

| Field | Selector |
|---|---|
| Post container | `article[data-testid="tweet"]`, outermost only (`!el.parentElement?.closest('article[data-testid="tweet"]')` — excludes a quote-tweet's nested article) |
| Text | first `[data-testid="tweetText"]`; a second one (a quoted tweet) is appended as `\n\n[quoted] <text>`, whole thing capped at 1000 chars; empty primary text → `extract` returns `null` |
| Author | inside `[data-testid="User-Name"]`: the first descendant `[tabindex="-1"]` textContent, else the first line of the block's own textContent |
| Id | `x:<digits>` from `/status\/(\d+)/` on an `a[href*="/status/"]` that contains a `<time>`, else any `a[href*="/status/"]`, else `x:h<fnv1a(text)>` |
| Url | `https://x.com/<handle>/status/<id>` when both the handle and the real status id are known |
| Promoted | `!!el.closest('[data-testid="placementTracking"]')` |
| Reply | some `div[dir]` whose own text starts with `Replying to` |
| Media | `[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]` present |
| Link | `a[href^="http"]` inside the primary text element, or `[data-testid="card.wrapper"]` present |
| targets | `[el]` |

## reddit.com (`reddit.ts`)

`shreddit-post` custom elements carry everything as attributes; ads are the separate tag
`shreddit-ad-post` and are never selected.

| Field | Selector |
|---|---|
| Post container | `shreddit-post` |
| Title | `post-title` attribute, else `a[slot="title"]` textContent; missing/empty → `null` |
| Body | `[slot="text-body"]` textContent, trimmed, capped at 1500 chars |
| Text | title + (`\n\n` + body, if any) |
| Id | `reddit:<id attribute>` (e.g. `reddit:t3_1vbp0vm`), else `reddit:h<fnv1a(text)>` |
| Author | `author` attribute |
| Url | `permalink` attribute resolved against `https://www.reddit.com` |
| Meta | `score`/`comment-count` attributes; `hasLink` = `post-type === 'link'`; `hasMedia` = `post-type` in `image`/`video`/`gallery` |
| targets | `[el]` |

## news.ycombinator.com (`hn.ts`)

A story is three sibling rows: `tr.athing.submission`, its subtext `<tr>`, and a `tr.spacer`.

| Field | Selector |
|---|---|
| Post container | `tr.athing.submission` |
| Title link | `.titleline > a` (child combinator — `.titleline a` would also match the domain link) |
| Domain | `.titleline .sitestr` textContent |
| Text | title + ` (<domain>)` when a domain is present |
| Id | `hn:<row id attribute>` |
| Subtext row | `el.nextElementSibling`, kept only if it contains `td.subtext` |
| Score / author / comments | `.score` (parseInt; absent on job rows), `a.hnuser`, last `a[href^="item?id="]` text (`discuss` → 0 comments) |
| Link | `hasLink` = the title url does not start with `item?id=` (i.e. not a self post) |
| targets | `[row, subtextRow, spacerRow]`, filtered to whichever of those actually exist |
