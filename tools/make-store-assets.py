#!/usr/bin/env python3
"""
Localized Chrome Web Store assets from the screenshots + the magnifier icon.

    python3 tools/make-store-assets.py \\
        --in ~/screenshot --out ~/screenshot/store \\
        --icon extension/icons/icon128.png

Produces:
  <out>/<lang>/shot-1..3.png     1280×800 screenshots with a localized subtitle
  <out>/promo-small-<lang>.png   440×280 small promo tile
  <out>/promo-marquee-<lang>.png 1400×560 marquee promo tile

All output is RGB PNG (no alpha), the format the Web Store expects.
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

CANVAS = (1280, 800)
PROMO_SMALL = (440, 280)
MARQUEE = (1400, 560)

BG_TOP = (11, 18, 32)
BG_BOTTOM = (17, 24, 39)
GLOW_PURPLE = (139, 92, 246)
GLOW_TEAL = (45, 212, 191)
TEXT = (241, 245, 249)
MUTED = (148, 163, 184)
CHIP_BG = (30, 41, 59)
CHIP_BORDER = (51, 65, 85)
VERDICTS = [
    ("verdict.php.short", (239, 68, 68)),
    ("verdict.maybe.short", (245, 158, 11)),
    ("verdict.none.short", (34, 197, 94)),
]

SUBTITLES = {
    "en": "PHP fingerprint · runs locally",
    "ja": "PHP 判定 · 端末内で完結",
    "zh-cn": "PHP 指纹 · 完全本地运行",
    "zh-tw": "PHP 指紋 · 完全在本機執行",
    "ko": "PHP 판별 · 기기 안에서 완결",
    "es": "Huella de PHP · todo local",
    "fr": "Emprise PHP · 100 % local",
    "de": "PHP-Fingerabdruck · lokal",
    "pt-br": "Impressão de PHP · tudo local",
    "ru": "Определение PHP · локально",
    "ar": "بصمة PHP · محليًا بالكامل",
    "hi": "PHP फिंगरप्रिंट · पूरी तरह लोकल",
}

RTL = {"ar", "he", "fa", "ur"}
CJK = {"ja", "zh-cn", "zh-tw", "ko"}

NOTO = "/usr/share/fonts/noto"
NOTO_CJK = "/usr/share/fonts/noto-cjk"


def script_font(lang, size, bold=False):
    weight = "Bold" if bold else "Regular"
    if lang in CJK:
        path = os.path.join(NOTO_CJK, f"NotoSansCJK-{weight}.ttc")
    elif lang == "ar":
        path = os.path.join(NOTO, f"NotoSansArabic-{weight}.ttf")
    elif lang == "hi":
        path = os.path.join(NOTO, f"NotoSansDevanagari-{weight}.ttf")
    else:
        path = os.path.join(NOTO, f"NotoSans-{weight}.ttf")
    return ImageFont.truetype(path, size, index=0)


def draw_text(draw, xy, text, fnt, fill, lang, anchor="la"):
    kwargs = {"font": fnt, "fill": fill, "anchor": anchor}
    try:
        kwargs["direction"] = "rtl" if lang in RTL else "ltr"
        kwargs["language"] = lang
        draw.text(xy, text, **kwargs)
    except (TypeError, ValueError):
        draw.text(xy, text, font=fnt, fill=fill, anchor=anchor)


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
    return Image.new("RGB", size, colour), mask


def background(size):
    canvas = vertical_gradient(size, BG_TOP, BG_BOTTOM)
    for colour, centre, radius, strength in [
        (GLOW_PURPLE, (size[0] - 100, 40), int(size[0] * 0.5), 90),
        (GLOW_TEAL, (80, size[1] - 30), int(size[0] * 0.4), 55),
    ]:
        layer, mask = radial_glow(size, centre, radius, colour, strength)
        canvas = Image.composite(layer, canvas, mask)
    return canvas


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def paste_icon(canvas, icon, box_size, position):
    scaled = icon.resize((box_size, box_size), Image.LANCZOS)
    canvas.paste(scaled, position, scaled)


def draw_chips(draw, x, right, y, height, lang, labels, font_size, pad_x, dot, gap):
    fnt = script_font(lang, font_size, bold=True)
    widths = [pad_x * 2 + dot + gap + fnt.getlength(label) for label in labels]
    total = sum(widths) + gap * (len(labels) - 1)

    cursor = right - total if right is not None else x
    for (key, colour), label, width in zip(VERDICTS, labels, widths):
        draw.rounded_rectangle(
            [cursor, y, cursor + width, y + height],
            radius=height // 2,
            fill=CHIP_BG,
            outline=CHIP_BORDER,
        )
        cy = y + height / 2
        draw.ellipse([cursor + pad_x, cy - dot / 2, cursor + pad_x + dot, cy + dot / 2], fill=colour)
        draw.text((cursor + pad_x + dot + gap, cy), label, font=fnt, fill=TEXT, anchor="lm")
        cursor += width + gap


def verdict_labels(table, lang):
    return [table.get(key, key) for key, _ in VERDICTS]


def frame_screenshot(source, lang, table, subtitle, icon, max_scale=2.0):
    image = ImageOps.exif_transpose(Image.open(source)).convert("RGB")
    canvas = background(CANVAS)
    paste_icon(canvas, icon, 36, (80, 40))

    draw = ImageDraw.Draw(canvas)
    draw.text((128, 38), "PHP Simple Check", font=script_font("en", 30, bold=True), fill=TEXT)
    if lang in RTL:
        draw_text(draw, (CANVAS[0] - 80, 92), subtitle, script_font(lang, 17), MUTED, lang, anchor="ra")
    else:
        draw_text(draw, (80, 92), subtitle, script_font(lang, 17), MUTED, lang)

    stage = (CANVAS[0] - 160, CANVAS[1] - 230)
    scale = min(stage[0] / image.width, stage[1] / image.height, max_scale)
    scaled = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS
    )
    x = (CANVAS[0] - scaled.width) // 2
    y = 150 + (stage[1] - scaled.height) // 2
    radius = 14 if scale >= 1 else 10

    shadow = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x - 2, y + 14, x + scaled.width + 2, y + scaled.height + 18],
        radius=radius + 2,
        fill=(0, 0, 0, 150),
    )
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(26))).convert("RGB")

    card = scaled.convert("RGBA")
    card.putalpha(rounded_mask(scaled.size, radius))
    canvas.paste(card, (x, y), card)
    ImageDraw.Draw(canvas).rounded_rectangle(
        [x, y, x + scaled.width - 1, y + scaled.height - 1],
        radius=radius,
        outline=(71, 85, 105),
        width=1,
    )

    draw = ImageDraw.Draw(canvas)
    draw.text(
        (80, CANVAS[1] - 58),
        "github.com/yomiplush/php-simple-check",
        font=script_font("en", 15),
        fill=MUTED,
    )
    return canvas


def promo(size, lang, subtitle, labels, icon):
    small = size == PROMO_SMALL
    canvas = background(size)
    draw = ImageDraw.Draw(canvas)

    if small:
        paste_icon(canvas, icon, 52, (24, 22))
        draw.text((88, 24), "PHP Simple Check", font=script_font("en", 21, bold=True), fill=TEXT)
        draw_text(draw, (88, 56), subtitle, script_font(lang, 12), MUTED, lang)
        draw_chips(
            draw,
            24,
            size[0] - 24 if lang in RTL else None,
            196,
            34,
            lang,
            labels,
            font_size=12,
            pad_x=10,
            dot=8,
            gap=6,
        )
    else:
        paste_icon(canvas, icon, 128, (96, 92))
        draw.text((264, 92), "PHP Simple Check", font=script_font("en", 58, bold=True), fill=TEXT)
        draw_text(draw, (264, 186), subtitle, script_font(lang, 24), MUTED, lang)
        draw_chips(
            draw,
            96,
            size[0] - 96 if lang in RTL else None,
            372,
            62,
            lang,
            labels,
            font_size=22,
            pad_x=20,
            dot=14,
            gap=10,
        )
        draw.text(
            (size[0] - 96, size[1] - 72),
            "github.com/yomiplush/php-simple-check",
            font=script_font("en", 16),
            fill=MUTED,
            anchor="ra",
        )
    return canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="source_dir", default=os.path.expanduser("~/screenshot"))
    parser.add_argument("--out", dest="out_dir", default=os.path.expanduser("~/screenshot/store"))
    parser.add_argument("--icon", default="extension/icons/icon128.png")
    parser.add_argument("--locales", default="locales")
    parser.add_argument("--langs", default=",".join(SUBTITLES.keys()))
    parser.add_argument("--promo-langs", default="en,ja")
    parser.add_argument("--max-scale", type=float, default=2.0)
    args = parser.parse_args()

    sources = sorted(
        path
        for pattern in ("*.jpg", "*.jpeg", "*.png", "*.webp")
        for path in glob.glob(os.path.join(args.source_dir, pattern))
        if os.path.dirname(path) == args.source_dir.rstrip("/")
    )
    if not sources:
        sys.exit(f"no screenshots found in {args.source_dir}")

    icon = Image.open(args.icon).convert("RGBA")
    os.makedirs(args.out_dir, exist_ok=True)

    languages = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    promo_languages = [lang.strip() for lang in args.promo_langs.split(",") if lang.strip()]

    for lang in languages:
        table = json.load(open(os.path.join(args.locales, f"{lang}.json"), encoding="utf-8"))
        subtitle = SUBTITLES.get(lang, SUBTITLES["en"])
        folder = os.path.join(args.out_dir, lang)
        os.makedirs(folder, exist_ok=True)

        for index, source in enumerate(sources, start=1):
            image = frame_screenshot(source, lang, table, subtitle, icon, args.max_scale)
            image.save(os.path.join(folder, f"shot-{index}.png"), "PNG", optimize=True)
        print(f"{lang}: {len(sources)} screenshots + ", end="")

        if lang in promo_languages:
            labels = verdict_labels(table, lang)
            promo(PROMO_SMALL, lang, subtitle, labels, icon).save(
                os.path.join(args.out_dir, f"promo-small-{lang}.png"), "PNG", optimize=True
            )
            promo(MARQUEE, lang, subtitle, labels, icon).save(
                os.path.join(args.out_dir, f"promo-marquee-{lang}.png"), "PNG", optimize=True
            )
            print("promo tiles")
        else:
            print("no promo tiles")


if __name__ == "__main__":
    main()
