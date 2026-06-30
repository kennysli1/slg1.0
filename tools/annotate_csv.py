# -*- coding: utf-8 -*-
"""
给 config/*.csv 做两件事，解决「Excel 打开乱码」+「字段看不懂」：
  1. 写入 UTF-8 BOM —— Excel 见 BOM 即按 UTF-8 解析，中文不再乱码。
  2. 在表头下插入一行「# 开头的中文字段注释」—— 配置时直接在表里看懂每列含义。
     该注释行首列以 # 开头，CSV 解析器(packages/server/src/infra/csv.ts)会跳过，代码不读。

幂等：可重复运行。会先剥掉旧 BOM、删掉旧的 # 注释行，再按下面的 COMMENTS 重写。
运行：python tools/annotate_csv.py
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "config")

# 每个文件：列 -> 中文说明（顺序需与表头一致；首列说明会自动加 # 前缀）
COMMENTS = {
    "buildings.csv": [
        "建筑标识(代码用,勿改)", "显示名", "图标占位", "木材基价", "泥土基价",
        "铁矿基价", "粮食基价", "造价增长率/级", "建造基础秒数", "时间增长率/级",
        "最高等级", "前置(如barracks:3,多个用|)",
    ],
    "fields.csv": [
        "资源田标识(代码用)", "显示名", "图标占位", "产出资源", "每级产量基数",
        "产量增长率/级", "木材基价", "泥土基价", "铁矿基价", "粮食基价",
        "造价增长率/级", "升级基础秒数", "时间增长率/级", "最高等级",
    ],
    "units.csv": [
        "兵种标识(代码用)", "所属部族", "显示名", "图标占位", "兵种类别",
        "攻击力", "对步防御", "对骑防御", "移动速度", "负重(掠夺量)",
        "每小时耗粮", "木材造价", "泥土造价", "铁矿造价", "粮食造价",
        "训练秒数/个", "所需建筑",
    ],
    "resources.csv": [
        "资源标识(代码用)", "显示名", "图标占位", "用途备注",
    ],
    "pve_targets.csv": [
        "野怪类型标识", "显示名", "图标占位", "重生秒数", "掠夺木材",
        "掠夺泥土", "掠夺铁矿", "掠夺粮食",
    ],
    "pve_defenders.csv": [
        "所属野怪类型", "守军兵种标识", "显示名", "数量", "攻击力",
        "对步防御", "对骑防御", "负重",
    ],
    "pve_spawns.csv": [
        "刷新点标识", "野怪类型", "地图X坐标", "地图Y坐标",
    ],
}


def process(fn, descs):
    path = os.path.join(CFG, fn)
    with open(path, "r", encoding="utf-8-sig") as f:  # utf-8-sig 自动剥离已有 BOM
        lines = f.read().split("\n")
    # 去掉末尾空行造成的空字符串，稍后统一处理
    while lines and lines[-1].strip() == "":
        lines.pop()
    if not lines:
        print(f"跳过(空文件): {fn}")
        return
    header = lines[0]
    ncol = len(header.split(","))
    # 删除旧的 # 注释行（首列以 # 开头）
    body = [ln for ln in lines[1:] if not ln.lstrip().startswith("#")]
    # 构造新注释行：首列加 # 前缀
    cells = list(descs) + [""] * (ncol - len(descs))  # 补齐列数
    cells = cells[:ncol]
    cells[0] = "#" + cells[0]
    comment = ",".join(cells)
    out = [header, comment] + body
    # 写回：UTF-8 with BOM，行尾用 \r\n（Excel 友好）
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write("\r\n".join(out) + "\r\n")
    print(f"已处理: {fn}  (列数 {ncol}, 注释 {len(descs)})")


def main():
    for fn, descs in COMMENTS.items():
        process(fn, descs)
    print("完成。Excel 重新打开应不再乱码，表头下方为中文字段说明行。")


if __name__ == "__main__":
    main()
