#!/usr/bin/env python3
"""Find the 4 corners of a chroma-green phone screen in a PPM image (stdlib only).

Usage: magick plate.png -depth 8 ppm:- | python3 green-quad.py
Prints JSON: corners (tl, tr, br, bl) of the screen rectangle, found by fitting
straight lines to the middle of each green edge (so rounded corners and fingers
overlapping the edge do not bias the fit) and intersecting them.
"""
import json
import sys

GREEN_MARGIN = 90  # g must exceed max(r, b) by this much (0-255)
EDGE_TRIM = 0.2    # ignore this fraction at each end of an edge (rounded corners)
MAX_RESIDUAL = 2.5  # px; points further from the fit are dropped (fingers)


def read_ppm(stream):
    data = stream.read()
    parts, idx = [], 0
    while len(parts) < 4:
        while idx < len(data) and data[idx:idx + 1].isspace():
            idx += 1
        if idx >= len(data):
            raise SystemExit('green-quad: input is not a binary PPM image (truncated header)')
        if data[idx:idx + 1] == b'#':
            idx = data.index(b'\n', idx)
            continue
        end = idx
        while end < len(data) and not data[end:end + 1].isspace():
            end += 1
        parts.append(data[idx:end])
        idx = end
    if parts[0] != b'P6':
        raise SystemExit('green-quad: input is not a binary PPM (P6) image')
    width, height = int(parts[1]), int(parts[2])
    return width, height, data[idx + 1:]


def fit_line(points):
    """Fit u = a*v + b with iterative outlier rejection. points: (v, u)."""
    pts = list(points)
    for _ in range(6):
        n = len(pts)
        sv = sum(p[0] for p in pts); su = sum(p[1] for p in pts)
        svv = sum(p[0] * p[0] for p in pts); svu = sum(p[0] * p[1] for p in pts)
        a = (n * svu - sv * su) / (n * svv - sv * sv)
        b = (su - a * sv) / n
        kept = [p for p in pts if abs(p[1] - (a * p[0] + b)) <= MAX_RESIDUAL]
        if len(kept) == len(pts) or len(kept) < 20:
            break
        pts = kept
    return a, b


def main():
    width, height, px = read_ppm(sys.stdin.buffer)
    rows, cols = {}, {}
    for y in range(height):
        base = y * width * 3
        for x in range(width):
            i = base + x * 3
            r, g, b = px[i], px[i + 1], px[i + 2]
            if g - max(r, b) < GREEN_MARGIN:
                continue
            lo, hi = rows.get(y, (x, x))
            rows[y] = (min(lo, x), max(hi, x))
            lo, hi = cols.get(x, (y, y))
            cols[x] = (min(lo, y), max(hi, y))
    ys, xs = sorted(rows), sorted(cols)

    def middle(keys):
        cut = int(len(keys) * EDGE_TRIM)
        return keys[cut:len(keys) - cut]

    left = fit_line((y, rows[y][0]) for y in middle(ys))    # x = a*y + b
    right = fit_line((y, rows[y][1]) for y in middle(ys))
    top = fit_line((x, cols[x][0]) for x in middle(xs))     # y = a*x + b
    bottom = fit_line((x, cols[x][1]) for x in middle(xs))

    def cross(vertical, horizontal):
        (a1, b1), (a2, b2) = vertical, horizontal
        y = (a2 * b1 + b2) / (1 - a2 * a1)
        return [round(a1 * y + b1, 2), round(y, 2)]

    corners = [cross(left, top), cross(right, top), cross(right, bottom), cross(left, bottom)]
    tl, tr, br, bl = corners
    top_len = ((tr[0] - tl[0]) ** 2 + (tr[1] - tl[1]) ** 2) ** 0.5
    left_len = ((bl[0] - tl[0]) ** 2 + (bl[1] - tl[1]) ** 2) ** 0.5
    print(json.dumps({"size": [width, height], "corners": corners,
                      "width_over_height": round(top_len / left_len, 4)}))


if __name__ == '__main__':
    main()
