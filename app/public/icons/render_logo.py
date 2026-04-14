"""Render the bean logo to PNG using Pillow."""
from PIL import Image, ImageDraw
import math

SIZE = 1024
MID = SIZE // 2  # 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Squircle badge (#1A0808) ---
badge_margin = 40
badge_radius = 188
draw.rounded_rectangle(
    [badge_margin, badge_margin, SIZE - badge_margin, SIZE - badge_margin],
    radius=badge_radius,
    fill=(0x1A, 0x08, 0x08, 255),
)

# --- Layout math ---
# Both elements must have the same VISUAL bounding height.
# Chevron visual height = arm_span + stroke_w (round caps add half-stroke each end)
# Bean visual height = 2 * bean_ry
# We want both = 280px
vis_h = 280
stroke_w = 52
arm_span = vis_h - stroke_w  # 228 — distance between chevron arm endpoints
chev_depth = 150  # horizontal depth of the chevron (left-to-tip)
gap = 70  # gap between chevron right edge and bean left edge
bean_ry = vis_h // 2  # 140
bean_rx = int(bean_ry * 0.74)  # ~104, natural bean proportion

# Bounding widths (including stroke caps)
chev_vis_w = chev_depth + stroke_w  # 202
bean_vis_w = 2 * bean_rx  # 208
total_w = chev_vis_w + gap + bean_vis_w  # 480

# Center the pair horizontally
start_x = MID - total_w // 2  # left edge of chevron visual bbox

# Chevron coordinates (centerline at y=MID)
chev_left = start_x + stroke_w // 2  # left arm x (inset half stroke for cap)
chev_tip = chev_left + chev_depth
half_arm = arm_span // 2

cream = (0xF0, 0xDC, 0xC8, 255)

def draw_thick_line(drw, x0, y0, x1, y1, width, fill):
    angle = math.atan2(y1 - y0, x1 - x0)
    dx = math.sin(angle) * width / 2
    dy = math.cos(angle) * width / 2
    coords = [
        (x0 - dx, y0 + dy),
        (x0 + dx, y0 - dy),
        (x1 + dx, y1 - dy),
        (x1 - dx, y1 + dy),
    ]
    drw.polygon(coords, fill=fill)
    r = width // 2
    drw.ellipse([x0 - r, y0 - r, x0 + r, y0 + r], fill=fill)
    drw.ellipse([x1 - r, y1 - r, x1 + r, y1 + r], fill=fill)

draw_thick_line(draw, chev_left, MID - half_arm, chev_tip, MID, stroke_w, cream)
draw_thick_line(draw, chev_tip, MID, chev_left, MID + half_arm, stroke_w, cream)

# --- Coffee bean ---
bean_cx = start_x + chev_vis_w + gap + bean_rx
bean_cy = MID

bean_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bean_draw = ImageDraw.Draw(bean_img)

# Full body — light roast #C08050
bean_draw.ellipse(
    [bean_cx - bean_rx, bean_cy - bean_ry, bean_cx + bean_rx, bean_cy + bean_ry],
    fill=(0xC0, 0x80, 0x50, 255),
)

# Shadow right half #8B5530
shadow_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(shadow_img).ellipse(
    [bean_cx - bean_rx, bean_cy - bean_ry, bean_cx + bean_rx, bean_cy + bean_ry],
    fill=(0x8B, 0x55, 0x30, 255),
)
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rectangle([bean_cx, 0, SIZE, SIZE], fill=255)
shadow_cropped = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
shadow_cropped.paste(shadow_img, mask=mask)
bean_img = Image.alpha_composite(bean_img, shadow_cropped)

# Highlight on upper-left curve #D4965E
bd = ImageDraw.Draw(bean_img)
hx, hy = bean_cx - 35, bean_cy - 70
bd.ellipse([hx - 32, hy - 20, hx + 32, hy + 20], fill=(0xD4, 0x96, 0x5E, 160))

# S-curve crease #6B3A20
crease_color = (0x6B, 0x3A, 0x20, 255)
crease_points = []
for t in range(100):
    frac = t / 99.0
    y = bean_cy - bean_ry * 0.80 + frac * bean_ry * 1.60
    x = bean_cx + 16 * math.sin((frac - 0.5) * math.pi * 2)
    crease_points.append((x, y))

crease_w = 10
for i in range(len(crease_points) - 1):
    x0, y0 = crease_points[i]
    x1, y1 = crease_points[i + 1]
    bd.line([(x0, y0), (x1, y1)], fill=crease_color, width=crease_w)
for pt in [crease_points[0], crease_points[-1]]:
    r = crease_w // 2
    bd.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=crease_color)

img = Image.alpha_composite(img, bean_img)

out_path = r"C:\Users\nbrady\personal\foundry-local\foundry-local-demo\public\icons\bean-logo-dark.png"
img.save(out_path, "PNG")
print(f"Saved to {out_path}")
