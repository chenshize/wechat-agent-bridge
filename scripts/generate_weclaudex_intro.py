#!/usr/bin/env python3
"""Generate the WeClaudex README intro animation."""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH = 960
HEIGHT = 120
FPS = 20
DURATION_SECONDS = 7.75
FRAME_COUNT = round(FPS * DURATION_SECONDS)
FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)
REGULAR_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
)


def resolve_font(candidates: tuple[str, ...]) -> str:
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError(f"No supported font found; tried: {', '.join(candidates)}")


FONT_PATH = resolve_font(FONT_CANDIDATES)
REGULAR_FONT_PATH = resolve_font(REGULAR_FONT_CANDIDATES)

BACKGROUND_TOP = (6, 14, 27)
BACKGROUND_BOTTOM = (10, 28, 42)
WECHAT_GREEN = (7, 193, 96)
CLAUDE_ORANGE = (217, 119, 87)
# Sampled from the current official Codex app icon bundled with ChatGPT.
CODEX_BLUE = (112, 132, 242)
BRAND_ICE_BLUE = (184, 215, 242)
BRAND_ICE_GLOW = (69, 123, 184)
SOFT_WHITE = (238, 248, 248)

DROP_END_Y = 48
WORD_FONT_SIZE = 42
BRAND_FONT_SIZE = WORD_FONT_SIZE
COLLISION_START = 3.15
COLLISION_END = 3.82
FINAL_START = 3.76
FINAL_REVEAL_DURATION = 0.62
FINAL_HOLD_DURATION = 3.0
FADE_START = FINAL_START + FINAL_REVEAL_DURATION + FINAL_HOLD_DURATION

WORDS = (
    {"text": "Claude Code", "x": 482, "color": CLAUDE_ORANGE, "start": 0.16, "end": 1.08},
    {
        "text": "Codex",
        "x": 804,
        "color": CODEX_BLUE,
        "start": 1.16,
        "end": 1.92,
    },
    {"text": "WeChat", "x": 158, "color": WECHAT_GREEN, "start": 2.00, "end": 2.76},
)

ASSEMBLY_MOVE_START = 2.45
ASSEMBLY_MOVE_END = 4.22
ASSEMBLY_FINAL_START = 4.10
ASSEMBLY_FINAL_REVEAL_DURATION = 0.40
ASSEMBLY_FADE_START = ASSEMBLY_FINAL_START + ASSEMBLY_FINAL_REVEAL_DURATION + FINAL_HOLD_DURATION

ASSEMBLY_WORDS = (
    {
        "full": "WeChat",
        "keep": "WeC",
        "remove": "hat",
        "remove_first": False,
        "x": 158,
        "color": WECHAT_GREEN,
        "start": 1.40,
        "end": 2.12,
        "drift_x": 13,
        "drift_y": -19,
        "target_prefix": "",
        "arc": -7,
    },
    {
        "full": "Claude Code",
        "keep": "Claude",
        "remove": " Code",
        "remove_first": False,
        "x": 482,
        "color": CLAUDE_ORANGE,
        "start": 0.10,
        "end": 0.78,
        "drift_x": -4,
        "drift_y": 20,
        "target_prefix": "We",
        "arc": 6,
    },
    {
        "full": "Codex",
        "keep": "dex",
        "remove": "Co",
        "remove_first": True,
        "x": 804,
        "color": CODEX_BLUE,
        "start": 0.72,
        "end": 1.45,
        "drift_x": -13,
        "drift_y": -19,
        "target_prefix": "WeClau",
        "arc": -6,
    },
)

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def lerp(start: float, end: float, amount: float) -> float:
    return start + (end - start) * amount


def ease_out_cubic(value: float) -> float:
    value = clamp(value)
    return 1.0 - (1.0 - value) ** 3


def ease_in_out_cubic(value: float) -> float:
    value = clamp(value)
    if value < 0.5:
        return 4.0 * value**3
    return 1.0 - ((-2.0 * value + 2.0) ** 3) / 2.0


def ease_out_back(value: float) -> float:
    value = clamp(value)
    c1 = 1.70158
    c3 = c1 + 1.0
    return 1.0 + c3 * (value - 1.0) ** 3 + c1 * (value - 1.0) ** 2


