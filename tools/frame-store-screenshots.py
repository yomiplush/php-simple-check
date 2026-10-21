#!/usr/bin/env python3
"""
Frame arbitrary screenshots for the Chrome Web Store (1280×800).

    python3 tools/frame-store-screenshots.py \
        --in ~/screenshot --out ~/screenshot/store \
        --title "PHP Simple Check" --subtitle "PHP fingerprint · runs locally"

Every input image is scaled (never stretched) onto a branded 1280×800 canvas,
rounded, shadowed and saved as an RGB PNG — the format the Web Store expects.
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

CANVAS = (1280, 800)
BG_TOP = (11, 18, 32)
BG_BOTTOM = (17, 24, 39)
GLOW_PURPLE = (139, 92, 246)
GLOW_TEAL = (45, 212, 191)
TEXT = (241, 245, 249)
MUTED = (148, 163, 184)
FONT_DIR = "/usr/share/fonts/TTF"


def load_font(name, size):
    path = os.path.join(FONT_DIR, name)
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        colour = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=colour)
    return image


def radial_glow(size, centre, radius, colour, strength):
    """Soft coloured light: drawn small, blurred, then scaled up."""
    scale = 8
    small = (max(1, size[0] // scale), max(1, size[1] // scale))
    mask = Image.new("L", small, 0)
    draw = ImageDraw.Draw(mask)
    cx, cy = centre[0] // scale, centre[1] // scale
    r = max(1, radius // scale)
    steps = max(8, r // 2)
    for step in range(steps, 0, -1):
        ratio = step / steps
        draw.ellipse(
            [cx - r * ratio, cy - r * ratio, cx + r * ratio, cy + r * ratio],
            fill=int(strength * (1 - ratio) ** 2),
        )
    mask = mask.resize(size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
    layer = Image.new("RGB", size, colour)
    return layer, mask


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def compose(source, title, subtitle, footer, max_scale):
    image = Image.open(source)
    image = ImageOps.exif_transpose(image).convert("RGB")

    canvas = vertical_gradient(CANVAS, BG_TOP, BG_BOTTOM)

    for colour, centre, radius, strength in [
        (GLOW_PURPLE, (CANVAS[0] - 120, 60), 620, 90),
        (GLOW_TEAL, (90, CANVAS[1] - 40), 520, 55),
    ]:
        layer, mask = radial_glow(CANVAS, centre, radius, colour, strength)
        canvas = Image.composite(layer, canvas, mask)

    draw = ImageDraw.Draw(canvas)
    draw.text((80, 44), title, font=load_font("DejaVuSans-Bold.ttf", 30), fill=TEXT)
    draw.text((80, 86), subtitle, font=load_font("DejaVuSans.ttf", 17), fill=MUTED)

    # Fit the screenshot into the stage area without ever stretching it.
    stage = (CANVAS[0] - 160, CANVAS[1] - 230)
    scale = min(stage[0] / image.width, stage[1] / image.height, max_scale)
    scaled = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)

    x = (CANVAS[0] - scaled.width) // 2
    y = 150 + (stage[1] - scaled.height) // 2
    radius = 14 if scale >= 1 else 10

    shadow = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        [x - 2, y + 14, x + scaled.width + 2, y + scaled.height + 18],
        radius=radius + 2,
        fill=(0, 0, 0, 150),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow).convert("RGB")

    card = scaled.convert("RGBA")
    card.putalpha(rounded_mask(scaled.size, radius))
    canvas.paste(card, (x, y), card)

    border = ImageDraw.Draw(canvas)
    border.rounded_rectangle(
        [x, y, x + scaled.width - 1, y + scaled.height - 1],
        radius=radius,
        outline=(71, 85, 105),
        width=1,
    )

    draw = ImageDraw.Draw(canvas)
    draw.text((80, CANVAS[1] - 58), footer, font=load_font("DejaVuSans.ttf", 15), fill=MUTED)
    return canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="source_dir", required=True)
    parser.add_argument("--out", dest="out_dir", required=True)
    parser.add_argument("--title", default="PHP Simple Check")
    parser.add_argument("--subtitle", default="PHP fingerprint · runs locally")
    parser.add_argument("--footer", default="github.com/yomiplush/php-simple-check")
    parser.add_argument("--max-scale", type=float, default=2.0, help="never upscale more than this")
    parser.add_argument("--prefix", default="store-")
    args = parser.parse_args()

    sources = sorted(
        path
        for pattern in ("*.jpg", "*.jpeg", "*.png", "*.webp")
        for path in glob.glob(os.path.join(args.source_dir, pattern))
    )
    if not sources:
        sys.exit(f"no images found in {args.source_dir}")

    os.makedirs(args.out_dir, exist_ok=True)
    for index, source in enumerate(sources, start=1):
        output = os.path.join(args.out_dir, f"{args.prefix}{index}.png")
        image = compose(source, args.title, args.subtitle, args.footer, args.max_scale)
        image.save(output, "PNG", optimize=True)
        print(f"{os.path.basename(source)} -> {output} ({image.width}x{image.height}, {image.mode})")


if __name__ == "__main__":
    main()
