# -*- coding: utf-8 -*-
"""PCB 钢网几何验证:
- 总厚度 = PCB 厚度 + 钢网层厚度
- 卡槽深度 = PCB 厚度(钢网层以上全空)
- 边框在 PCB 外侧实体
- 焊盘开孔只贯穿钢网层(不贯穿卡槽侧壁)
- pad_shrink 缩小后开孔面积变小
"""
import sys
import math

sys.stdout.reconfigure(encoding="utf-8")
from _common import Checker, gen_part, load_tris, solid

ck = Checker()


def stencil_params(**over):
    p = {
        "pcb_size_x": 30, "pcb_size_y": 20, "pcb_thickness": 1.6,
        "pcb_outline_points": [
            [-15, -10], [15, -10], [15, 10], [-15, 10], [-15, -10]
        ],
        "pcb_outline_holes": [],
        "stencil_thickness": 0.3, "stencil_frame_width": 8.0,
        "pocket_clearance": 0.2, "pad_shrink": 0.0,
        "pry_notch_sides": ["down"],
        "stencil_pads": [
            [[-5, -1], [5, -1], [5, 1], [-5, 1], [-5, -1]],   # 10x2 长条焊盘
            [[10, -1], [12, -1], [12, 1], [10, 1], [10, -1]],   # 2x2 小焊盘
        ],
    }
    p.update(over)
    return p


def at(tris, bx, by, bz):
    """build 坐标 (bx, by, bz) → STL 探测"""
    return solid(tris, bx, bz, -by)


print("=== 基本几何:厚度 / 卡槽 / 边框 ===")
tris = load_tris(gen_part(stencil_params(), "stencil", name="st_basic"))
PCB_T = 1.6
ST_T = 0.3
TOTAL = PCB_T + ST_T
# 钢网层内(无焊盘处)实体
ck.check("钢网层内(焊盘外)实体", at(tris, 0, 3, ST_T / 2))
# 卡槽内(钢网层以上)空
ck.check("卡槽内(中心,顶部)空", not at(tris, 0, 0, TOTAL - 0.05))
ck.check("卡槽底部(钢网层顶面稍上)空", not at(tris, 0, 0, ST_T + 0.05))
# 边框处(PCB 外侧)实体,从底到顶
ck.check("边框(x=20,y=12,钢网层)实体", at(tris, 20, 12, ST_T / 2))
ck.check("边框(x=20,y=12,顶部)实体", at(tris, 20, 12, TOTAL - 0.05))
# 钢网层外轮廓之外空
ck.check("钢网外(x=24,y=19,中间)空", not at(tris, 24, 19, ST_T / 2))

print("=== 焊盘开孔:只贯穿钢网层 ===")
# 焊盘中心在钢网层内 → 空(开孔)
ck.check("长条焊盘中心(钢网层)空", not at(tris, 0, 0, ST_T / 2))
ck.check("小焊盘中心(钢网层)空", not at(tris, 11, 0, ST_T / 2))
# 焊盘位置在卡槽内(钢网层以上)→ 空(本就是卡槽空间,不影响)
ck.check("焊盘位置(卡槽内)空", not at(tris, 0, 0, TOTAL - 0.05))
# 钢网层内、焊盘外 → 实体
ck.check("钢网层内焊盘外(y=3)实体", at(tris, 0, 3, ST_T / 2))

