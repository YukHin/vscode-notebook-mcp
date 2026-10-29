"""Render the Notebook MCP extension icon (128x128 PNG) with Pillow.

Usage: python scripts/make-icon.py images/icon.png [preview.png]

Needs Pillow (`pip install pillow`; the end-to-end-test venv has it through
matplotlib). The optional preview shows the icon at 128/64/32/16 px on light
and dark backgrounds.

Motifs (drawn from scratch, not the projects' logos, which are trademarks):
notebook cells in the middle, orbit arcs with moons for Jupyter, and a
terminal prompt badge with a spark for Claude Code / AI agents.
"""
import math
import sys

from PIL import Image, ImageDraw, ImageFilter

S = 1024          # draw at 8x, then downsample for smooth edges
OUT = 128
RADIUS = 200

BG_TOP, BG_BOTTOM = (246, 142, 72), (176, 52, 52)
CREAM = (255, 248, 236)
INK = (110, 44, 30)
ACCENT = (214, 74, 46)
BADGE = (64, 28, 24)
CORAL = (255, 160, 112)
GOLD = (255, 216, 92)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def layer():
    return Image.new("RGBA", (S, S), (0, 0, 0, 0))


def star(cx, cy, r, inner=0.30, points=4, rot=-math.pi / 2):
    pts = []
    for k in range(points * 2):
        rad = r if k % 2 == 0 else r * inner
        a = rot + k * math.pi / points
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    return pts


# Background: diagonal warm gradient in a rounded square.
bg = Image.new("RGBA", (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        t = min(1.0, max(0.0, (x * 0.35 + y * 0.65) / S))
        px[x, y] = lerp(BG_TOP, BG_BOTTOM, t) + (255,)
icon = layer()
icon.paste(bg, (0, 0), rounded_mask(S, RADIUS))

# Jupyter: two orbit arcs, above and below the notebook, and three moons.
# (Translucent shapes go on their own layer: ImageDraw replaces alpha
# instead of blending.)
orbit = layer()
od = ImageDraw.Draw(orbit)
box = [56, 196, 968, 836]
od.arc(box, start=200, end=340, fill=CREAM + (210,), width=40)
od.arc(box, start=20, end=160, fill=CREAM + (210,), width=40)
for mx, my, mr in [(150, 300, 38), (126, 704, 24), (900, 300, 26)]:
    od.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=(255, 236, 214, 235))
icon = Image.alpha_composite(icon, orbit)

# Notebook cells in the middle: two translucent, the active one solid.
cells_layer = layer()
cd = ImageDraw.Draw(cells_layer)
x0, x1 = 214, 700
cells = [(296, 404), (436, 560), (592, 700)]
for i, (y0, y1) in enumerate(cells):
    active = i == 1
    if active:
        cd.rounded_rectangle([x0, y0, x1, y1], radius=36, fill=CREAM + (255,))
    else:
        sub = layer()
        ImageDraw.Draw(sub).rounded_rectangle([x0, y0, x1, y1], radius=36, fill=(255, 238, 214, 70))
        cells_layer = Image.alpha_composite(cells_layer, sub)
        cd = ImageDraw.Draw(cells_layer)
    gutter = ACCENT + (255,) if active else (255, 214, 170, 255)
    cd.rounded_rectangle([x0 + 30, y0 + 28, x0 + 50, y1 - 28], radius=10, fill=gutter)
    line = INK + (255,) if active else (255, 224, 190, 255)
    widths = [0.66, 0.40] if not active else [0.70, 0.46]
    usable = (y1 - y0) - 2 * 36
    for k, w in enumerate(widths):
        cy = y0 + 36 + usable * (k + 0.5) / len(widths)
        lx0 = x0 + 88
        lx1 = lx0 + (x1 - 36 - lx0) * w
        cd.rounded_rectangle([lx0, cy - 14, lx1, cy + 14], radius=14, fill=line)
icon = Image.alpha_composite(icon, cells_layer)

# Claude Code: a terminal badge with a ">_" prompt, bottom right.
bx0, by0, bx1, by1 = 600, 640, 920, 920
shadow = layer()
ImageDraw.Draw(shadow).rounded_rectangle([bx0, by0 + 18, bx1, by1 + 18], radius=70, fill=(60, 16, 10, 140))
icon = Image.alpha_composite(icon, shadow.filter(ImageFilter.GaussianBlur(22)))
d = ImageDraw.Draw(icon)
d.rounded_rectangle([bx0 - 14, by0 - 14, bx1 + 14, by1 + 14], radius=84, fill=lerp(BG_TOP, BG_BOTTOM, 0.9) + (255,))
d.rounded_rectangle([bx0, by0, bx1, by1], radius=70, fill=BADGE + (255,))
# ">" chevron
cx, cy = bx0 + 112, (by0 + by1) / 2 + 4
d.line([(cx - 46, cy - 64), (cx + 30, cy), (cx - 46, cy + 64)], fill=CORAL + (255,), width=40, joint="curve")
for (px_, py_) in [(cx - 46, cy - 64), (cx - 46, cy + 64), (cx + 30, cy)]:
    d.ellipse([px_ - 20, py_ - 20, px_ + 20, py_ + 20], fill=CORAL + (255,))
# "_" cursor
d.rounded_rectangle([cx + 62, cy + 46, cx + 166, cy + 84], radius=19, fill=CREAM + (255,))

# Spark (the agent), top right, with a soft glow.
sx, sy, sr = 820, 196, 104
glow = layer()
ImageDraw.Draw(glow).polygon(star(sx, sy, sr * 1.05), fill=(255, 236, 140, 170))
icon = Image.alpha_composite(icon, glow.filter(ImageFilter.GaussianBlur(34)))
d = ImageDraw.Draw(icon)
d.polygon(star(sx, sy, sr + 22, inner=0.34), fill=(150, 40, 42, 255))
d.polygon(star(sx, sy, sr), fill=GOLD + (255,))
d.polygon(star(sx + 96, sy + 100, 38), fill=(255, 241, 196, 255))

# Keep everything inside the rounded square.
clip = layer()
clip.paste(icon, (0, 0), rounded_mask(S, RADIUS))

out = clip.resize((OUT, OUT), Image.LANCZOS)
out.save(sys.argv[1], optimize=True)
if len(sys.argv) > 2:
    sizes = [128, 64, 32, 16]
    W = sum(sizes) + 20 * (len(sizes) + 1)
    prev = Image.new("RGBA", (W, 2 * (128 + 40)), (255, 255, 255, 255))
    ImageDraw.Draw(prev).rectangle([0, 168, W, 336], fill=(30, 30, 30, 255))
    for row in range(2):
        x = 20
        for s in sizes:
            im = clip.resize((s, s), Image.LANCZOS)
            prev.alpha_composite(im, (x, row * 168 + 20 + (128 - s) // 2))
            x += s + 20
    prev.save(sys.argv[2])
print("ok")
