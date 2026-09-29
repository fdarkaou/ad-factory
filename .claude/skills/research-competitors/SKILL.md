---
name: research-competitors
description: Find and track competitor apps and study their Meta ads through the PeekPanda MCP, then write research/competitors.md and research/patterns.md. Use for the first competitor sweep, for the daily delta of new competitor ads, or when the user asks what competitors are running.
---

# Research competitors

Goal: know which competitors matter, what static ads they keep running, and what changed since the last run. Output feeds `make-statics`.

Meta publishes no spend, impressions or results for these ads. **Longevity is the only performance proxy**: an ad that stays live for weeks is probably paying for itself. Never write that a competitor ad "performs", "converts" or "spends" anything.

## Inputs
- `factory.config.json`: `app.app_store_id`, `research.*`
- `state/ledger.json`: `last_research_at`, `competitor_board_id`
- `state/seen-competitor-ads.json`: archive ids already analyzed

## Mode
- **Full** (no `research/competitors.md` yet, or the user asks): steps 1 to 6.
- **Delta** (daily loop): steps 3 to 6, only ads discovered after `last_research_at`.

## Steps

1. **Pick competitors.** If `research.competitor_store_ids` is set, use it. Otherwise call `search_apps` action `similar` with `{ platform: "ios", storeId: <own id> }`. Prefer peers backed by evidence: use `matchReason` when the response has it, otherwise the ordering (apps that share page-one App Store searches come first; same-category fill comes after and is weaker). Then call `search_apps` action `compare` with `storeIds` = own id first, then candidates. Keep at most `research.max_tracked_competitors`, favouring apps with real scale.
2. **Track them.** `boards` action `list`; reuse the board named `research.board_name`, else `manage_boards` action `create`. Add each competitor with `manage_boards` action `add_item` `{ kind: "app", storeId }`. Every write needs a stable `idempotency_key`, e.g. `af-board-<storeId>`. Save the board id to `state/ledger.json` as `competitor_board_id`. Tracking is what makes PeekPanda collect their ads daily. If the answer is `tracked_app_limit`, keep the strongest competitors and say so in the report.
3. **Check coverage.** For each competitor call `get_ads` action `app_intelligence` `{ platform: "ios", storeId }`. Note live ads, new in 7 and 30 days, median and longest run, format mix. If an app has no stored ads, call `request_data` action `request` with `{ kind: "paid_ads" }` and key `af-paid-ads-<storeId>-<YYYYMMDD>`, and treat it as "not collected yet", never as "runs no ads".
4. **Pull ads.** Use `get_ads` action `search`, `limit` up to 40, one call per format in `research.ad_formats`:
   - Evergreen (full mode): `sort: "longest_running"`, `minRunDays: research.min_run_days`, `status: "active"`.
   - Delta: `sort: "recently_discovered"`.
   Scope to competitors with `storeIds` (comma-separated) and, for delta, `discoveredAfter: last_research_at`. If the tool schema does not offer those two filters, scope with `boardId: competitor_board_id` instead and stop paging once you reach archive ids already in `state/seen-competitor-ads.json`.
5. **Look at the statics.** For up to 20 new image ads per run, call `get_ads` action `get` `{ platform: "meta", archiveId }` for media URLs, download each still into `research/ads/<archiveId>.<ext>` (`curl -sL -o ...`), and open it with the Read tool. Analyze what you see, not just the copy: hook text, layout, visual device, offer, CTA, how the product is shown, text density.
6. **Write outputs.**
   - `research/competitors.md`: one section per competitor: store id, why it is a peer (evidence), live ads, new ads in 7/30 days, longest runner, format mix, what they are testing now.
   - `research/patterns.md`: patterns seen in 2 or more long-running ads, grouped as Hooks, Layouts, Offers, Visual devices. Each pattern lists example archive ids with run days and a one-line "how we could use it" that fits `product/usp.md`. Add a dated "New this run" section for the delta.
   - Append analyzed archive ids to `state/seen-competitor-ads.json` and set `last_research_at` in the ledger to the start time of this run.

## Rules
- Never copy a competitor ad. Extract the pattern, then express it with our product, brand and claims.
- Never name competitors in ad copy.
- Keep calls lean. PeekPanda plans have a daily MCP call allowance; one delta run should use well under 30 calls.
- Echo the `conversation_id` PeekPanda returns and do not fire parallel calls before you have it.