print("=== 取放缺口(down 侧,浅梯形凹口:长边贴槽缘、短边朝外,四角圆角) ===")
# 用 stencil_bottom:down 就是视觉下方(top 面会做 Y 镜像反向映射,见下方专项段)
# 板 30x20,槽 y∈[-10.2,10.2],frame 8:外缘 y=-18.2
# 凹口从槽缘向外切 min(4, frame/2)=4:y∈[-10.1,-14.1]
# 长边(半宽 7.4)贴槽缘、短边(半宽 6)在外端,斜坡向内张开
# 四角圆角 r=min(1.5, w_s/4, run/4)=1.0(探测点离角 >1.2mm 避开圆角区)
# 槽壁让位:缺口区上方空(镊子可伸入),但底层钢网面保持完整
tris_n = load_tris(gen_part(stencil_params(), "stencil_bottom", name="st_notch_b"))
ck.check("缺口中心(0,-12,顶部)空", not at(tris_n, 0, -12, TOTAL - 0.05))
ck.check("缺口中心(0,-12,钢网层)实体(底层不挖穿)", at(tris_n, 0, -12, ST_T / 2))
ck.check("槽缘切口(0,-10.3,顶部)空", not at(tris_n, 0, -10.3, TOTAL - 0.05))
ck.check("槽缘切口(0,-10.3,钢网层)实体", at(tris_n, 0, -10.3, ST_T / 2))
# 长边贴槽缘(y=-11 处半宽≈7.09):x=6.5 空、x=7.8 实体
ck.check("长边内(6.5,-11)空(长边在里)", not at(tris_n, 6.5, -11, TOTAL - 0.05))
ck.check("长边外(7.8,-11)实体", at(tris_n, 7.8, -11, TOTAL - 0.05))
# 短边在外端(y=-13.5 处半宽≈6.21):x=5 空、x=7 实体
ck.check("短边内(5,-13.5)空", not at(tris_n, 5, -13.5, TOTAL - 0.05))
ck.check("短边外(7,-13.5)实体(短边朝外)", at(tris_n, 7, -13.5, TOTAL - 0.05))
# 不贯穿外框:凹口外端(-14.1)到外缘(-18.2)之间边框保持实体
ck.check("凹口外侧边框(0,-16,顶部)实体(未贯穿)", at(tris_n, 0, -16, TOTAL - 0.05))
ck.check("凹口外侧边框(0,-16,钢网层)实体", at(tris_n, 0, -16, ST_T / 2))
# PCB 支撑面未咬入(槽内钢网层完整)
ck.check("槽内钢网层(0,-10.05)实体", at(tris_n, 0, -10.05, ST_T / 2))
# 非缺口侧边框仍实体
ck.check("上边边框(x=0,y=12,顶部)实体", at(tris_n, 0, 12, TOTAL - 0.05))

print("=== 缺口大小滑杆(pry_notch_scale=1.5) ===")
tris_sc = load_tris(gen_part(stencil_params(pry_notch_scale=1.5),
                             "stencil_bottom", name="st_notch_big"))
# 100%:y=-12 处半宽≈6.7,x=7 实体;150%:外口半宽 7.55,y=-12 处半宽≈8.3,x=7 变空
ck.check("100% 时 (7,-12) 实体", at(tris_n, 7, -12, TOTAL - 0.05))
ck.check("150% 时 (7,-12) 空(随比例放大)", not at(tris_sc, 7, -12, TOTAL - 0.05))

print("=== 边框默认宽 12(不传 stencil_frame_width) ===")
p_def = stencil_params()
del p_def["stencil_frame_width"]
tris_def = load_tris(gen_part(p_def, "stencil", name="st_frame_def"))
# 槽缘 y=-10.2,默认 12 → 外缘 y=-22.2;(11,-21) 在环带内且缺口外(half≈9.5)
ck.check("默认边框 (11,-21) 实体(外缘 -22.2)", at(tris_def, 11, -21, TOTAL - 0.05))
ck.check("默认边框外 (11,-23) 空", not at(tris_def, 11, -23, TOTAL - 0.05))

print("=== 外框圆角(stencil_corner_radius,默认 3 / 可调 0=尖角) ===")
# 板 30x20,frame 8:外框 ±23.2/±18.2;圆角 3 → 角弧心 (20.2,15.2) r=3
# (21,17) 距弧心 2.92 < 3 → 实体(弧内);(22.5,17.5) 距弧心 3.25 > 3 → 圆角区空
ck.check("圆角内(21,17)实体", at(tris, 21, 17, TOTAL - 0.05))
ck.check("圆角区(22.5,17.5)空", not at(tris, 22.5, 17.5, TOTAL - 0.05))
# r=0 → 尖角:(22.5,17.5) 恢复实体
tris_sharp = load_tris(gen_part(stencil_params(stencil_corner_radius=0.0),
                                "stencil", name="st_corner0"))
ck.check("尖角 r=0 (22.5,17.5)实体", at(tris_sharp, 22.5, 17.5, TOTAL - 0.05))
# r=8 → 弧心 (15.2,10.2) r=8:(22,17) 距 9.62 > 8 空;(21,15) 距 7.52 < 8 实体
tris_r8 = load_tris(gen_part(stencil_params(stencil_corner_radius=8.0),
                             "stencil", name="st_corner8"))
