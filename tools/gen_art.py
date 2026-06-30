# -*- coding: utf-8 -*-
"""
美术占位图生成器 —— 生成"白底 + 顶部分类色条 + 居中中文标签"的 PNG 占位图。

用途：在真正美术资源到位前，提供命名规范、尺寸统一的可替换占位图。
将来美术出图后，按相同文件名覆盖 packages/client/public/art/ 下的同名文件即可，
无需改动任何代码。

文件命名规范见 docs/美术资源清单.md：  类别_名称.png （全小写下划线）
运行：  python tools/gen_art.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

# ---- 输出目录（相对仓库根） ----
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "packages", "client", "public", "art")
os.makedirs(OUT, exist_ok=True)

SIZE = 128            # 图标统一 128×128
BAR = 14              # 顶部分类色条高度
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"   # 微软雅黑 Bold

# ---- 分类色板（仅用于占位区分，不代表最终美术配色） ----
CAT = {
    "res":   ("#8a6d4d", "资源"),
    "field": ("#5f8a4d", "资源田"),
    "bld":   ("#4d6f8a", "建筑"),
    "unit":  ("#9a4d4d", "兵种"),
    "pve":   ("#6b4d8a", "野怪"),
    "ui":    ("#8a7a4d", "界面"),
    "map":   ("#4d8a7a", "地图"),
}

# ---- 资源清单：文件名前缀 -> {key: 中文标签} ----
ASSETS = {
    "res": {
        "wood": "木材", "clay": "泥土", "iron": "铁矿", "crop": "粮食",
    },
    "field": {
        "woodcutter": "伐木场", "claypit": "采泥场",
        "ironmine": "铁矿场", "cropland": "农田",
    },
    "bld": {
        "main": "主基地", "warehouse": "仓库", "granary": "粮仓",
        "barracks": "兵营", "stable": "马厩", "workshop": "兵工厂",
        "academy": "学院", "smithy": "铁匠铺", "wall": "城墙",
        "rallypoint": "集结点",
    },
    "unit": {
        "legionnaire": "军团兵", "praetorian": "禁卫兵", "imperian": "帝国兵",
        "equlegati": "侦察骑兵", "equimperatoris": "近卫骑兵", "equcaesaris": "凯撒骑兵",
        "ram": "攻城锤", "catapult": "投石机", "senator": "元老", "settler": "拓荒者",
    },
    "pve": {
        "rats": "老鼠窝", "wolves": "野狼群", "bandits": "强盗营",
    },
    "ui": {
        "logo": "LOGO", "tab_village": "村庄", "tab_army": "军队",
        "tab_map": "地图", "tab_reports": "报告",
    },
}


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def fit_font(text, max_w, start=30, lo=12):
    """从 start 号往下找能塞进 max_w 宽度的字号。"""
    for sz in range(start, lo - 1, -2):
        f = ImageFont.truetype(FONT_PATH, sz)
        if f.getlength(text) <= max_w:
            return f
    return ImageFont.truetype(FONT_PATH, lo)


def gen(prefix, key, label):
    bar_hex, _ = CAT[prefix]
    img = Image.new("RGB", (SIZE, SIZE), "#ffffff")
    d = ImageDraw.Draw(img)

    # 顶部分类色条
    d.rectangle([0, 0, SIZE, BAR], fill=hex2rgb(bar_hex))
    # 细边框
    d.rectangle([0, 0, SIZE - 1, SIZE - 1], outline="#d8cdb5", width=1)

    # 居中中文标签（自适应字号，最多两行）
    text = label
    font = fit_font(text, SIZE - 16, start=30)
    # 若单行还是太挤，且字数>=3，则折成两行
    if font.size <= 16 and len(text) >= 3:
        mid = (len(text) + 1) // 2
        lines = [text[:mid], text[mid:]]
    else:
        lines = [text]

    line_h = font.size + 6
    total_h = line_h * len(lines)
    y0 = BAR + (SIZE - BAR - total_h) / 2
    for i, ln in enumerate(lines):
        w = font.getlength(ln)
        d.text(((SIZE - w) / 2, y0 + i * line_h), ln, fill="#2a2a2a", font=font)

    fn = f"{prefix}_{key}.png"
    img.save(os.path.join(OUT, fn))
    return fn


def main():
    count = 0
    for prefix, items in ASSETS.items():
        for key, label in items.items():
            gen(prefix, key, label)
            count += 1
    print(f"已生成 {count} 张占位图 -> {OUT}")


if __name__ == "__main__":
    main()