def ease_out_bounce(value: float) -> float:
    value = clamp(value)
    n1 = 7.5625
    d1 = 2.75
    if value < 1.0 / d1:
        return n1 * value * value
    if value < 2.0 / d1:
        value -= 1.5 / d1
        return n1 * value * value + 0.75
    if value < 2.5 / d1:
        value -= 2.25 / d1
        return n1 * value * value + 0.9375
    value -= 2.625 / d1
    return n1 * value * value + 0.984375


def get_font(size: int, *, regular: bool = False) -> ImageFont.FreeTypeFont:
    path = REGULAR_FONT_PATH if regular else FONT_PATH
    key = (path, size)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(path, size=size)
    return _FONT_CACHE[key]


def make_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND_TOP)
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        amount = y / max(1, HEIGHT - 1)
        color = tuple(round(lerp(BACKGROUND_TOP[i], BACKGROUND_BOTTOM[i], amount)) for i in range(3))
        draw.line((0, y, WIDTH, y), fill=color)

    grid = Image.new("RGBA", image.size, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, WIDTH, 48):
        grid_draw.line((x, 0, x, HEIGHT), fill=(96, 162, 172, 9), width=1)
    for y in range(0, HEIGHT, 48):
        grid_draw.line((0, y, WIDTH, y), fill=(96, 162, 172, 9), width=1)

    random.seed(11)
    for _ in range(26):
        x = random.randrange(24, WIDTH - 24)
        y = random.randrange(18, HEIGHT - 18)
        radius = random.choice((1, 1, 1, 2))
        grid_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(160, 218, 222, 22))

    image = Image.alpha_composite(image.convert("RGBA"), grid)

    ambient = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ambient_draw = ImageDraw.Draw(ambient)
    ambient_draw.ellipse((265, -52, 695, 160), fill=(20, 103, 111, 38))
    ambient = ambient.filter(ImageFilter.GaussianBlur(72))
    return Image.alpha_composite(image, ambient)


BACKGROUND = make_background()


def draw_text_glow(
    image: Image.Image,
    text: str,
    center_x: float,
    center_y: float,
    color: tuple[int, int, int],
    *,
    size: int,
    alpha: int = 255,
    glow_radius: int = 13,
    glow_color: tuple[int, int, int] | None = None,
    anchor: str = "mm",
) -> None:
    if alpha <= 0:
        return
    font = get_font(size)
    mask = Image.new("L", image.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.text((round(center_x), round(center_y)), text, font=font, fill=alpha, anchor=anchor)

    glow = Image.new("RGBA", image.size, (*(glow_color or color), 0))
    glow.putalpha(mask.filter(ImageFilter.GaussianBlur(glow_radius)))
    image.alpha_composite(glow)

    foreground = Image.new("RGBA", image.size, (*color, 0))
    foreground.putalpha(mask)
    image.alpha_composite(foreground)


def draw_final_brand(image: Image.Image, center_y: float, size: int, alpha: int) -> None:
    draw_text_glow(
        image,
        "WeClaudex",
        WIDTH / 2,
        center_y,
        BRAND_ICE_BLUE,
        size=size,
        alpha=alpha,
        glow_radius=17,
        glow_color=BRAND_ICE_GLOW,
    )


def draw_landing_ripple(image: Image.Image, center_x: float, age: float, color: tuple[int, int, int]) -> None:
    if not 0.0 <= age <= 0.42:
        return
    progress = age / 0.42
    radius = lerp(30, 126, ease_out_cubic(progress))
    alpha = round(95 * (1.0 - progress) ** 2)
    ripple = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(ripple)
    y = DROP_END_Y + 55
    draw.ellipse(
        (center_x - radius, y - radius * 0.09, center_x + radius, y + radius * 0.09),
        outline=(*color, alpha),
        width=2,
    )
    image.alpha_composite(ripple.filter(ImageFilter.GaussianBlur(1.2)))


def draw_collision_particles(image: Image.Image, time_seconds: float) -> None:
    age = time_seconds - COLLISION_END
    if not 0.0 <= age <= 0.58:
        return
    progress = age / 0.58
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    colors = (WECHAT_GREEN, CLAUDE_ORANGE, CODEX_BLUE)
    random.seed(23)
    for index in range(24):
        angle = random.random() * math.tau
        speed = random.uniform(72, 180)
        distance = speed * age * (1.0 - 0.22 * progress)
        x = WIDTH / 2 + math.cos(angle) * distance
        y = DROP_END_Y + math.sin(angle) * distance * 0.57
        radius = lerp(random.uniform(2.0, 4.6), 0.4, progress)
        alpha = round(210 * (1.0 - progress) ** 1.7)
        color = colors[index % len(colors)]
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    image.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.35)))


