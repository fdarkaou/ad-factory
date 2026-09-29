---
name: daily-loop
description: Run one full ad-factory cycle - apply approvals, review performance, research new competitor ads, pick next angles, make statics, launch them paused and write reports/<date>.md. Use when the user says "run the daily loop", from a scheduled routine, or from cron.
---

# Daily loop

One run per day per ad account. Works the same attended or unattended: the approval gates do not change.

## 0. Preflight
- `factory.config.json` exists and parses; `GENVIRAL_API_KEY` is set (`test -n "$GENVIRAL_API_KEY"`, never print it).
- The PeekPanda and Meta Ads MCP tools are available. If one is missing or needs sign-in, stop and write that in the report.
- **Lock.** If `state/run-lock.json` exists with `started_at` under 3 hours old, another run owns this ad account: stop. Otherwise write `{ "started_at": <now>, "ad_account_id": ... }`. Delete it at the end, also on failure.
- **Cooldown.** If `state/meta-cooldown.json` has `until` in the future, skip every Meta step and say so in the report.
- Create `state/ledger.json` if missing: `{ "version": 1, "last_run_at": null, "last_research_at": null, "competitor_board_id": null, "ads": [] }`.

## 1. Apply approvals
Follow "Applying approvals" in the `launch-ads` skill.

## 2. Review performance
Run the `review-performance` skill.

## 3. Research delta
Run `research-competitors` in delta mode. If `research/competitors.md` does not exist yet, run full mode.

## 4. Decide angles
Free slots = `creative.new_ads_per_run`, reduced so no test ad set goes over `creative.max_active_ads_per_ad_set` (count active plus paused-awaiting-approval factory ads). If zero, skip steps 5 and 6.
Fill slots in this order, each with written evidence:
1. **Exploit** (`angles_per_run.exploit`): new variations of winning angles. Change one thing: hook, layout or visual device.
2. **Competitor pattern**: a long-running pattern from `research/patterns.md` we have not tested, adapted to our USP.
3. **Explore** (`angles_per_run.explore`): an untested row from `product/pains-and-benefits.md`.
Never relaunch an angle that was paused twice without a new reason in `learnings.md`.

## 5. Make statics
Run `make-statics` for the chosen angles.

## 6. Launch
Run `launch-ads` for briefs with `status: "ready"`.

## 7. Report
Write `reports/<YYYY-MM-DD>.md`:
```
# Ad factory report YYYY-MM-DD
## Needs your approval        (every pending APR line, with why; say how to approve)
## Paused today               (ad, rule, spend, conversions, CPA)
## Winners                    (ad, conversions, CPA vs target)
## Launched (paused)          (ad names, angle, source, evidence)
## Competitors                (new ads since last run, notable long runners, new patterns)
## Spend and cost             (spend read from Meta for the window; Genviral credits used this run)
## Problems                   (errors, skipped steps, cooldowns, missing data)
```
Numbers come only from tool results made in this run. Set `last_run_at` in the ledger, remove the lock, and end with a three-line summary in chat that starts with the number of pending approvals.
