#!/usr/bin/env bash
# Composite a real app screenshot, unmodified, into a generated green-screen phone plate.
# Usage: scripts/composite-screen.sh <plate.png> <screen.png> <out.png>
# Needs ImageMagick 7 (magick) and python3. Steps:
#  1. green-quad.py fits lines to the green display edges and intersects them -> 4 corners.
#  2. The screenshot is padded top/bottom with its own edge colours to the quad's aspect
#     (never stretched), then perspective-warped onto the 4 corners.
#     A 24 px bleed of the edge colour is added around it; the control points map the real
#     (unbled) screen rectangle to the corners, so the bleed lands just outside the quad and
#     covers green that runs past the fitted edges.
#  3. A mask of the green pixels (dilated 3 px, feathered) decides where the screen shows,
#     so rounded corners and anything in front of the display keep the plate's pixels.
#  4. Despill: any pixel still green-dominant gets its green channel clamped to max(r, b).
set -euo pipefail
BLEED=24
plate=$1; screen=$2; out=$3
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

quad=$(magick "$plate" -depth 8 ppm:- | python3 "$here/green-quad.py")
read -r W H < <(magick identify -format '%w %h\n' "$plate")
read -r SW SH < <(magick identify -format '%w %h\n' "$screen")
ratio=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['width_over_height'])" "$quad")
target_h=$(python3 -c "print(round($SW / $ratio))")
pad=$(( target_h > SH ? target_h - SH : 0 ))
pad_top=$(( pad / 3 )); pad_bottom=$(( pad - pad_top ))
top_colour=$(magick "$screen" -crop "${SW}x1+0+0" -scale 1x1! -format '#%[hex:u.p{0,0}]' info:)
bottom_colour=$(magick "$screen" -crop "${SW}x1+0+$((SH - 1))" -scale 1x1! -format '#%[hex:u.p{0,0}]' info:)
magick \( -size "${SW}x${pad_top}" "xc:$top_colour" \) "$screen" \( -size "${SW}x${pad_bottom}" "xc:$bottom_colour" \) \
  -append -bordercolor "$top_colour" -border "$BLEED" "$tmp/padded.png"
PH=$(( SH + pad ))
points=$(python3 -c "
import json,sys
c=json.loads(sys.argv[1])['corners']; w,h=$SW,$PH
b=$BLEED
src=[(b,b),(w+b,b),(w+b,h+b),(b,h+b)]
print(' '.join(f'{s[0]},{s[1]} {d[0]},{d[1]}' for s,d in zip(src,c)))" "$quad")
magick "$tmp/padded.png" -alpha set -virtual-pixel transparent \
  -define "distort:viewport=${W}x${H}+0+0" -distort Perspective "$points" "$tmp/warped.png"
magick "$plate" -fx '(g - max(r,b)) > 0.2 ? 1 : 0' -colorspace Gray \
  -morphology Dilate Disk:3 -blur 0x1.4 "$tmp/mask.png"
magick "$plate" "$tmp/warped.png" "$tmp/mask.png" -composite "$tmp/composite.png"
magick "$tmp/composite.png" -channel G -fx 'min(g, max(r,b) + 0.02)' +channel "$out"
echo "{\"quad\": $quad, \"pad_top\": $pad_top, \"pad_bottom\": $pad_bottom, \"top_colour\": \"$top_colour\", \"bottom_colour\": \"$bottom_colour\"}"
