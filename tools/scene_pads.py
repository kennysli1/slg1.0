# -*- coding: utf-8 -*-
"""
从村庄底图里量出「建筑垫台」的归一化坐标，供前端 VillageScene 的槽位布局表使用。

垫台在底图上是成片的暖色裸土（khaki/tan），本脚本按颜色掩膜找连通块、
过滤太小的噪点，输出每块的中心点（0~1 归一化）、面积占比与建议缩放。

用法：python tools/scene_pads.py [底图路径]
输出：按「先中心、再外圈顺时针」排序的坐标清单 + 一张标注图 _scene_pads.png
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT = os.path.join(ROOT, "packages", "client", "public", "art", "scene_village_ground.webp")
# 腐蚀半径：够大才能断开垫台之间的土路细颈
EROSION = int(os.environ.get("PAD_EROSION", "13"))


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    im = Image.open(src).convert("RGB")
    W, H = im.size
    a = np.asarray(im).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    # 暖色裸土：偏亮、红明显高于蓝、红绿接近（排除纯绿草与灰石）
    mask = (r > 135) & (g > 110) & (b < 175) & (r - b > 40) & (np.abs(r - g) < 50)
    mask = ndimage.binary_closing(mask, structure=np.ones((5, 5)))
    # 垫台之间由狭窄土路相连，会连成一坨 —— 用较大的腐蚀先断开细颈，
    # 再按腐蚀后的连通块打标签，最后在原掩膜上按标签生长回来。
    core = ndimage.binary_erosion(mask, structure=np.ones((EROSION, EROSION)))
    lab_core, n_core = ndimage.label(core)
    lab = ndimage.grey_dilation(lab_core, size=(EROSION * 2 + 1, EROSION * 2 + 1)) * mask
    lab = lab.astype(int)
    n = n_core

    total = W * H
    pads = []
    for i in range(1, n + 1):
        sel = lab == i
        area = int(sel.sum())
        if area < total * 0.004:      # 小于全图 0.4% 的当噪点丢掉
            continue
        ys, xs = np.where(sel)
        cy, cx = ys.mean(), xs.mean()
        h = ys.max() - ys.min() + 1
        w = xs.max() - xs.min() + 1
        pads.append({
            "x": round(float(cx / W), 4),
            "y": round(float(cy / H), 4),
            "area": round(area / total, 4),
            "w": round(float(w / W), 4),
            "h": round(float(h / H), 4),
        })

    if not pads:
        print("没找到垫台，检查颜色阈值或底图", file=sys.stderr)
        return

    # 以整体重心为圆心，按角度排序（12 点方向开始顺时针），中心块单独拎出
    ox = sum(p["x"] for p in pads) / len(pads)
    oy = sum(p["y"] for p in pads) / len(pads)
    for p in pads:
        dx, dy = p["x"] - ox, p["y"] - oy
        p["_rad"] = math.hypot(dx, dy)
        p["_ang"] = (math.degrees(math.atan2(dx, -dy))) % 360
    maxrad = max(p["_rad"] for p in pads)
    center = [p for p in pads if p["_rad"] < maxrad * 0.32]
    ring = sorted((p for p in pads if p not in center), key=lambda p: p["_ang"])

    ordered = sorted(center, key=lambda p: -p["area"]) + ring
    for p in ordered:
        p.pop("_rad"); p.pop("_ang")

    print(f"底图 {W}x{H}  找到 {len(ordered)} 块垫台（{len(center)} 中心 + {len(ring)} 外圈）\n")
    print(json.dumps(ordered, ensure_ascii=False, indent=2))

    # 标注图便于人眼核对
    vis = im.copy()
    d = ImageDraw.Draw(vis)
    for idx, p in enumerate(ordered):
        cx, cy = p["x"] * W, p["y"] * H
        rr = max(10, min(p["w"] * W, p["h"] * H) / 2)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 0, 255), width=4)
        d.text((cx - 6, cy - 8), str(idx), fill=(255, 255, 0))
    out = os.path.join(ROOT, "_scene_pads.png")
    vis.save(out)
    print(f"\n标注图：{out}")


if __name__ == "__main__":
    main()
