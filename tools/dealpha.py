# -*- coding: utf-8 -*-
"""
图标去底工具 —— 把图像模型输出的「浅灰近白纯色背景」抠成透明。

原理：只抠掉「颜色接近浅灰背景 且 从图像四边连通进来」的像素，
主体内部的白色（盔甲高光/羊皮纸/麦穗）因不与边缘连通而被保留。
边缘做 1px 收边去光晕 + 轻微羽化。

安全阀：若某张被判定去除 >92%（说明主体被误当背景吃掉），跳过不覆盖并报警。

仅处理 36 张图标类，跳过 4 张满幅背景/地块（ui_bg / map_tile_*）。
用法：python tools/dealpha.py
"""
import os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "packages", "client", "public", "art")

# 满幅背景/地块：本就该不透明，跳过
SKIP = {"ui_bg_parchment", "map_tile_empty", "map_tile_village", "map_tile_oasis"}

LUM_MIN = 170     # 背景亮度下限（浅灰 166~255）
SPREAD_MAX = 22   # 中性色：R/G/B 极差上限（彩色主体极差大，被排除）
MAX_REMOVE = 0.92 # 去除比例超过则视为误吃主体，跳过


def dealpha(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im, dtype=np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    spread = a.max(axis=2) - a.min(axis=2)
    bg_cand = (lum > LUM_MIN) & (spread < SPREAD_MAX)

    # 连通域：只保留与图像边缘相连的背景块（保护主体内部白色）
    lbl, n = ndimage.label(bg_cand)
    border = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
    border.discard(0)
    bg = np.isin(lbl, list(border)) if border else np.zeros_like(bg_cand)

    removed = bg.mean()
    if removed > MAX_REMOVE:
        return removed, False  # 疑似吃主体，跳过

    # 1px 收边去浅色光晕
    bg = ndimage.binary_dilation(bg, iterations=1)
    alpha = np.where(bg, 0, 255).astype(np.uint8)

    out = im.convert("RGBA")
    aimg = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.8))  # 轻羽化
    out.putalpha(aimg)
    out.save(path)
    return removed, True


def main():
    files = sorted(f for f in os.listdir(ART)
                   if f.endswith(".png") and f[:-4] not in SKIP)
    done, skipped = 0, []
    for f in files:
        removed, ok = dealpha(os.path.join(ART, f))
        tag = "OK " if ok else "跳过!"
        print(f"{tag} {f:24s} 去除 {removed*100:5.1f}%")
        if ok:
            done += 1
        else:
            skipped.append(f)
    print(f"\n完成 {done}/{len(files)}，跳过 {len(skipped)}: {skipped or '无'}")


if __name__ == "__main__":
    main()
