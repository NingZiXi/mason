"""Build responsive website screenshots from the full-resolution WebP assets."""
from pathlib import Path
from PIL import Image

assets = Path(__file__).resolve().parents[1] / "docs" / "assets"
for name in ("shot-jig", "shot-stencil"):
    with Image.open(assets / f"{name}.webp") as source:
        for width in (800, 1600):
            height = round(source.height * width / source.width)
            image = source.resize((width, height), Image.Resampling.LANCZOS)
            target = assets / f"{name}-{width}.webp"
            image.save(target, "WEBP", quality=84, method=6)
            print(f"{target.name}: {target.stat().st_size:,} bytes")