ck.check("r=8 圆角区(22,17)空", not at(tris_r8, 22, 17, TOTAL - 0.05))
ck.check("r=8 弧内(21,15)实体", at(tris_r8, 21, 15, TOTAL - 0.05))

print("=== 外框形状(rect=矩形 / outline=跟随板形) ===")
# L 形板:下半全宽(y∈[-10,-5] x∈[-15,15]),上半仅左半(y∈[-5,10] x∈[-15,0])
# 用 stencil_bottom(无镜像,坐标直观);"stencil"=top 面会 Y 镜像
l_pts = [[-15, -10], [15, -10], [15, -5], [0, -5], [0, 10], [-15, 10], [-15, -10]]
p_l = stencil_params()
p_l["pcb_outline_points"] = l_pts
p_l["pry_notch_sides"] = []
tris_outl = load_tris(gen_part(dict(p_l), "stencil_bottom", name="st_sh_outl"))
tris_rect = load_tris(gen_part(dict(p_l, stencil_frame_shape="rect"),
                               "stencil_bottom", name="st_sh_rect"))
# outline:外框跟随 L 形,(10,7) 距板边(直线 x=0,y∈[-5,10])10mm > frame 8 → 空
ck.check("outline L形右上(10,7)空", not at(tris_outl, 10, 7, TOTAL - 0.05))
# rect:包围盒外扩 8.2 → x∈[-23.2,23.2] y∈[-18.2,18.2],(10,7) 实体
ck.check("rect 矩形右上(10,7)实体", at(tris_rect, 10, 7, TOTAL - 0.05))
# rect 下边框同样齐整:(22,-15) 实体(包围盒右侧带)
ck.check("rect 右侧边框(22,-15)实体", at(tris_rect, 22, -15, TOTAL - 0.05))
# rect 外仍空:(24,0) 超出 23.2
ck.check("rect 外(24,0)空", not at(tris_rect, 24, 0, TOTAL - 0.05))
# 默认(不传)= outline
tris_def_shape = load_tris(gen_part(dict(p_l), "stencil_bottom", name="st_sh_def"))
ck.check("默认形状=outline(10,7)空", not at(tris_def_shape, 10, 7, TOTAL - 0.05))

print("=== pad_shrink 缩小验证 ===")
tris_shrink = load_tris(gen_part(
    stencil_params(pad_shrink=50.0), "stencil", name="st_shrink"))
# 缩小 50% 后,原焊盘中心仍空,但原焊盘边缘应变为实体
# 长条焊盘 x 方向半宽 5,缩小 50% 后半宽 2.5 → x=4 处应实体
ck.check("缩小50%后 x=4(原焊盘内)变实体", at(tris_shrink, 4, 0, ST_T / 2))
ck.check("缩小50%后 x=1(缩小后焊盘内)仍空", not at(tris_shrink, 1, 0, ST_T / 2))