def draw_collision_flash(image: Image.Image, time_seconds: float) -> None:
    distance = abs(time_seconds - COLLISION_END)
    if distance > 0.28:
        return
    strength = math.exp(-((distance / 0.115) ** 2))
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    radius = lerp(36, 150, strength)
    draw.ellipse(
        (WIDTH / 2 - radius, DROP_END_Y - radius, WIDTH / 2 + radius, DROP_END_Y + radius),
        fill=(*SOFT_WHITE, round(150 * strength)),
    )
    image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(35)))


def render_word(image: Image.Image, word: dict[str, object], time_seconds: float) -> None:
    start = float(word["start"])
    end = float(word["end"])
    if time_seconds < start:
        return

    base_x = float(word["x"])
    color = word["color"]
    text = str(word["text"])
    size = WORD_FONT_SIZE
    alpha = 255
    x = base_x

    if time_seconds <= end:
        progress = clamp((time_seconds - start) / (end - start))
        y = lerp(-70, DROP_END_Y, ease_out_bounce(progress))
        alpha = round(255 * ease_out_cubic(progress / 0.22))
        speed = abs(DROP_END_Y + 70) * (1.0 - progress)
        for offset, trail_alpha in ((18, 36), (34, 17)):
            if speed > 14:
                draw_text_glow(
                    image,
                    text,
                    x,
                    y - offset,
                    color,
                    size=size,
                    alpha=round(trail_alpha * (1.0 - progress)),
                    glow_radius=9,
                )
    else:
        y = DROP_END_Y

    draw_landing_ripple(image, base_x, time_seconds - end, color)

    if time_seconds >= COLLISION_START:
        progress = clamp((time_seconds - COLLISION_START) / (COLLISION_END - COLLISION_START))
        eased = ease_in_out_cubic(progress)
        x = lerp(base_x, WIDTH / 2, eased)
        y = DROP_END_Y + math.sin(progress * math.pi) * (base_x - WIDTH / 2) / 25.0
        size = round(WORD_FONT_SIZE * lerp(1.0, 0.72, eased))
        alpha = round(255 * (1.0 - clamp((progress - 0.68) / 0.32)))

        if 0.03 < progress < 0.92:
            trail = Image.new("RGBA", image.size, (0, 0, 0, 0))
            trail_draw = ImageDraw.Draw(trail)
            trail_draw.line(
                (base_x, DROP_END_Y, x, y),
                fill=(*color, round(72 * math.sin(progress * math.pi))),
                width=3,
            )
            image.alpha_composite(trail.filter(ImageFilter.GaussianBlur(5)))

    draw_text_glow(image, text, x, y, color, size=size, alpha=alpha, glow_radius=12)


def render_frame(frame_index: int) -> Image.Image:
    time_seconds = frame_index / FPS
    image = BACKGROUND.copy()

    for word in WORDS:
        render_word(image, word, time_seconds)

    draw_collision_flash(image, time_seconds)
    draw_collision_particles(image, time_seconds)

    if time_seconds >= FINAL_START:
        progress = clamp((time_seconds - FINAL_START) / FINAL_REVEAL_DURATION)
        scale = lerp(0.68, 1.0, ease_out_back(progress))
        final_alpha = round(255 * ease_out_cubic(progress))
        if time_seconds >= FADE_START:
            final_alpha = round(final_alpha * (1.0 - clamp((time_seconds - FADE_START) / (DURATION_SECONDS - FADE_START))))
        draw_final_brand(image, DROP_END_Y, round(BRAND_FONT_SIZE * scale), final_alpha)

    if time_seconds >= FADE_START:
        fade = clamp((time_seconds - FADE_START) / (DURATION_SECONDS - FADE_START))
        cover = Image.new("RGBA", image.size, (*BACKGROUND_TOP, round(255 * fade)))
        image.alpha_composite(cover)

    return image.convert("RGB")


