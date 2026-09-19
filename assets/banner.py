# Draws the jev-search pixel banner: assets/banner.svg (README, transparent) and assets/social-preview.png (1280x640).
# Usage: python3 assets/banner.py   (needs Pillow for the PNG)
from PIL import Image, ImageDraw

# 5 columns x 9 rows: rows 0-1 ascender, 2-6 x-height, 7-8 descender.
FONT = {
    "j": ["...#.", ".....", "...#.", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    "e": ["", "", ".###.", "#...#", "#####", "#....", ".###."],
    "v": ["", "", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "-": ["", "", "", "", ".###."],
    "s": ["", "", ".####", "#....", ".###.", "....#", "####."],
    "a": ["", "", ".###.", "....#", ".####", "#...#", ".####"],
    "r": ["", "", "#.##.", "##..#", "#....", "#....", "#...."],
    "c": ["", "", ".###.", "#...#", "#....", "#...#", ".###."],
    "h": ["#....", "#....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
    "f": ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
    "t": [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
    "d": ["....#", "....#", ".##.#", "#..##", "#...#", "#...#", ".####"],
    "p": ["", "", "####.", "#...#", "#...#", "####.", "#....", "#...."],
    "o": ["", "", ".###.", "#...#", "#...#", "#...#", ".###."],
    "i": ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
    " ": [],
}
CORAL, BLUE, YELLOW, GREEN = "#F09082", "#4D9ABF", "#F1BE58", "#5FBF7A"  # the first three are the colors of the pi logo
TITLE = [("jev", CORAL), ("-", YELLOW), ("search", BLUE)]
# A real strip from the README: RFC 9110, the answer sits far beyond the cut.
STRIP = "▒░░░░░░░▒░░░✂░░░░░▒░░░░░░░░▒░░░░░░░▒░░░░░░░██░░░░░░░░▒░░░░░░░"


def cells(text):
    """Yield (column, row) of every filled pixel of a text, 1 empty column between glyphs."""
    x = 0
    for ch in text:
        for row, line in enumerate(FONT[ch]):
            for col, mark in enumerate(line):
                if mark == "#":
                    yield x + col, row
        x += 6


def layout(px, ox, oy, dim, dimmer):
    """Rectangles (x, y, w, h, color, opacity) for the title and the strip."""
    rects, x = [], 0
    for word, color in TITLE:
        rects += [(ox + (x + c) * px, oy + r * px, px, px, color, 1) for c, r in cells(word)]
        x += 6 * len(word)
    y = oy + 11 * px
    for i, cell in enumerate(STRIP.replace("✂", "")):
        color, opacity = {"█": (GREEN, 1), "▓": (YELLOW, 1), "▒": dim, "░": dimmer}[cell]
        rects.append((ox + i * px, y, px - max(2, px // 6), px, color, opacity))
    cut = STRIP.index("✂")
    rects.append((ox + cut * px - max(2, px // 6) - px // 8, y - px // 2, px // 4, px * 2, CORAL, 1))
    return rects


WIDTH = 59  # title columns; the strip has 60 cells

# README banner: transparent, grays that work on light and dark pages.
px = 12
rects = layout(px, 0, 0, ("#8b949e", 0.75), ("#8b949e", 0.35))
w, h = 60 * px, 13 * px
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="jev-search">']
svg += [f'<rect x="{x}" y="{y}" width="{rw}" height="{rh}" fill="{c}"' + (f' opacity="{o}"' if o != 1 else "") + "/>" for x, y, rw, rh, c, o in rects]
open("banner.svg", "w").write("\n".join(svg) + "\n</svg>\n")

# Social preview: 1280x640, dark, with a tagline.
px = 18
img = Image.new("RGB", (1280, 640), "#0d1117")
draw = ImageDraw.Draw(img)
ox, oy = (1280 - 60 * px) // 2, 150
for x, y, rw, rh, c, o in layout(px, ox, oy, ("#56606d", 1), ("#262c35", 1)):
    draw.rectangle([x, y, x + rw - 1, y + rh - 1], fill=c)
tag, tpx = "fast deep research for pi", 6
tw = (6 * len(tag) - 1) * tpx
for c, r in cells(tag):
    x, y = (1280 - tw) // 2 + c * tpx, oy + 15 * px + r * tpx
    draw.rectangle([x, y, x + tpx - 1, y + tpx - 1], fill="#8b949e")
img.save("social-preview.png", optimize=True)
print("banner.svg", w, "x", h, "| social-preview.png 1280 x 640")
