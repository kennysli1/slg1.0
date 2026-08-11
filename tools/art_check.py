# -*- coding: utf-8 -*-
"""
抠像结果自查：找出「背景没抠掉」的图标。

图像模型偶尔无视洋红幕布要求，改画一张「圆角白卡 + 假透明棋盘格」当底。
这种图只有四角的洋红被抠掉，卡片本体留着 —— 放到深色面板上就是一个亮色方块。

两条判据（任一命中即判坏）：
  1. 不透明像素占比过高（正常抠图有大量留边，mean alpha 应明显偏低）；
  2. 不透明区里「高明度低饱和」的近白灰像素占比过高（棋盘格/白卡的特征）。
    注意灰石建筑本身偏灰，所以阈值取在明度很高的一段，避免误伤石墙。

用法：python tools/art_check.py          只报告
     python tools/art_check.py --json   输出坏图基名的 JSON 数组（喂给重出图流程）
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "packages", "client", "public", "art")
MANIFEST = os.path.join(ROOT, "tools", "art_manifest.json")
MEAN_ALPHA_BAD = 185    # 不透明占比过高 → 背景没抠掉
FLAT_LIGHT_BAD = 0.22   # 近白灰像素占不透明区比例超过此值 → 白卡/棋盘格残留
# 这几张本来就是「铺满整块」的 UI 底板，mean alpha 高是正常的，不参与占比判据
FULL_FRAME_OK = {"ui_slot_empty", "ui_btn_plate", "ui_lvl_badge", "ui_banner_ribbon"}


def diagnose(im: Image.Image) -> tuple[float, float]:
    """返回 (平均 alpha, 不透明区里近白灰像素占比)。"""
    a = np.asarray(im.convert("RGBA")).astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    mean_alpha = float(al.mean())

    opaque = al > 200
    n = int(opaque.sum())
    if n == 0:
        return mean_alpha, 0.0
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    flat_light = opaque & (mx > 205) & ((mx - mn) < 22)
    return mean_alpha, float(flat_light.sum()) / n


def main() -> None:
    with open(MANIFEST, "r", encoding="utf-8") as fh:
        entries = json.load(fh)

    bad, missing, ok = [], [], 0
    for e in entries:
        if e.get("mode") != "icon":
            continue
        p = os.path.join(ART, e["base"] + ".webp")
        if not os.path.exists(p):
            missing.append(e["base"])
            continue
        with Image.open(p) as im:
            mean_alpha, flat = diagnose(im)
        if e["base"] in FULL_FRAME_OK:
            mean_alpha = 0.0
        if mean_alpha > MEAN_ALPHA_BAD or flat > FLAT_LIGHT_BAD:
            bad.append((e["base"], round(mean_alpha, 1), round(flat, 3)))
        else:
            ok += 1

    if "--json" in sys.argv:
        print(json.dumps([b for b, _, _ in bad], ensure_ascii=False))
        return

    print(f"合格 {ok} 张 · 背景残留 {len(bad)} 张 · 缺文件 {len(missing)} 张\n")
    if bad:
        print("背景没抠掉（需重出图，务必强调纯平洋红底）：")
        for b, ma, flat in sorted(bad, key=lambda x: -x[1]):
            print(f"  {b:26s} mean_alpha={ma:5.1f}  近白灰占比={flat:.2f}")
    if missing:
        print(f"\n缺文件：{', '.join(missing)}")


if __name__ == "__main__":
    main()