def assembly_drop_state(word: dict[str, object], time_seconds: float) -> tuple[float, int] | None:
    start = float(word["start"])
    end = float(word["end"])
    if time_seconds < start:
        return None
    if time_seconds >= end:
        return DROP_END_Y, 255

    progress = clamp((time_seconds - start) / (end - start))
    y = lerp(-55, DROP_END_Y, ease_out_bounce(progress))
    alpha = round(255 * ease_out_cubic(progress / 0.22))
    return y, alpha


def draw_assembly_overlap_flash(image: Image.Image, move_progress: float, unify_progress: float) -> None:
    arrival = clamp((move_progress - 0.68) / 0.32)
    strength = ease_out_cubic(arrival) * (1.0 - ease_out_cubic(unify_progress))
    if strength <= 0.01:
        return

    font = get_font(WORD_FONT_SIZE)
    brand_left = (WIDTH - font.getlength("WeClaudex")) / 2.0
    overlap_centers = (
        brand_left + font.getlength("We") + font.getlength("C") / 2.0,
        brand_left + font.getlength("WeClau") + font.getlength("de") / 2.0,
    )

    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    radius = lerp(13, 25, strength)
    for center_x in overlap_centers:
        draw.ellipse(
            (center_x - radius, DROP_END_Y - radius, center_x + radius, DROP_END_Y + radius),
            fill=(*SOFT_WHITE, round(130 * strength)),
        )
    image.alpha_composite(layer.filter(ImageFilter.GaussianBlur(12)))


def render_assembly_frame(frame_index: int) -> Image.Image:
    time_seconds = frame_index / FPS
    image = BACKGROUND.copy()
    font = get_font(WORD_FONT_SIZE)
    move_linear = clamp((time_seconds - ASSEMBLY_MOVE_START) / (ASSEMBLY_MOVE_END - ASSEMBLY_MOVE_START))
    move_progress = ease_in_out_cubic(move_linear)
    removal_progress = ease_in_out_cubic(clamp((move_linear - 0.12) / 0.72))
    unify_progress = clamp(
        (time_seconds - ASSEMBLY_FINAL_START) / ASSEMBLY_FINAL_REVEAL_DURATION
    )
    colored_alpha_scale = 1.0 - ease_out_cubic(clamp((unify_progress - 0.12) / 0.88))
    brand_left = (WIDTH - font.getlength("WeClaudex")) / 2.0

    for word in ASSEMBLY_WORDS:
        drop_state = assembly_drop_state(word, time_seconds)
        if drop_state is None:
            continue

        y, source_alpha = drop_state
        full = str(word["full"])
        keep = str(word["keep"])
        removed = str(word["remove"])
        color = word["color"]
        source_left = float(word["x"]) - font.getlength(full) / 2.0
        if bool(word["remove_first"]):
            removed_left = source_left
            keep_left = source_left + font.getlength(removed)
        else:
            keep_left = source_left
            removed_left = source_left + font.getlength(keep)

        target_left = brand_left + font.getlength(str(word["target_prefix"]))
        keep_x = lerp(keep_left, target_left, move_progress)
        keep_y = y + math.sin(move_progress * math.pi) * float(word["arc"])
        keep_alpha = round(source_alpha * colored_alpha_scale)
        draw_text_glow(
            image,
            keep,
            keep_x,
            keep_y,
            color,
            size=WORD_FONT_SIZE,
            alpha=keep_alpha,
            glow_radius=11,
            anchor="lm",
        )

        if removal_progress < 1.0:
            removed_alpha = round(source_alpha * (1.0 - ease_out_cubic(removal_progress)))
            assembly_delta_x = keep_x - keep_left
            assembly_delta_y = keep_y - y
            removed_x = removed_left + assembly_delta_x + float(word["drift_x"]) * removal_progress
            removed_y = y + assembly_delta_y + float(word["drift_y"]) * removal_progress
            draw_text_glow(
                image,
                removed,
                removed_x,
                removed_y,
                color,
                size=WORD_FONT_SIZE,
                alpha=removed_alpha,
                glow_radius=11,
                anchor="lm",
            )

        draw_landing_ripple(image, float(word["x"]), time_seconds - float(word["end"]), color)

    draw_assembly_overlap_flash(image, move_progress, unify_progress)

    if time_seconds >= ASSEMBLY_FINAL_START:
        final_alpha = round(255 * ease_out_cubic(unify_progress))
        if time_seconds >= ASSEMBLY_FADE_START:
            final_alpha = round(
                final_alpha
                * (1.0 - clamp((time_seconds - ASSEMBLY_FADE_START) / (DURATION_SECONDS - ASSEMBLY_FADE_START)))
            )
        draw_final_brand(image, DROP_END_Y, BRAND_FONT_SIZE, final_alpha)

    if time_seconds >= ASSEMBLY_FADE_START:
        fade = clamp((time_seconds - ASSEMBLY_FADE_START) / (DURATION_SECONDS - ASSEMBLY_FADE_START))
        cover = Image.new("RGBA", image.size, (*BACKGROUND_TOP, round(255 * fade)))
        image.alpha_composite(cover)

    return image.convert("RGB")