print("=== 双面钢网:顶层 Y 镜像(板框 + 焊盘),底层原坐标 ===")
# 非对称 L 形板框:下半全宽,上半只有右半(x∈[5,15])
# 顶层:PCB 翻面(绕 X 轴)入槽 → 板框/焊盘 Y 镜像(上半全宽)
# 底层:PCB 正放(底面朝下)入槽 → 原坐标
L_OUTLINE = [
    [-15, -10], [15, -10], [15, 10], [5, 10], [5, 0], [-15, 0], [-15, -10]
]
PAD_AT_10_5 = [[9, 4], [11, 4], [11, 6], [9, 6], [9, 4]]  # 2x2,中心 (10,5)
ds_params = {
    "pcb_size_x": 30, "pcb_size_y": 20, "pcb_thickness": 1.6,
    "pcb_outline_points": L_OUTLINE, "pcb_outline_holes": [],
    "stencil_thickness": 0.3, "stencil_frame_width": 8.0,
    "pocket_clearance": 0.2, "pad_shrink": 0.0,
    "pry_notch_sides": [],
    "stencil_pads_top": [PAD_AT_10_5],
    "stencil_pads_bottom": [PAD_AT_10_5],  # 同一原始坐标,面决定镜像
}
tris_top = load_tris(gen_part(ds_params, "stencil_top", name="st_ds_top"))
tris_bot = load_tris(gen_part(ds_params, "stencil_bottom", name="st_ds_bot"))
# 卡槽形状:探测卡槽层(钢网层上方,钢网层本身由开孔探测)
SLOT_Z = TOTAL - 0.05
# (-10,5) 上半左区 —— top 翻面入槽镜像卡槽(上半全宽)空;bottom 板外边框实体
ck.check("top 钢网 (-10,5) 镜像卡槽空", not at(tris_top, -10, 5, SLOT_Z))
ck.check("bottom 钢网 (-10,5) 板外实体", at(tris_bot, -10, 5, SLOT_Z))
# (-10,-5) 下半左区 —— top 镜像后是板外边框实体;bottom 卡槽空
ck.check("top 钢网 (-10,-5) 镜像板外实体", at(tris_top, -10, -5, SLOT_Z))
ck.check("bottom 钢网 (-10,-5) 卡槽空", not at(tris_bot, -10, -5, SLOT_Z))
# 焊盘开孔(钢网层 z=0.15):top 镜像到 (10,-5);bottom 原位 (10,5)
ck.check("top 钢网焊盘开孔镜像(10,-5)空", not at(tris_top, 10, -5, ST_T / 2))
ck.check("top 钢网 (10,5) 无开孔实体", at(tris_top, 10, 5, ST_T / 2))
ck.check("bottom 钢网焊盘开孔原位(10,5)空", not at(tris_bot, 10, 5, ST_T / 2))
ck.check("bottom 钢网 (10,-5) 无开孔实体", at(tris_bot, 10, -5, ST_T / 2))

print("=== 兼容:旧字段 stencil_pads 在 stencil_top 兜底生效 ===")
tris_legacy = load_tris(gen_part(
    stencil_params(), "stencil_top", name="st_legacy"))
ck.check("旧字段焊盘开孔(长条中心)空", not at(tris_legacy, 0, 0, ST_T / 2))
ck.check("旧字段焊盘开孔(小焊盘中心)空", not at(tris_legacy, 11, 0, ST_T / 2))

print("=== 新格式:多部件焊盘(极性/内孔,光绘机语义) ===")
# thermal 风格:暗环(4x4 外框 + r1.5 内孔) + 两条擦除开口(十字)
OCT = []
for _i in range(9):
    _a = _i / 8 * 2 * 3.141592653589793
    OCT.append([round(1.5 * math.cos(_a), 4), round(1.5 * math.sin(_a), 4)])
