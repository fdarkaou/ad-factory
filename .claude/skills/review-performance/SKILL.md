---
name: review-performance
description: Pull per-ad Meta insights for the factory's ads, apply the kill rules from factory.config.json deterministically with scripts/judge-ads.mjs, pause losers, flag winners and propose budget changes as approvals. Use at the start of the daily loop or when the user asks how the ads are doing.
---

# Review performance

## Inputs
- `factory.config.json`: `targets.target_cpa`, `kill_rules.*`, `meta.conversion_action_type`, `cadence.insights_window_days`, `budget.*`
- `state/ledger.json` (the ads the factory owns)

## Steps

1. **Cooldown check.** Stop if `state/meta-cooldown.json` says so.
2. **One batch read.** Pull all ads in `meta.campaign_id` at ad level for the lifetime of each ad (or `cadence.insights_window_days` if lifetime is not offered), with spend, actions and created time.
   - Official MCP: `ads_get_ad_entities` for ads in the campaign with spend, conversions and a date range.
   - Pipeboard: `get_insights` with `object_id` = campaign id and `level: "ad"`.
   Do not fetch ads one by one.
3. **Normalize.** Keep only ads whose name starts with `AF_` or that are in the ledger. Conversions = the value of the `actions` entry whose `action_type` equals `meta.conversion_action_type` (0 if absent). Write `state/insights/<YYYY-MM-DD>.json` as an array of `{ ad_id, name, status, created_time, spend, conversions }`. Spend is in account currency, not cents.
4. **Judge.** Run `node scripts/judge-ads.mjs --insights state/insights/<date>.json`. Do not re-derive verdicts by hand. The rules, in order:
   | Verdict | Condition |
   |---|---|
   | `skip` | ad is not ACTIVE |
   | `learning` | younger than `min_age_days` |
   | `pause` (`no_conversions`) | 0 conversions and spend >= `no_conversion_spend_multiple` x target CPA |
   | `pause` (`cpa_too_high`) | spend >= `high_cpa_spend_multiple` x target and CPA > `high_cpa_ratio` x target |
   | `winner` | conversions >= `winner_min_conversions` and CPA <= `winner_cpa_ratio` x target |
   | `keep` | none of the above |
5. **Pause losers (automatic).** For each `pause`: official `ads_update_entity` with status `PAUSED`; Pipeboard `update_ad` with `status: "PAUSED"`. `sleep 3` between writes. Update the ledger row with `verdict`, `verdict_at` and the numbers.
6. **Winners.** Mark them in the ledger. If the ad set has at least one winner and total spend is under `budget.daily_budget_cap`, add one `set_daily_budget` approval: current budget up by at most `budget.max_budget_change_pct`, capped at `daily_budget_cap`. Never change a budget directly.
7. **Learnings.** Append a dated entry to `product/learnings.md`: which angles won or lost, with ad names and numbers. Evidence only.
8. Return a summary table (ad, verdict, rule, spend, conversions, CPA) for the report.

## Rules
- Only touch ads the factory owns. Never pause, edit or judge human-made ads.
- A metric you did not read is unknown. Never estimate spend or conversions.
- If the insights call fails, do not pause anything this run.
