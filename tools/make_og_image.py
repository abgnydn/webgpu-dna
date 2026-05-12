#!/usr/bin/env python3
"""Generate OG/Twitter card image (1200x630) matching the site branding.

Run: python3 tools/make_og_image.py
Writes: public/og-image.png
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math
import random

W, H = 1200, 630

# Site palette (from index.html :root)
BG  = (10, 10, 15)     # --bg
SF  = (18, 18, 26)     # --sf
BD  = (42, 42, 58)     # --bd
TX  = (232, 232, 240)  # --tx
TX2 = (184, 184, 200)  # --tx2
DM  = (136, 136, 160)  # --dm
AC  = (0, 212, 170)    # --ac
AC_FAINT = (0, 212, 170, 50)

MONO = "/System/Library/Fonts/SFNSMono.ttf"
SANS = "/System/Library/Fonts/HelveticaNeue.ttc"


def draw_helix(draw, cx, cy, height, radius, turns=3.0, segments=160, phase_offset=0.0):
    """Draw a vertical DNA double helix centered at (cx, cy).

    `turns` = number of full rotations across `height`. A real B-DNA helix is
    ~10 bp per turn, so 3 turns in 500px gives a visible pitch while staying
    recognizable as DNA.
    """
    pts_a, pts_b = [], []
    for i in range(segments + 1):
        f = i / segments                    # 0..1
        y = cy - height / 2 + f * height    # top to bottom
        theta = f * turns * 2 * math.pi
        xa = cx + math.cos(theta + phase_offset) * radius
        xb = cx + math.cos(theta + phase_offset + math.pi) * radius
        pts_a.append((xa, y))
        pts_b.append((xb, y))

    # Rungs (every 4th position)
    for i in range(0, segments + 1, 4):
        ax, ay = pts_a[i]
        bx, by = pts_b[i]
        fade = 1.0 - abs(i / segments - 0.5) * 1.3
        fade = max(0.15, min(1.0, fade))
        a = int(110 * fade)
        draw.line([(ax, ay), (bx, by)], fill=(*AC, a), width=2)

    # Strands: back-to-front rendering — fade the half that's "behind" (sin<0)
    for pts, col in [(pts_a, AC), (pts_b, TX2)]:
        for i in range(len(pts) - 1):
            # Use sin to detect front/back of helix
            f = i / segments
            theta = f * turns * 2 * math.pi
            sin_val = math.sin(theta + (phase_offset if col is AC else phase_offset + math.pi))
            depth = (sin_val + 1) / 2  # 0 back → 1 front
            fade = 1.0 - abs(f - 0.5) * 1.2
            fade = max(0.2, min(1.0, fade))
            a = int((80 + 140 * depth) * fade)
            w = 2 if depth > 0.5 else 1
            draw.line([pts[i], pts[i + 1]], fill=(*col, a), width=w)


def draw_particle_track(draw, x0, y0, length, angle, steps, rng):
    """Draw a scattered Monte Carlo electron track as connected line segments."""
    x, y = x0, y0
    a = angle
    pts = [(x, y)]
    for _ in range(steps):
        step = rng.uniform(8, 28)
        a += rng.uniform(-0.6, 0.6)
        x += math.cos(a) * step
        y += math.sin(a) * step
        pts.append((x, y))
        if x < -40 or x > W + 40 or y < -40 or y > H + 40:
            break
    for i in range(len(pts) - 1):
        alpha = int(90 * (1 - i / max(1, len(pts) - 1)))
        draw.line([pts[i], pts[i + 1]], fill=(*AC, alpha + 30), width=1)
    # Ionization dots
    for i, p in enumerate(pts):
        if i % 3 == 0:
            r = 1.5
            draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=(*AC, 140))


def main():
    img = Image.new("RGB", (W, H), BG)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Radial teal glow, upper-left
    for r in range(800, 0, -40):
        alpha = max(0, int(30 * (1 - r / 800)))
        draw.ellipse([100 - r, 80 - r, 100 + r, 80 + r], fill=(*AC, alpha))

    # Subtle scattered Monte Carlo tracks in the background
    rng = random.Random(42)
    for _ in range(12):
        x0 = rng.uniform(50, W - 50)
        y0 = rng.uniform(40, H - 40)
        angle = rng.uniform(0, 2 * math.pi)
        draw_particle_track(draw, x0, y0, 400, angle, rng.randint(18, 40), rng)

    # Right-side DNA double helix
    draw_helix(draw, cx=1000, cy=H / 2, height=480, radius=70, turns=3.2)

    # Faint grid / border
    draw.rectangle([24, 24, W - 24, H - 24], outline=(*BD, 200), width=1)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Typography
    font_brand = ImageFont.truetype(MONO, 38)
    font_huge  = ImageFont.truetype(SANS, 84)
    font_sub   = ImageFont.truetype(SANS, 28)
    font_tag   = ImageFont.truetype(MONO, 18)
    font_meta  = ImageFont.truetype(MONO, 16)

    # Brand mark
    brand_x, brand_y = 64, 60
    draw.text((brand_x, brand_y), "webgpu", font=font_brand, fill=TX)
    # The · separator and 'dna' in accent
    wp = draw.textlength("webgpu", font=font_brand)
    draw.text((brand_x + wp, brand_y), " \u00b7 ", font=font_brand, fill=DM)
    wsep = draw.textlength(" \u00b7 ", font=font_brand)
    draw.text((brand_x + wp + wsep, brand_y), "dna", font=font_brand, fill=AC)

    # Top tag
    draw.text(
        (brand_x, brand_y + 58),
        "MONTE CARLO TRACK STRUCTURE \u00b7 WEBGPU",
        font=font_tag,
        fill=DM,
    )

    # Hero
    y_hero = 210
    draw.text((brand_x, y_hero), "Geant4-DNA,", font=font_huge, fill=TX)
    draw.text((brand_x, y_hero + 96), "in the browser.", font=font_huge, fill=AC)

    # Sub
    draw.text(
        (brand_x, y_hero + 210),
        "One fused WGSL dispatch \u00b7 IRT radiolysis \u00b7 SSB/DSB scoring.",
        font=font_sub,
        fill=TX2,
    )

    # Metric strip at bottom \u2014 keep in sync with README \u00a7 Numbers
    # (single source of truth). Update whenever a headline number
    # changes upstream.
    metrics = [
        ("CSDA",       "0.988\u00d7"),
        ("IONS/PRIM",  "0.73\u00d7"),
        ("E-CONS",     "100.0%"),
        ("TESTS",      "46 / 46"),
    ]
    strip_y = H - 84
    x = brand_x
    gap = 56
    for label, value in metrics:
        draw.text((x, strip_y), label, font=font_meta, fill=DM)
        draw.text((x, strip_y + 24), value, font=font_brand, fill=AC)
        vw = draw.textlength(value, font=font_brand)
        lw = draw.textlength(label, font=font_meta)
        x += max(vw, lw) + gap

    # Right-side URL
    url = "webgpudna.com"
    uw = draw.textlength(url, font=font_tag)
    draw.text((W - 64 - uw, H - 52), url, font=font_tag, fill=DM)

    out = Path(__file__).resolve().parent.parent / "public" / "og-image.png"
    out.parent.mkdir(exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
