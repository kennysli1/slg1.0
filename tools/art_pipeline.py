# -*- coding: utf-8 -*-
"""
美术资源流水线 —— 把图像模型产出的「洋红幕布图」变成可直接用的游戏资源。

图像模型无法直出 alpha 通道，所以出图时统一要求「纯平洋红 #FF00FF 背景」，
再由本脚本抠像（chroma key）+ 去洋红溢色（despill）+ 裁切留边 + 降采样。

三种模式：
  icon   抠洋红 → 透明底、裁到主体外接框、补成正方形、缩到 --size
  tile   不抠像（地块/背景贴图本来就要满幅不透明），中心裁正方形后缩放
  panel  不抠像、不裁切，等比缩到 --size（长边）

用法：
  python tools/art_pipeline.py --map tools/art_map.tsv
  python tools/art_pipeline.py --src <in.png> --out bld_main --mode icon --size 512

--map 的 TSV 每行：<源文件路径>\t<输出基名>\t<mode>\t<size>
输出一律写到 packages/client/public/art/<输出基名>.png
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "packages", "client", "public", "art")

# 抠像阈值：key = min(R,B) - G，纯洋红上 key=255，中世纪暖色主体上 key<=0
KEY_LO, KEY_HI = 45, 165
DESPILL = 1.0


def chroma_key(im: Image.Image) -> Image.Image:
    """洋红幕布 → RGBA 透明底，含边缘羽化与去溢色。"""
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    key = np.minimum(r, b) - g
    alpha = 1.0 - np.clip((key - KEY_LO) / float(KEY_HI - KEY_LO), 0.0, 1.0)

    # 去溢色：主体边缘吃到的洋红把 R/B 拉回 G 附近，避免紫边
    excess = np.clip(np.minimum(r, b) - g, 0, None) * DESPILL
    r = np.clip(r - excess, 0, 255)
    b = np.clip(b - excess, 0, 255)

    out = np.dstack([r, g, b, (alpha * 255.0)]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def trim_and_pad(im: Image.Image, margin: float) -> Image.Image:
    """裁到不透明主体的外接框，再补成正方形并留统一边距。"""
    alpha = np.asarray(im)[..., 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        return im
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    im = im.crop((x0, y0, x1, y1))

    side = int(max(im.size) * (1.0 + margin * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return canvas


def center_square(im: Image.Image) -> Image.Image:
    w, h = im.size
    s = min(w, h)
    return im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))


# WebP 质量：图标带 alpha，边缘更敏感，给高一档；地块/大图给低一档换体积
Q_ICON, Q_FLAT = 88, 84
# 这些基名额外导出一份 PNG：PWA manifest 与 apple-touch-icon 只吃 PNG
ALSO_PNG = {"ui_logo"}


def process(src: str, out_base: str, mode: str, size: int, margin: float = 0.04) -> str:
    im = Image.open(src)
    if mode == "icon":
        im = trim_and_pad(chroma_key(im), margin)
    elif mode == "tile":
        im = center_square(im.convert("RGB"))
    elif mode == "panel":
        im = im.convert("RGB")
    else:
        raise SystemExit(f"未知 mode: {mode}")

    if max(im.size) > size:
        im = im.resize(
            (size, size) if im.width == im.height
            else (size, round(im.height * size / im.width)) if im.width > im.height
            else (round(im.width * size / im.height), size),
            Image.LANCZOS,
        )

    os.makedirs(ART, exist_ok=True)
    # 正式格式是 WebP：同画质下比 PNG 小 4~6 倍，全套美术从 ~25MB 降到 ~5MB
    dst = os.path.join(ART, out_base + ".webp")
    im.save(dst, "WEBP", quality=Q_ICON if mode == "icon" else Q_FLAT, method=6)
    if out_base in ALSO_PNG:
        im.save(os.path.join(ART, out_base + ".png"), "PNG", optimize=True)
    return dst


def jobs_from_manifest(manifest_path: str, srcdir: str) -> list:
    """按 art_manifest.json 收集任务：源文件名约定为 <base>.png，放在 srcdir 下。"""
    import json
    with open(manifest_path, "r", encoding="utf-8") as fh:
        entries = json.load(fh)
    jobs = []
    for e in entries:
        src = os.path.join(srcdir, e["base"] + ".png")
        jobs.append((src, e["base"], e.get("mode", "icon"), int(e.get("size", 512))))
    return jobs


def purge_legacy_png() -> None:
    """清掉上一代 PNG 资源（除 ALSO_PNG 白名单），避免新旧两套图并存。"""
    if not os.path.isdir(ART):
        return
    for f in os.listdir(ART):
        if f.endswith(".png") and f[:-4] not in ALSO_PNG:
            os.remove(os.path.join(ART, f))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", help="TSV: src\\tout_base\\tmode\\tsize")
    ap.add_argument("--manifest", help="art_manifest.json 路径（配合 --srcdir）")
    ap.add_argument("--srcdir", help="出图目录，文件名须为 <base>.png")
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--mode", default="icon", choices=["icon", "tile", "panel"])
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--margin", type=float, default=0.04)
    ap.add_argument("--purge-png", action="store_true", help="处理前先删掉旧的 PNG 资源")
    args = ap.parse_args()

    if args.purge_png:
        purge_legacy_png()

    jobs = []
    if args.manifest:
        if not args.srcdir:
            ap.error("--manifest 需要同时给 --srcdir")
        jobs = jobs_from_manifest(args.manifest, args.srcdir)
    elif args.map:
        with open(args.map, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 4:
                    raise SystemExit(f"格式错误（需要 4 列）: {line}")
                jobs.append((parts[0], parts[1], parts[2], int(parts[3])))
    elif args.src and args.out:
        jobs.append((args.src, args.out, args.mode, args.size))
    else:
        ap.error("需要 --map 或 (--src 且 --out)")

    total = 0.0
    done = 0
    missing = []
    for src, out_base, mode, size in jobs:
        if not os.path.exists(src):
            missing.append(out_base)
            continue
        dst = process(src, out_base, mode, size, args.margin)
        kb = os.path.getsize(dst) / 1024
        total += kb
        done += 1
        with Image.open(dst) as chk:
            print(f"{out_base:26s} {mode:5s} {chk.size[0]}x{chk.size[1]}  {kb:7.1f} KB")
    print(f"\n处理 {done}/{len(jobs)} 张，合计 {total/1024:.2f} MB")
    if missing:
        print(f"缺源文件 {len(missing)} 张：{', '.join(missing)}", file=sys.stderr)


if __name__ == "__main__":
    main()
