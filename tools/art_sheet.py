# -*- coding: utf-8 -*-
"""
出图自查用的拼版图：把一组美术按网格贴到深色底上，一眼看成套一致性。
用法：python tools/art_sheet.py <输出png> <cell> <base1> <base2> ...
     python tools/art_sheet.py out.png 150 --cat bld field res
"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "packages", "client", "public", "art")
BG = (18, 22, 29)


def main() -> None:
    out = sys.argv[1]
    cell = int(sys.argv[2])
    rest = sys.argv[3:]

    if rest and rest[0] == "--cat":
        cats = set(rest[1:])
        with open(os.path.join(ROOT, "tools", "art_manifest.json"), "r", encoding="utf-8") as fh:
            bases = [e["base"] for e in json.load(fh) if e["category"] in cats]
    else:
        bases = rest

    imgs = []
    for b in bases:
        p = os.path.join(ART, b + ".webp")
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGBA")
        im.thumbnail((cell, cell), Image.LANCZOS)
        imgs.append((b, im))

    if not imgs:
        print("没有可拼的图", file=sys.stderr)
        return

    cols = min(8, len(imgs))
    rows = (len(imgs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), BG)
    for i, (_b, im) in enumerate(imgs):
        cx = (i % cols) * cell + (cell - im.width) // 2
        cy = (i // cols) * cell + (cell - im.height) // 2
        sheet.paste(im, (cx, cy), im)
    sheet.save(out)
    print(f"{out}  {len(imgs)} 张  {cols}x{rows}")


if __name__ == "__main__":
    main()
