"""Assemble actual app captures into the README tour (Python + Pillow)."""
from pathlib import Path
import os
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "docs/images"
W, H = 1100, 720
BG, INK, MUTED, GREEN = "#f3efe7", "#183b32", "#66746c", "#355c50"


def font(size, bold=False):
    candidates = [
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / ("segoeuib.ttf" if bold else "segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


stages = [
    ("create-survey.png", "Create a monthly survey", "Choose the month and a response deadline. Standard shifts are generated for you.", "Create"),
    ("availability.png", "Collect real availability", "People select the shifts they can work through a public survey link.", "Collect"),
    ("responses.png", "Review who is taking part", "Check submitted availability, inclusion, hour caps, and target reductions.", "Review"),
    ("allocation.png", "Preview, allocate, and adjust", "Inspect a dry run, preserve manual assignments, and keep recovery points.", "Allocate"),
    ("allocation-stats.png", "Understand the result", "Review coverage, workload, exceptions, and the per-shift audit.", "Inspect"),
    ("calendar.png", "Share a readable schedule", "Export PNG, PDF, CSV, or an editable Excel calendar.", "Export"),
]


def panel(index):
    filename, title, description, _ = stages[index]
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    d.text((26, 18), "SHIFT ALLOCATOR  /  MONTHLY WORKFLOW", font=font(13, True), fill=MUTED)
    d.text((26, 41), title, font=font(32, True), fill=INK)
    d.text((26, 87), description, font=font(17), fill=MUTED)
    d.text((1010, 45), f"0{index+1}/06", font=font(18, True), fill=GREEN)
    shot = Image.open(IMAGES / filename).convert("RGB")
    if filename == "calendar.png":
        # First two calendar weeks; the README links the complete exported month.
        shot = shot.crop((0, 0, shot.width, min(shot.height, 825)))
    shot = ImageOps.contain(shot, (1048, 502), Image.Resampling.LANCZOS)
    x, y = (W-shot.width)//2, 129+(502-shot.height)//2
    d.rounded_rectangle((22, 125, 1078, 635), radius=10, fill="white", outline="#d7d9cf", width=1)
    canvas.paste(shot, (x,y))
    for i, stage in enumerate(stages):
        start = 27 + i*175
        color = GREEN if i == index else "#e4e5dc"
        d.rounded_rectangle((start,650,start+161,679), radius=8, fill=color)
        d.text((start+12,655), f"{i+1}  {stage[3]}", font=font(13,True), fill="white" if i==index else MUTED)
    d.text((28,694), "Actual app views · Fictional demo data · Guided tour", font=font(12), fill=MUTED)
    return canvas


panels = [panel(i) for i in range(len(stages))]
frames, durations = [], []
for i, current in enumerate(panels):
    frames.append(current)
    durations.append(2900)
    following = panels[(i+1)%len(panels)]
    for step in range(1, 6):
        frames.append(Image.blend(current, following, step/6))
        durations.append(60)
# A common palette prevents color flicker between transitions.
palette_image = Image.new("RGB", (W, H*len(panels)))
for i, frame in enumerate(panels):
    palette_image.paste(frame,(0,i*H))
palette = palette_image.quantize(colors=192)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
indexed[0].save(IMAGES/'workflow.gif', save_all=True, append_images=indexed[1:], duration=durations, loop=0, optimize=True, disposal=1)
panels[0].save(IMAGES/'workflow-poster.png',optimize=True)
print(f"Created {len(frames)} frames; {(IMAGES/'workflow.gif').stat().st_size:,} bytes")