def build_palette(frames: list[Image.Image]) -> Image.Image:
    sample_times = (0.0, 0.8, 1.55, 2.4, 3.3, 3.8, 4.4, 6.3, 7.55)
    sample_indices = [round(time_seconds * FPS) for time_seconds in sample_times]
    sample_width = WIDTH // 3
    sample_height = HEIGHT // 3
    palette_source = Image.new("RGB", (sample_width * 3, sample_height * 3))
    for position, frame_index in enumerate(sample_indices):
        thumbnail = frames[min(frame_index, len(frames) - 1)].resize((sample_width, sample_height), Image.Resampling.LANCZOS)
        palette_source.paste(thumbnail, ((position % 3) * sample_width, (position // 3) * sample_height))
    return palette_source.quantize(colors=256, method=Image.Quantize.MEDIANCUT)


def save_contact_sheet(
    frames: list[Image.Image],
    path: Path,
    times: tuple[float, ...] = (0.72, 1.55, 2.40, 3.48, 4.20, 7.00),
) -> None:
    sheet = Image.new("RGB", (WIDTH * 3, HEIGHT * 2), BACKGROUND_TOP)
    label_font = get_font(22, regular=True)
    for index, time_seconds in enumerate(times):
        frame = frames[min(round(time_seconds * FPS), len(frames) - 1)].copy()
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle((18, 16, 105, 49), radius=11, fill=(0, 0, 0, 135))
        draw.text((61, 33), f"{time_seconds:.1f}s", font=label_font, fill=SOFT_WHITE, anchor="mm")
        sheet.paste(frame, ((index % 3) * WIDTH, (index // 3) * HEIGHT))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path)
    parser.add_argument("--variant", choices=("collision", "assembly"), default="assembly")
    args = parser.parse_args()

    renderer = render_assembly_frame if args.variant == "assembly" else render_frame
    frames = [renderer(index) for index in range(FRAME_COUNT)]
    palette = build_palette(frames)
    quantized = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE)
        for frame in frames
    ]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(
        args.output,
        save_all=True,
        append_images=quantized[1:],
        # Supplying one duration per source frame lets Pillow merge static
        # frames while preserving their accumulated display time.
        duration=[round(1000 / FPS)] * len(quantized),
        loop=0,
        disposal=2,
        optimize=True,
    )

    if args.contact_sheet:
        times = (0.60, 1.30, 2.15, 2.82, 3.68, 4.50) if args.variant == "assembly" else None
        if times is None:
            save_contact_sheet(frames, args.contact_sheet)
        else:
            save_contact_sheet(frames, args.contact_sheet, times)


if __name__ == "__main__":
    main()
