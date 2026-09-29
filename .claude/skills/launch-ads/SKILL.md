---
name: launch-ads
description: Upload ready static creatives to Meta through the Meta Ads MCP as PAUSED ads, record them in state/ledger.json and request activation in state/approvals.md. Also executes approvals the human has ticked. Use after make-statics, or when the user asks to launch, activate or apply approved ads.
---

# Launch ads

Creates ads **paused**. Nothing goes live and no budget changes without a ticked approval.

## Inputs
- Briefs with `status: "ready"` under `creatives/<date>/*/brief.json`
- `factory.config.json`: `meta.*`, `app.app_store_url`, `creative.launch_aspect`, `meta_api.*`
- `state/ledger.json`, `state/approvals.md`

## Before any write
1. Read `state/meta-cooldown.json`. If `until` is in the future, stop and report it.
2. Read the ledger. An ad whose `name` is already there with an `ad_id` is done; skip it. A row with a `creative_id` but no `ad_id` resumes at step 3 below.
3. One batch read to catch ads created outside the ledger: list ads in `meta.test_ad_set_ids` (official MCP: `ads_get_ad_entities`; Pipeboard: `get_ads`) and match by name.

## Naming
`AF_<YYYYMMDD>_<angle-slug>_<concept-id>_<aspect>`, e.g. `AF_20260115_morning-rush_c01_4x5`. Creative name is the same with `_cr`. The `AF_` prefix is how the factory knows which ads it owns.

## Flow per ready brief (official Meta Ads MCP, default)
Launch one ad per brief using the `creative.launch_aspect` final. Other ratios stay on disk for later placement work.

The official server runs in **draft mode**: `ads_create_ad` stages the ad in the account's Ads Manager draft (status `DRAFT`) and nothing serves until it is published with `ads_activate_entity`. Publishing is the activation step and always needs a ticked approval.

1. **Image.** `ads_creative_upload_media` with `upload_source: "URL"`, `media_type: "IMAGE"`, `media_url` = the Genviral `output_url` of the final, `name` = the ad name. Keep the returned image hash in the ledger. (`ads_create_creative` also accepts `image_url` directly; the hash keeps the image in the library and makes reruns cheap.)
2. **Creative.** `ads_create_creative` with `ad_account_id` (numeric, no `act_`), `page_id`, `image_hash`, `link_url` = `app.app_store_url`, `message` (primary text), `headline`, `call_to_action_type` = `meta.call_to_action` (e.g. `INSTALL_MOBILE_APP`), `name` = ad name + `_cr`, `instagram_user_id` if configured, and `self_ai_disclosure` = `meta.ai_disclosure` from config (`OPT_IN` or `OPT_OUT`; it cannot be changed later, and the choice is the advertiser's, never yours). If the tool rejects the App Store link or the CTA, stop, record the exact error and do not retry in a loop.
3. **Ad.** `ads_create_ad` with the ad set id (first of `meta.test_ad_set_ids` with room under `creative.max_active_ads_per_ad_set`), `creative: "{\"creative_id\":\"<id>\"}"`, `ad_name`, and `hide_ui: true` when creating several. Record the returned ad id and `status: "DRAFT"` (or `PAUSED` if the server is not in draft mode). Surface any `active_errors`.
4. **Record.** After each successful write, immediately write the returned id into the ledger row (`image_hash`, `creative_id`, then `ad_id`, `status`, `created_at`). Then `sleep 3` in Bash before the next write.
5. **Ask.** Append one activation request per ad to `state/approvals.md`.

## Flow with Pipeboard (alternative)
`upload_ad_image` (`account_id`, `image_url` = Genviral `output_url`) returns `image_hash`; `create_ad_creative` (`image_hash`, `page_id`, `link_url`, `message`, `headline`, `call_to_action_type`); `create_ad` with `status: "PAUSED"`. Same ledger and pacing rules.

## Approvals file
`state/approvals.md` has a `## Pending` and a `## Done` section. One line per request:
```
- [ ] APR-20260115-01 | activate_ad | ad_id=123 name=AF_20260115_morning-rush_c01_4x5 | why: new creative, passed self-review
- [ ] APR-20260115-02 | set_daily_budget | adset_id=456 50 -> 60 USD (+20%) | why: 2 winners at CPA 14.10 vs target 20
```
The human approves by changing `[ ]` to `[x]`, or by telling Claude "approve APR-20260115-01". Anything else stays pending. Requests older than 7 days move to Done as `expired`.

## Applying approvals
Run this at the start of every daily loop and whenever the user asks.
- `activate_ad`: official `ads_activate_entity` (for a draft ad pass `object_ids: [<ad_id>]`; it publishes ACTIVE under the live ad set; report `PUBLISHING` as handed off, not live); Pipeboard `update_ad` with `status: "ACTIVE"`. Skip if the ad was paused by a kill rule since the request.
- `set_daily_budget`: official `ads_update_entity` on the ad set (in draft mode also publish that ad set with `ads_activate_entity` and `object_ids: [<ad_set_id>]`); Pipeboard `update_adset` with `daily_budget` (minor units, e.g. cents). Refuse if the new value breaks `budget.daily_budget_cap` or `budget.max_budget_change_pct`, even if ticked.
- Move the line to `## Done` with the result and timestamp. Pace writes 3 seconds apart.