thermal_parts = [
    {"polarity": "D",
     "points": [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
     "holes": [OCT]},
    {"polarity": "C", "points": [[-3, -0.3], [3, -0.3], [3, 0.3], [-3, 0.3], [-3, -0.3]]},
    {"polarity": "C", "points": [[-0.3, -3], [0.3, -3], [0.3, 3], [-0.3, 3], [-0.3, -3]]},
]
new_params = {
    "pcb_size_x": 30, "pcb_size_y": 20, "pcb_thickness": 1.6,
    "pcb_outline_points": [
        [-15, -10], [15, -10], [15, 10], [-15, 10], [-15, -10]
    ],
    "pcb_outline_holes": [],
    "stencil_thickness": 0.3, "stencil_frame_width": 8.0,
    "pocket_clearance": 0.2, "pad_shrink": 0.0,
    "pry_notch_sides": [],
    "stencil_pads_top": [thermal_parts],
}
tris_new = load_tris(gen_part(new_params, "stencil_top", name="st_newfmt"))
# 环角 (±1.8,±1.8):在环上且避开十字开口 → 开孔
ck.check("新格式热焊盘环角(1.8,1.8)开孔", not at(tris_new, 1.8, 1.8, ST_T / 2))
ck.check("新格式热焊盘环角(-1.8,-1.8)开孔", not at(tris_new, -1.8, -1.8, ST_T / 2))
# 内孔与十字开口之间的小岛(如 (0.6,0.5):八孔内且避开十字边界):恢复材料
# (探测点避开原点/十字线,防止踩在三角剖分对角线上导致射线法退化)
ck.check("新格式热焊盘内孔岛(0.6,0.5)材料", at(tris_new, 0.6, 0.5, ST_T / 2))
ck.check("新格式热焊盘内孔岛(-0.6,-0.5)材料", at(tris_new, -0.6, -0.5, ST_T / 2))
# 十字开口 (0,±1.8):在环上但被 C 极性擦除 → 材料
ck.check("新格式热焊盘开口(0,1.8)材料", at(tris_new, 0, 1.8, ST_T / 2))
ck.check("新格式热焊盘开口(1.8,0)材料", at(tris_new, 1.8, 0, ST_T / 2))
# 焊盘外 (3,3) 无开孔
ck.check("新格式焊盘外(3,3)材料", at(tris_new, 3, 3, ST_T / 2))

print("=== 新格式:top 面 Y 镜像(多部件含内孔) ===")
mirror_parts = [
    {"polarity": "D",
     "points": [[8, 3], [12, 3], [12, 7], [8, 7], [8, 3]],
     "holes": [[[9.5, 5], [10.5, 5], [10.5, 6], [9.5, 6], [9.5, 5]]]},
]
top_params = dict(new_params)
top_params["stencil_pads_top"] = [mirror_parts]
top_params["stencil_pads_bottom"] = []
tris_mb = load_tris(gen_part(top_params, "stencil_top", name="st_mirtop"))
# 焊盘中心 (10,5) → top 翻面入槽 Y 镜像后开孔在 (10,-5)。
# 探测点避开孔环边界(y=-5/-6)与网格对角线(x=10),否则射线法退化
ck.check("top 镜像开孔(9,-5.5)空", not at(tris_mb, 9, -5.5, ST_T / 2))
ck.check("top 镜像开孔(11,-5.5)空", not at(tris_mb, 11, -5.5, ST_T / 2))
ck.check("top 无开孔(10,5)实体", at(tris_mb, 10, 5, ST_T / 2))
# 部件内孔 x∈[9.5,10.5],y∈[5,6] → 镜像后 (9.75,-5.5)/(10.25,-5.5) 恢复材料
ck.check("top 镜像内孔(9.75,-5.5)材料", at(tris_mb, 9.75, -5.5, ST_T / 2))
ck.check("top 镜像内孔(10.25,-5.5)材料", at(tris_mb, 10.25, -5.5, ST_T / 2))

print("=== 喇叭孔本版禁用:taper=105 按直孔处理(参数保留仅协议兼容) ===")
# 千级焊盘时锥孔布尔病态慢(>20min),本版强制直孔;taper 参数仍解析
# 但不再生效。验证:taper=105 与 taper=100 几何一致(开孔原尺寸)。
taper_params = stencil_params(
    stencil_pads=[[[-5, -2], [5, -2], [5, 2], [-5, 2], [-5, -2]]],
    stencil_taper=105.0, stencil_stagger=False, stencil_grid=False)
tris_tp = load_tris(gen_part(taper_params, "stencil", name="st_taper"))
ck.check("直孔中心贯穿空", not at(tris_tp, 0, 0, ST_T / 2))
# 开孔原尺寸(y 半宽 2):y=2.05 全高实体(无喇叭口扩大)
ck.check("taper=105 底部仍原尺寸(无扩大) y=2.05 实体", at(tris_tp, 0, 2.05, 0.02))
ck.check("taper=105 上部 y=2.05 实体", at(tris_tp, 0, 2.05, 0.20))
# y=1.9 开孔内全空
ck.check("开孔内 y=1.9 全空", not at(tris_tp, 0, 1.9, 0.02)
         and not at(tris_tp, 0, 1.9, 0.20))

print("=== 密脚错排:0.5mm 间距链隔位 ±法向偏移 ===")
# 5 个 0.3x0.3 焊盘,pitch 0.5(< 0.55 阈值)→ 密脚链;错排 ±0.15
fine_pads = []
for k in range(5):
    cx = k * 0.5
    fine_pads.append([[cx - 0.15, -0.15], [cx + 0.15, -0.15],
                      [cx + 0.15, 0.15], [cx - 0.15, 0.15],
                      [cx - 0.15, -0.15]])
fine_pads.append([[9.85, 4.85], [10.15, 4.85], [10.15, 5.15],
                  [9.85, 5.15], [9.85, 4.85]])  # 孤立焊盘(不参与错排)
stg_params = stencil_params(
    stencil_pads=fine_pads, stencil_stagger=True,
    stencil_stagger_gap=0.55, stencil_stagger_offset=0.15,
    stencil_taper=100.0, stencil_grid=False)
tris_sg = load_tris(gen_part(stg_params, "stencil", name="st_stagger"))
ups = []
for k in range(5):
    cx = k * 0.5
    up = not at(tris_sg, cx + 0.01, 0.22, ST_T / 2)
    down = not at(tris_sg, cx + 0.01, -0.22, ST_T / 2)
    ck.check(f"密脚焊盘{k}恰好偏移一侧", up != down)
    ups.append(up)
ck.check("相邻焊盘错开(隔位交替)", all(ups[k] != ups[k + 1] for k in range(4)))
# 孤立焊盘不动:原位开孔(stencil=top 面已 Y 镜像 → 开孔在 (10,-5)),
# 上下 0.22 处均实体
ck.check("孤立焊盘原位开孔", not at(tris_sg, 10, -5, ST_T / 2))
ck.check("孤立焊盘上方未偏移", at(tris_sg, 10.01, -5.22, ST_T / 2))
ck.check("孤立焊盘下方未偏移", at(tris_sg, 10.01, -4.78, ST_T / 2))
# 对照:关闭错排后原位(y=±0.22 处无开孔)
tris_nsg = load_tris(gen_part(stencil_params(
    stencil_pads=fine_pads, stencil_stagger=False,
    stencil_taper=100.0, stencil_grid=False), "stencil", name="st_nostagger"))
ck.check("关闭错排后焊盘0原位(上方无开孔)",
         at(tris_nsg, 0.01, 0.22, ST_T / 2))

print("=== 大孔开网格:单边>2mm 加十字网格条 ===")
# 6x6 方焊盘(十字条 0.5)+ 6x1.5 长条(只加竖条)+ 1.5x1.5 小焊盘(不加)
grid_pads = [
    [[-9, -3], [-3, -3], [-3, 3], [-9, 3], [-9, -3]],      # 6x6 @ (-6,0)
    [[3, -0.75], [9, -0.75], [9, 0.75], [3, 0.75], [3, -0.75]],  # 6x1.5 @ (6,0)
    [[-0.75, 5.25], [0.75, 5.25], [0.75, 6.75], [-0.75, 6.75], [-0.75, 5.25]],
]
grid_params = stencil_params(
    stencil_pads=grid_pads, stencil_grid=True,
    stencil_grid_size=2.0, stencil_grid_bar=0.5,
    stencil_taper=100.0, stencil_stagger=False)
tris_gd = load_tris(gen_part(grid_params, "stencil", name="st_grid"))
# 6x6:竖条 x∈[-6.25,-5.75] 全高,横条 y∈[-0.25,0.25] 全宽
# (竖条探针取 y=0.4 避开横条带,且避开三角剖分对角线 —— (x,y) 恰在
#  (-6.25,±0.25)-(-5.75,∓0.25) 对角线上时射线法退化)
ck.check("方焊盘竖条(-6.1,0.4)材料", at(tris_gd, -6.1, 0.4, ST_T / 2))
ck.check("方焊盘横条(-7.5,0.1)材料", at(tris_gd, -7.5, 0.1, ST_T / 2))
ck.check("方焊盘子格(-4.5,1.5)开孔", not at(tris_gd, -4.5, 1.5, ST_T / 2))
ck.check("方焊盘子格(-7.5,-1.5)开孔", not at(tris_gd, -7.5, -1.5, ST_T / 2))
# 6x1.5:竖条有、横条无(h=1.5 不满足子格最小宽度)
ck.check("长条竖条(6.1,0.1)材料", at(tris_gd, 6.1, 0.1, ST_T / 2))
ck.check("长条无横条(4.5,0.1)开孔", not at(tris_gd, 4.5, 0.1, ST_T / 2))
ck.check("长条子格(4.5,0.5)开孔", not at(tris_gd, 4.5, 0.5, ST_T / 2))
# 1.5x1.5 小焊盘:不加网格(stencil=top 面 Y 镜像 → 开孔在 (0,-6))
ck.check("小焊盘中心(0,-6)开孔(无网格)", not at(tris_gd, 0, -6, ST_T / 2))
ck.check("小焊盘偏心(0.15,-6.05)开孔(无网格条)",
         not at(tris_gd, 0.15, -6.05, ST_T / 2))

ck.finish("PCB 钢网几何验证")
