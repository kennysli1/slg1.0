# -*- coding: utf-8 -*-
"""
美术图优化 —— 降采样 + 压缩，解决"1024px/1.5MB 图标只显示 48px"导致的加载慢。

图标类降到 256×256（最大显示 72px 的 ~3x，够视网膜屏），背景/地块类降到 512。
全部 optimize 压缩。原图（1024）在 git 历史里可恢复（commit 3f232ac）。
用法：python tools/optimize_art.py
"""
import os
from PIL import Image

ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "packages", "client", "public", "art")

# 背景/地块可能显示较大，降到 512；其余图标 256 足够
BIG = {"ui_bg_parchment", "map_tile_empty", "map_tile_village", "map_tile_oasis"}
ICON_MAX, BIG_MAX = 256, 512


def main():
    before = after = 0
    for f in sorted(os.listdir(ART)):
        if not f.endswith(".png"):
            continue
        p = os.path.join(ART, f)
        before += os.path.getsize(p)
        im = Image.open(p)
        target = BIG_MAX if f[:-4] in BIG else ICON_MAX
        if max(im.size) > target:
            im.thumbnail((target, target), Image.LANCZOS)
        # 保留透明通道；optimize 压缩
        im.save(p, "PNG", optimize=True)
        sz = os.path.getsize(p)
        after += sz
        print(f"{f:24s} {im.size[0]}x{im.size[1]}  {sz/1024:6.1f} KB")
    print(f"\n总大小 {before/1024/1024:.1f} MB -> {after/1024/1024:.2f} MB  (缩小 {before/after:.1f}x)")


if __name__ == "__main__":
    main()
