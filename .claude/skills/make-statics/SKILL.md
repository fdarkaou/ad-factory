---
name: make-statics
description: Turn ad angles into finished static Meta ad images through the Genviral API (GPT Image 2.5 Flare for cheap concepts, Sunburst for finals), self-review them and save them with a brief. Use when the daily loop needs new creatives or the user asks for new static ads for an angle.
---

# Make statics

Each angle becomes one creative folder: `creatives/<YYYY-MM-DD>/<concept-id>/` with `brief.json`, concept images and final images per aspect ratio.

## Inputs
- Angles from `daily-loop` (or the user): name, source (`exploit`, `competitor_pattern`, `explore`), evidence.
- `product/*.md` and `product/assets/*`
- `research/patterns.md`, `product/learnings.md`
- `factory.config.json`: `image_models`, `creative.*`

## Steps

1. **Brief.** Write `brief.json` before generating anything:
   ```json
   {
     "id": "c01", "date": "2026-01-15", "angle": "slug-of-angle",
     "source": "exploit | competitor_pattern | explore",
     "evidence": ["ad names, pattern ids or file lines this angle is based on"],
     "hypothesis": "why this should beat the current ads",
     "moment": "the customer moment from icp.md",
     "on_image_text": { "headline": "max 7 words", "subline": "optional, max 10 words" },
     "visual": "what the image shows, layout, where text sits",
     "references": ["product/assets/app-icon-1024.png", "product/assets/screen-x.png"],
     "meta_copy": { "primary_text": "...", "headline": "...", "cta": "INSTALL_MOBILE_APP" },
     "aspect_ratios": ["1:1", "4:5", "9:16"],
     "status": "draft"
   }
   ```
   Copy must use only facts from `product/*.md`. No invented numbers, ratings, prices or testimonials.
2. **Prompt.** Build the prompt from the brief: exact on-image text in double quotes, brand hex colors and type from `brand.md`, layout and safe zones (keep text out of the top 14% and bottom 20% for 9:16), and this line whenever a screenshot is attached: "Use the attached app screenshot exactly as the phone screen content. Do not redraw, add or invent any interface." Save it as `prompt.txt`.
3. **Concepts (cheap).** Generate `creative.concepts_per_angle` variants at `creative.launch_aspect` with `image_models.concept`:
   ```bash
   node scripts/genviral-image.mjs --model openai/gpt-image-2.5-flare --quality low --size 1K \
     --aspect 4:5 --prompt-file creatives/<date>/c01/prompt.txt \
     --ref product/assets/logo.png --ref product/assets/screen-x.png \
     --key <date>-c01-concept-1 --out creatives/<date>/c01/concept-1.png
   ```
   Vary composition between variants by editing one line of the prompt, not the offer. Open each image with Read and pick the strongest one. If none passes the checklist below, mark the brief `rejected` with the reason and stop.
4. **Finals.** Regenerate the chosen concept with `image_models.final` for every ratio in `creative.aspect_ratios`, passing the chosen concept image as the first `--ref` plus the brand assets. Save as `final-1x1.png`, `final-4x5.png`, `final-9x16.png`. Use a stable `--key` per file so a rerun never pays twice.
5. **Real screens (composite, don't trust the model).** Image models redraw app UI even when told not to: values drift off their bars, charts get re-plotted. For any final that shows a phone screen, do this instead of accepting the model's screen:
   1. Edit the final with `image_models.final`: pass it as `--ref` and ask to "replace only the phone display with flat pure green #00FF00; keep everything else identical; keep the phone upright". A tilted phone makes even a pixel-correct screen look wrong at phone size.
   2. `scripts/composite-screen.sh <green-plate.png> product/assets/<screen>.png creatives/<date>/c01/final-4x5.png` (needs ImageMagick 7 `magick` and python3). It finds the green quad's four corners, pads the real screenshot to that shape without stretching, warps it on and removes green spill.
   3. Zoom into the result with Read and compare it with the source screenshot row by row. Keep rejected versions as `final-4x5-vN-rejected.png`.
6. **Self-review.** Open every final and check:
   - [ ] Every word on the image is spelled exactly as in the brief and readable at phone size
   - [ ] Brand colors and logo are correct, logo not distorted
   - [ ] App screens come from real screenshots; no invented UI, fake buttons, fake notifications or fake play icons
   - [ ] No before/after bodies, no claims about personal attributes ("Are you depressed?"), no guaranteed outcomes, no competitor names
   - [ ] Text sits inside safe zones for the ratio
   - [ ] It looks like the brief, not a generic stock ad
   Record the result in `brief.json` as `review: { passed, notes }`. One retry per failing final, then set `status: "rejected"`.
7. Set `status: "ready"` on passing briefs and list them for `launch-ads`.

## Rules
- Generation always goes through Genviral with `scripts/genviral-image.mjs`. Never call OpenAI directly.
- The script prints `credits_used`; add it to the brief so the daily report can total the cost.
- On `insufficient_credits` or `subscription_required`, stop generation and put the error in the report.
