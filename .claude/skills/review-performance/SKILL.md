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
2. **One batch read.** Pull all ads in `meta.campaign_id` at ad level in one call. Do not fetch ads one by one.
   - Official MCP: `ads_get_ad_entities` with `level: "ad"`, `filtering: [{field: "campaign_id", operator: "IN", value: [<campaign_id>]}]`, `fields: ["id", "name", "status", "created_time", "amount_spent", "results", "cost_per_result"]`, `date_preset: "maximum"`, `limit` high enough for the campaign. Verify any other field with `ads_get_field_context` first. Follow `next_cursor` if present.
   - Pipeboard: `get_insights` with `object_id` = campaign id and `level: "ad"`.
3. **Normalize.** Keep only ads whose name starts with `AF_` or that are in the ledger. For each ad:
   - `spend` = `amount_spent.value` as a number (account currency, not cents).
   - `conversions`: `results.indicator` must equal `conversions:<meta.conversion_action_type>` or `actions:<meta.conversion_action_type>`. If it names a different event, stop, pause nothing and report the mismatch (the campaign optimizes for something else). If it matches, use the `default` attribution value; `"Not available"` with spend read means 0.
   - Pipeboard: the value of the `actions` or `conversions` entry whose `action_type` equals `meta.conversion_action_type` (0 if absent).
   Write `state/insights/<YYYY-MM-DD>.json` as an array of `{ ad_id, name, status, created_time, spend, conversions }`.
4. **Judge.** Run `node scripts/judge-ads.mjs --insights state/insights/<date>.json`. Do not re-derive verdicts by hand. The rules, in order:
   | Verdict | Condition |
   |---|---|
   | `skip` | ad is not ACTIVE |
   | `learning` | younger than `min_age_days` |
   | `pause` (`no_conversions`) | 0 conversions and spend >= `no_conversion_spend_multiple` x target CPA |
   | `pause` (`cpa_too_high`) | spend >= `high_cpa_spend_multiple` x target and CPA > `high_cpa_ratio` x target |
   | `winner` | conversions >= `winner_min_conversions` and CPA <= `winner_cpa_ratio` x target |
   | `keep` | none of the above |
5. **Pause losers (automatic).** For each `pause`:
   - Official MCP: `ads_update_entity` with `entity_type: "ad"` and `fields: {"status": "PAUSED"}`. In draft mode (`is_draft: true` in the result) the pause is only staged, so publish exactly that ad with `ads_activate_entity` (`entity_id` = the ad id, `object_ids: [<ad_id>]`). Publishing a staged pause applies PAUSED; it does not turn the ad on. Read the ad back once in the next step's batch read to confirm `status: PAUSED`.
   - Pipeboard: `update_ad` with `status: "PAUSED"`.
   `sleep 3` between writes. Update the ledger row with `verdict`, `verdict_at` and the numbers.
6. **Winners.** Mark them in the ledger. If the ad set has at least one winner and total spend is under `budget.daily_budget_cap`, add one `set_daily_budget` approval: current budget up by at most `budget.max_budget_change_pct`, capped at `daily_budget_cap`. Never change a budget directly.
7. **Learnings.** Append a dated entry to `product/learnings.md`: which angles won or lost, with ad names and numbers. Evidence only.
8. Return a summary table (ad, verdict, rule, spend, conversions, CPA) for the report.

## Rules
- Only touch ads the factory owns. Never pause, edit or judge human-made ads.
- A metric you did not read is unknown. Never estimate spend or conversions.
- If the insights call fails, do not pause anything this run.
