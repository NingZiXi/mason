#!/usr/bin/env python3
"""
PCB 钢网夹具生成器 v2 - 基于 build123d + Shapely(参考商用件逆向结构)

结构(商用钢网夹解码结果):
  - insert: 底板(R5 圆角)+ 中央凸台(PCB 槽在凸台顶面,深=板厚,PCB 与凸台顶齐平)
            + 双梯形取放缺口(槽边两个对称 U 型缺口,手指抠板)
            + 底部圆形顶出孔(推出 PCB)
            + 4 角空心定位柱(一体免螺丝,外Ø9/内Ø5,向上伸出穿过
              cover 角孔与盖板顶面齐平)+ 板内孔挖穿(顶出/透锡)
  - cover:  窗口 = 凸台+0.4(与 base 同一多边形,叠合孔口重合),45° 全高倒角
            (顶开口四角圆角半径与窗口一致,直边壁开口向上张开)
            + 4 角定位柱过孔(Ø9.4)+ 周圈螺丝过孔(B 面配置)
  - base:   窗口 = 凸台+0.4,顶缘反向拔模(底面开口更大)+ 周圈自攻底孔
            + 4 角定位柱孔(Ø9.4,与 cover 一一对应)

装配(A 面印刷):base(下)+ insert + 钢网 + cover;insert 4 角定位柱穿过
cover 角孔(与顶面齐平)把三层定位固定,钢网压在盖板与凸台顶面之间,
PCB 与凸台齐平 → 钢网与 PCB 零间隙贴合,印刷质量最佳。
B 面配置:insert 翻面(凸台朝下套进 base 窗口)整体翻转后,凸台高 ≡ base
板厚 → base 顶面与 PCB B 面齐平,钢网零间隙平贴;cover 盖上、周圈螺丝
对穿 cover 与 base 直接夹紧钢网边缘。
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import build123d as bd
from build123d import (
    Cylinder, Axis, Mode,
    BuildPart, BuildSketch, BuildLine,
    Plane, Polyline, RectangleRounded, make_face, add, chamfer,
    extrude, export_stl, export_step, loft,
)
# OCC 原生 API:焊盘开孔性能关键路径(build123d 构建器随面数二次方变慢,
# 千级焊盘时不可用;OCP 直连构建 <1s,配合 Glue 并行布尔再快 ~4 倍)
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BOPAlgo import BOPAlgo_GlueEnum
from OCP.TopTools import TopTools_ListOfShape
from OCP.TopAbs import TopAbs_ShapeEnum
from OCP.BRep import BRep_Builder
from OCP.gp import gp_Pnt, gp_Vec, gp_Trsf, gp_Ax1, gp_Dir
from OCP.TopoDS import TopoDS_Compound, TopoDS
from OCP.TopLoc import TopLoc_Location
from OCP.TopExp import TopExp_Explorer
# STL 导出用 OCC 原生网格化:build123d export_stl 默认 1e-3 相对偏差,
# 千孔钢网网格化 66s;绝对偏差 0.01 只要 6.7s 且三角数几乎不变
# (绝大多数面是平面多边形,对偏差不敏感)
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.StlAPI import StlAPI_Writer
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.geometry import box as shapely_box
from shapely.geometry.polygon import orient as shapely_orient
from shapely.ops import unary_union as shapely_union
from shapely.affinity import scale as shapely_scale_aff
from shapely.affinity import translate as shapely_translate

# ---------------------------------------------------------------------------
# 公共几何工具
# ---------------------------------------------------------------------------

def poly_solid(coords, height):
    """2D 点列 → extruded solid(z: 0..height)。失败返回 None。"""
    pts = list(coords)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    # 去除连续重复点(浮点容差),避免退化边
    cleaned = [pts[0]]
    for x, y in pts[1:]:
        px, py = cleaned[-1]
        if abs(x - px) > 1e-6 or abs(y - py) > 1e-6:
            cleaned.append((x, y))
    pts = cleaned
    if len(pts) < 3:
        return None
    try:
        with BuildPart() as p:
            with BuildSketch(Plane.XY) as s:
                with BuildLine() as l:
                    Polyline(*[bd.Vector(x, y, 0) for x, y in pts], close=True)
                make_face()
            extrude(amount=height)
        return p.part
    except Exception:
        return None


def rounded_square_solid(size, height, radius):
    """圆角正方形底板(z: 0..height)"""
    r = min(radius, size / 2 - 0.5, height)
    with BuildPart() as p:
        with BuildSketch(Plane.XY) as s:
            RectangleRounded(size, size, r)
        extrude(amount=height)
    return p.part


def loft_cone(coords_bot, coords_top, z_bot, z_top):
    """两截面间的直纹放样锥台(截面按同构模板生成,顶点一一对应防扭曲)"""
    with BuildPart() as p:
        with BuildSketch(Plane.XY.offset(z_bot)) as s:
            with BuildLine() as l:
                Polyline(*[bd.Vector(x, y, 0) for x, y in coords_bot], close=True)
            make_face()
        with BuildSketch(Plane.XY.offset(z_top)) as s:
            with BuildLine() as l:
                Polyline(*[bd.Vector(x, y, 0) for x, y in coords_top], close=True)
            make_face()
        loft(ruled=True)
    return p.part


RES = 6  # buffer 圆弧每象限段数(模块级:rounded_rect_poly 与 get_polys 共用)


def plater_radius(p, slot_poly):
    """凸台 margin(含钢网扩张)与圆角半径 —— get_polys / build_cover 共用,
    钢网扩张逻辑的单一来源(改这里即可两处同步)。
    凸台恒为正方形:边长 = 槽包围盒长边 + 2*margin —— 钢网是正方形,
    方形凸台保证钢网四边支撑唇均匀一致(窄长板短边不再多出一圈台阶)"""
    margin = p.get("platter_margin", 5.0)
    minx, miny, maxx, maxy = slot_poly.bounds
    stencil = p.get("stencil_size", 0.0)
    if stencil > 0:
        slot_half = max(maxx - minx, maxy - miny) / 2
        margin = max(margin, stencil / 2 - slot_half + 2.0)
    half = max(maxx - minx, maxy - miny) / 2 + margin
    r = min(p.get("platter_corner_radius", 4.5), half - 0.5)
    return margin, r


def rounded_rect_poly(minx, miny, maxx, maxy, r):
    """圆角矩形(RES 离散 + simplify,与 get_polys 同源;r≤0.05 退化为直角)"""
    if r > 0.05:
        return shapely_box(minx + r, miny + r, maxx - r, maxy - r).buffer(
            r, join_style=1, resolution=RES
        ).simplify(0.02)
    return shapely_box(minx, miny, maxx, maxy)


def get_polys(p):
    """计算 PCB 槽 / 凸台 / 窗口 的 Shapely 多边形(居中坐标系)

    返回 (slot_poly, platter_poly, window_poly, is_shaped)
    性能:buffer 的圆角离散 + simplify(0.02) 压共线点 —— 否则 100+ 顶点的
    轮廓会让 OCC 的 extrude/chamfer 慢一个数量级(7s → 亚秒)。
    """
    clearance = p["pcb_pocket_clearance"]
    outline_pts = p.get("pcb_outline_points", [])
    is_shaped = len(outline_pts) >= 3

    if is_shaped:
        base_poly = ShapelyPolygon(outline_pts)
        if not base_poly.is_valid:
            base_poly = base_poly.buffer(0)
    else:
        w, h = p["pcb_size_x"] / 2, p["pcb_size_y"] / 2
        base_poly = shapely_box(-w, -h, w, h)

    # PCB 槽 = 板框 + clearance(槽跟随板框形状)
    slot_poly = base_poly.buffer(clearance, join_style=1, resolution=RES).simplify(0.02)
    if slot_poly.is_empty:
        raise ValueError("PCB 槽多边形为空")

    # 凸台 = 恒为正方形(边长 = 槽包围盒长边 + 2*margin,中心与槽中心一致)
    # —— 不跟随板框形状:异形板(圆/异形轮廓)的托盘面仍是规整方形,
    # 且钢网是正方形,方形凸台四边支撑唇均匀一致。
    # 钢网平放在凸台顶面:凸台必须装得下钢网(外留 2mm 支撑唇),
    # 钢网大于槽跨度时 margin 自动扩张 —— 与 TS windowHalf() 同步改
    margin, r = plater_radius(p, slot_poly)
    minx, miny, maxx, maxy = slot_poly.bounds
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    half = max(maxx - minx, maxy - miny) / 2 + margin
    platter_poly = rounded_rect_poly(cx - half, cy - half, cx + half, cy + half, r)

    # 窗口 = 凸台 + 0.4 单边间隙(圆角矩形):
    # cover(A面)与 base(B面)共用同一多边形 —— 两块板的开口
    # 大小、形状、四角圆角完全一致,叠合装配时孔口重合
    window_poly = platter_poly.buffer(0.4, join_style=1, resolution=RES).simplify(0.02)

    return slot_poly, platter_poly, window_poly, is_shaped


def corner_screw_positions(window_poly, jig):
    """4 角压钢网螺丝位置:紧贴夹具 4 角(沿对角线),boss(半径 corner_d/2+2)圆心
    到两边各留 7mm,外缘 R5 圆角自然包容。
    窗口过大时沿对角线内收到窗口外 3.5mm,保证 boss 不悬空。
    """
    win_half = max(window_poly.bounds[2], window_poly.bounds[3])
    # 角部位置:圆心到两直边各 7mm → 对角坐标 = jig/2 - 7
    s = jig / 2 - 7.0
    # 内收保护:boss(半径 6.5)必须落在窗口外(沿轴向 ≥ win_half+3.5)
    if s < win_half + 3.5:
        s = win_half + 3.5
    return [(s, s), (s, -s), (-s, s), (-s, -s)]


def compute_perimeter_screw_positions(jig, window_poly, spacing):
    """周圈螺丝(B 面配置):孔带靠外 —— 螺丝圆心距外缘固定 10mm,
    窗口→螺丝之间的整条内侧带留给钢网夹紧(压紧区不打孔);
    行/列末端内收到 jig/2-14,与 4 角定位柱孔(jig/2-7, Ø9.4)保持净距;
    窗口过大(手动改小夹具)时贴窗口壁外移,保证孔壁与窗口壁 ≥4mm —— 与 TS screwPositions 同步改"""
    if spacing <= 0:
        return []
    minx, miny, maxx, maxy = window_poly.bounds
    band_x = max(jig / 2 - 10.0, maxx + 4.0)  # 左右列的 x(靠外)
    band_y = max(jig / 2 - 10.0, maxy + 4.0)  # 上下行的 y(靠外)
    limit = jig / 2 - 14  # 避开 4 角柱孔与外圆角
    if limit < spacing:
        # 只放中点一颗(小夹具),间距放不下第二颗
        if limit <= 0:
            return []
        return [(0.0, band_y), (0.0, -band_y), (band_x, 0.0), (-band_x, 0.0)]
    n = int(limit // spacing)
    positions = []
    seen = set()
    for i in range(-n, n + 1):
        c = i * spacing
        if abs(c) > limit:
            continue
        for x, y in [(c, band_y), (c, -band_y), (band_x, c), (-band_x, c)]:
            key = (round(x, 3), round(y, 3))
            if key not in seen:
                seen.add(key)
                positions.append((x, y))
    return positions


def chamfer_edges_at(part, z_level, length, max_radius):
    """对 z≈z_level 且 bbox 完全在 max_radius 内的边缘倒角(窗口缘,避开外缘)。

    用 bbox 而非中心半径过滤:窗口角弧边的中心距原点(~72)与外缘直边(~70)
    重叠,但窗口边整体落在窗口半宽内,外缘边总有一维抵到 jig 边界,可干净分离。
    """
    with BuildPart() as bp:
        add(part)
        edges = []
        for e in bp.edges():
            if abs(e.center().Z - z_level) > 0.1:
                continue
            bb = e.bounding_box()
            if max(abs(bb.min.X), abs(bb.max.X), abs(bb.min.Y), abs(bb.max.Y)) < max_radius:
                edges.append(e)
        if not edges:
            return part
        try:
            chamfer(edges, length=length)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] chamfer({length}) 失败,保持直边: {type(e).__name__}: {e}", file=sys.stderr)
            return part
    return bp.part


def chamfer_platter_top(part, total_h, length=0.75):
    """凸台顶外缘倒角(z=total_h,排除底板外缘:按半径区分不总是可靠,
    用边长 + 位置启发:凸台缘在 z=total_h 且不在 jig 外缘)"""
    with BuildPart() as bp:
        add(part)
        cands = []
        for e in bp.edges():
            c = e.center()
            if abs(c.Z - total_h) > 0.1:
                continue
            # 底板外缘(z=total_h 平面上不存在,底板在下方)——凸台顶面只有窗口外缘
            cands.append(e)
        if not cands:
            return part
        try:
            chamfer(cands, length=length)
        except Exception:
            pass
    return bp.part


# ---------------------------------------------------------------------------
# 部件构建
# ---------------------------------------------------------------------------

def build_insert(p):
    """PCB 托盘:底板 + 凸台(PCB 齐平槽)+ 梯形取放缺口 + 底部圆形顶出孔 + 4 角 boss + 内孔挖穿"""
    jig = p["jig_size"]
    total_h = p["insert_height"]
    # 凸台高度 ≡ 底座板厚(不接受独立的 platter_height):
    # B 面翻转装配时凸台套进底座窗口,两者相等 → 底座顶面与 PCB B 面
    # 齐平,钢网才能零间隙平贴在板子和底座顶面上
    platter_h = min(p.get("base_height", 4.0), total_h - 1.0)
    plate_h = total_h - platter_h
    pcb_t = p["pcb_thickness"]
    clearance = p["pcb_pocket_clearance"]
    r_out = p.get("outer_corner_radius", 5.0)
    eject_w = p.get("eject_slot_width", 22.0)
    corner_d = p.get("corner_screw_d", 5.0)

    slot_poly, platter_poly, window_poly, is_shaped = get_polys(p)

    # 1. 底板(z: 0..plate_h)
    plate = rounded_square_solid(jig, plate_h, r_out)

    # 2. 凸台(z: plate_h..total_h):先在原位倒顶角再落位
    #    (落位后过滤 z=platter_h 会命中底缘,倒错方向)
    platter = poly_solid(platter_poly.exterior.coords, platter_h)
    platter = chamfer_platter_top(platter, platter_h, 0.75)
    platter = platter.moved(bd.Location((0, 0, plate_h)))
    part = plate + platter

    # 3. PCB 槽:凸台顶面往下 pcb_t(PCB 与凸台顶齐平)
    slot = poly_solid(slot_poly.exterior.coords, pcb_t + 0.05)
    slot = slot.moved(bd.Location((0, 0, total_h - pcb_t)))
    part = part - slot

    # 4. 板内孔挖穿(从凸台顶到托盘底)
    for hole in p.get("pcb_outline_holes", []):
        if len(hole) < 3:
            continue
        hp = ShapelyPolygon(hole)
        if not hp.is_valid:
            hp = hp.buffer(0)
        if hp.is_empty or hp.area < 0.01:
            continue
        if clearance > 0:
            hp = hp.buffer(clearance)
        solid = poly_solid(hp.exterior.coords, total_h + 0.2)
        if solid is not None:
            part = part - solid.moved(bd.Location((0, 0, -0.1)))

    # 5. 底部圆形顶出孔:托盘底面 → PCB 槽底的竖直圆孔(从下方把 PCB 顶出)。
    #    直径随板子尺寸自适应(各种边界条件):
    #      d = 槽最小边 × 0.35,封顶 30mm(大板无需更大)
    #      d < 12mm(指尖下限)时:槽最小边 ≥ 26mm 仍开 12mm 最小圆,否则取消
    #      (板实在太小 → 槽底承托不足,不开孔,取板走取放缺口)
    #    footprint 与槽形状求交:圆越界部分自动裁掉,凸台/端墙完全不动
    minx, miny, maxx, maxy = slot_poly.bounds
    if eject_w > 0:
        slot_min = min(maxx - minx, maxy - miny)
        d = slot_min * 0.35
        if d < 12.0:
            d = 12.0 if slot_min >= 26.0 else 0.0
        d = min(d, 30.0)
        if d >= 8.0:
            # 圆心:优先质心(凹形板质心可能在槽外 → 退回 representative_point)
            ctr = slot_poly.centroid
            if not slot_poly.contains(ctr):
                ctr = slot_poly.representative_point()
            circ = ctr.buffer(d / 2, resolution=16).intersection(slot_poly)
            ch_polys = (
                list(circ.geoms) if circ.geom_type == "MultiPolygon"
                else ([] if circ.is_empty else [circ])
            )
            for fp in ch_polys:
                solid = poly_solid(fp.exterior.coords, total_h - pcb_t + 0.1)
                if solid is not None:
                    part = part - solid

    # 5.5 双梯形取放缺口:槽边缘两个对称 U 型缺口(梯形,短边朝向板子),
    #      手指从顶面伸入缺口即可托住 PCB 底部,把板从卡槽中抠出
    #      - 位置 pry_notch_sides:up/down/left/right 任意组合(空列表 = 关闭)
    #      - 尺寸 pry_notch_scale(0.5~1.5,默认 1.0)× 自动基准(边长 15%,夹 12~24mm),
    #        比例化钳位(6%~50% 边长)保证任何板子全滑程有效
    #      - 外口张开成漏斗导入手指;约束:外端距槽角 ≥2mm,放不下等比缩,短边 <6mm 取消
    #      - 缺口底低于 PCB 底面 0.8mm(指尖可探入板下),底部留 ≥0.8mm 不切穿
    #      - 每条缺口按槽局部边缘定位(条带∩槽),异形板同样有效
    sides = [
        s for s in (str(x).strip().lower() for x in p.get("pry_notch_sides", ["down"]))
        if s in ("down", "up", "left", "right")
    ]
    if sides:
        floor_n = max(total_h - pcb_t - 0.8, plate_h + 0.8)
        if floor_n < total_h - 0.5:
            margin = p.get("platter_margin", 5.0)
            overlap = min(2.5, margin)   # 探入槽内板下的深度
            scale = max(0.5, min(1.5, float(p.get("pry_notch_scale", 1.0))))

            def _edge_probe(s, u0, w):
                """该侧条带(u0±w/2)∩槽 的本地槽缘坐标;不相交返回 None"""
                if s in ("down", "up"):
                    bb = shapely_box(u0 - w / 2 - 0.5, miny, u0 + w / 2 + 0.5, maxy)
                else:
                    bb = shapely_box(minx, u0 - w / 2 - 0.5, maxx, u0 + w / 2 + 0.5)
                fp = bb.intersection(slot_poly)
                if fp.is_empty:
                    return None
                b = fp.bounds
                return {"down": b[1], "up": b[3], "right": b[2], "left": b[0]}[s]

            def _side_span(s):
                """(边中点 u, 边长 L)"""
                if s in ("down", "up"):
                    return (minx + maxx) / 2, maxx - minx
                return (miny + maxy) / 2, maxy - miny

            for side in sides:
                cu_n, L_n = _side_span(side)
                if L_n >= 20:
                    # 单缺口中心 = 边中点
                    edge = _edge_probe(side, cu_n, 12.0)
                    if edge is not None:
                        # 内缘(探入槽内)/外缘:深度只需满足手指抠取(伸出槽缘
                        # 约 10mm 即可),不必贯穿整个台阶 —— 钢网扩张后台阶宽
                        # 可达 50mm+,贯穿会把凸台切成大口子。
                        # 例外:台阶壁浅(10mm 够不着外缘)或切完只剩 <3mm 薄壁
                        # (尴尬残留)时,直接切穿实际外缘 0.5mm 保证切口干净
                        pb = platter_poly.bounds
                        reach = 10.0

                        def _clip(v_edge, v_cut, s):
                            """s=+1 外侧为增大方向(up/right),-1 为减小(down/left)"""
                            margin_eff = (v_cut - v_edge) * s  # 槽缘→凸台外缘距离
                            if margin_eff <= reach + 3.0:
                                return v_cut  # 壁浅或残留 <3mm → 切穿
                            return v_edge + s * reach  # 深台阶 → 10mm 浅缺口

                        if side == "down":
                            v_in = edge + overlap
                            v_out = _clip(edge, pb[1] - 0.5, -1)
                        elif side == "up":
                            v_in = edge - overlap
                            v_out = _clip(edge, pb[3] + 0.5, +1)
                        elif side == "right":
                            v_in = edge - overlap
                            v_out = _clip(edge, pb[2] + 0.5, +1)
                        else:
                            v_in = edge + overlap
                            v_out = _clip(edge, pb[0] - 0.5, -1)
                        run = abs(v_out - v_in)
                        # 自动基准 = 边长 15% 与槽-凸台深度(run×0.9)取大者
                        # (钢网扩张后凸台壁更深,窄缺口手指够不到板边),夹 12~24mm;
                        # 滑动条比例缩放,钳制边界随板边比例化(6%~50% 边长),
                        # 任何板子全滑程有效(绝对 mm 钳位会在小板上吃掉整段滑程)
                        auto_w = max(12.0, min(24.0, max(L_n * 0.15, run * 0.9)))
                        w_s = max(L_n * 0.06, min(min(30.0, L_n * 0.5), auto_w * scale))
                        w_l = w_s + 2.0 * min(4.0, run * 0.35)
                        # 约束收缩:缺口两端距槽角 ≥2mm
                        sc = min(1.0, (L_n / 2 - 2.0) / (w_l / 2))
                        if sc < 1.0:
                            w_s, w_l = w_s * sc, w_l * sc
                        if w_s >= 6.0:
                            if side in ("down", "up"):
                                pts = [(cu_n - w_l / 2, v_out), (cu_n + w_l / 2, v_out),
                                       (cu_n + w_s / 2, v_in), (cu_n - w_s / 2, v_in)]
                            else:
                                pts = [(v_out, cu_n - w_l / 2), (v_out, cu_n + w_l / 2),
                                       (v_in, cu_n + w_s / 2), (v_in, cu_n - w_s / 2)]
                            # 四角圆角过渡(先内缩再外扩,凸角变圆):
                            # r 随缺口尺寸自适应,上限 2mm(视觉柔和且不吞开口宽度)
                            r_f = min(2.0, w_s / 4, run / 4)
                            notch_poly = ShapelyPolygon(pts)
                            if r_f >= 0.5:
                                rounded = (
                                    notch_poly.buffer(-r_f, join_style=1)
                                    .buffer(r_f, join_style=1)
                                )
                                if not rounded.is_empty and rounded.geom_type == "Polygon":
                                    notch_poly = rounded
                            if not notch_poly.is_empty and notch_poly.geom_type == "Polygon":
                                solid = poly_solid(notch_poly.exterior.coords, total_h - floor_n)
                                if solid is not None:
                                    part = part - solid.moved(bd.Location((0, 0, floor_n)))

    # 6. 4 角定位柱(与托盘一体,空心管结构,免螺丝):
    #    外 Ø9 / 内 Ø5(壁厚 2mm),贯穿托盘全高并向上伸出 cover_h,
    #    穿过 cover 角孔后与 cover 顶面齐平 —— 装配靠柱/孔配合把三层
    #    定位固定;空心减材料,柱壁微量弹性也吸收装配应力;
    #    托盘底面平贴 base(柱不向下伸),除这 4 个柱外无任何螺丝孔,
    #    周圈螺丝(B 面配置)只在 cover/base 上,不贯穿托盘
    cover_h = p["top_cover_height"]
    post_h = total_h + cover_h
    r_post = corner_d / 2 + 2.0  # Ø9 柱
    r_bore = corner_d / 2        # Ø5 内孔,壁厚 2mm
    for (x, y) in corner_screw_positions(window_poly, jig):
        post = Cylinder(r_post, post_h)
        part = part + post.moved(bd.Location((x, y, post_h / 2)))
        bore = Cylinder(r_bore, post_h + 0.2)
        part = part - bore.moved(bd.Location((x, y, post_h / 2)))

    return part


def build_cover(p):
    """A 面顶盖:45° 全高倒角印刷窗口(压钢网边缘,钢网夹在盖板与凸台顶面之间)
    + 4 角沉头螺丝 + 周圈孔"""
    jig = p["jig_size"]
    cover_h = p["top_cover_height"]
    r_out = p.get("outer_corner_radius", 5.0)
    corner_d = p.get("corner_screw_d", 5.0)
    peri_d = p.get("peri_screw_d", 3.5)
    spacing = p["screw_spacing"]

    slot_poly, _platter, window_poly, _shaped = get_polys(p)

    # 1. 平板 + 45° 倒角印刷窗口(锥形切割体,替代"直挖+chamfer"):
    #    - 下开口 = window_poly(与 base 同口,叠合孔口重合)
    #    - 顶开口 = 窗口直边外扩 bevel(开口向上张开,刮刀不刮边),
    #      但四角圆角半径与窗口相同 —— 跟 B 面一样的圆弧,
    #      而不是 OCC 倒角那种外偏放大的 R+bevel
    #    - 直边壁 45°(bevel = cover_h-0.4 近全高),压紧面仍全程有效
    cover = rounded_square_solid(jig, cover_h, r_out)
    bevel = cover_h - 0.4
    _m, pl_r = plater_radius(p, slot_poly)
    win_r = (pl_r + 0.4) if pl_r > 0.05 else 0.4
    minx, miny, maxx, maxy = window_poly.bounds
    pad = 0.2  # 锥体两端各伸出 pad,避免与盖板上下表面共面布尔
    bot = rounded_rect_poly(minx - pad, miny - pad, maxx + pad, maxy + pad, win_r)
    top = rounded_rect_poly(
        minx - pad - bevel, miny - pad - bevel,
        maxx + pad + bevel, maxy + pad + bevel, win_r,
    )
    cone = loft_cone(bot.exterior.coords, top.exterior.coords, -pad, cover_h + pad)
    cover = cover - cone

    # 3. 4 角定位柱过孔(与 insert 定位柱同心):Ø9.4 全厚贯穿,
    #    柱穿过后与盖板顶面齐平(免螺丝,柱/孔配合固定三层)
    positions = corner_screw_positions(window_poly, jig)
    r_post_hole = corner_d / 2 + 2.2  # 柱 Ø9 + 0.2 径向间隙
    for (x, y) in positions:
        hole = Cylinder(r_post_hole, cover_h + 0.2)
        cover = cover - hole.moved(bd.Location((x, y, cover_h / 2)))

    # 4. 周圈螺丝过孔(B 面配置)
    for (x, y) in compute_perimeter_screw_positions(jig, window_poly, spacing):
        hole = Cylinder(peri_d / 2, cover_h + 0.2)
        cover = cover - hole.moved(bd.Location((x, y, cover_h / 2)))

    return cover


def build_base(p):
    """B 面底座:反向拔模窗口 + 周圈自攻底孔 + 4 角自攻底孔"""
    jig = p["jig_size"]
    base_h = p["base_height"]
    r_out = p.get("outer_corner_radius", 5.0)
    peri_d = p.get("peri_screw_d", 3.5)
    spacing = p["screw_spacing"]

    _slot, _platter, window_poly, _shaped = get_polys(p)

    # 1. 平板 + 窗口直孔
    base = rounded_square_solid(jig, base_h, r_out)
    win = poly_solid(window_poly.exterior.coords, base_h + 0.2)
    base = base - win.moved(bd.Location((0, 0, -0.1)))

    # 2. 窗口顶缘拔模倒角(底面开口更大 1mm/边,翻转 insert 时凸台易入)
    #    在钻孔之前,避免孔缘参与倒角
    win_half = max(window_poly.bounds[2], window_poly.bounds[3]) + 1.0
    base = chamfer_edges_at(base, base_h, 1.0, win_half)

    # 3. 周圈自攻底孔(与 cover/insert 过孔同心,孔径小 0.5)
    for (x, y) in compute_perimeter_screw_positions(jig, window_poly, spacing):
        hole = Cylinder((peri_d - 0.5) / 2, base_h + 0.2)
        base = base - hole.moved(bd.Location((x, y, base_h / 2)))

    # 4. 4 角定位柱孔(与 cover 角孔同尺寸 Ø9.4,一一对应):
    #    翻面/换面装配时收定位柱
    corner_d = p.get("corner_screw_d", 5.0)
    for (x, y) in corner_screw_positions(window_poly, jig):
        hole = Cylinder(corner_d / 2 + 2.2, base_h + 0.2)
        base = base - hole.moved(bd.Location((x, y, base_h / 2)))

    return base


# ---------------------------------------------------------------------------
# PCB 钢网(一体式,自带卡槽,独立使用)
# ---------------------------------------------------------------------------

def poly_solid_rings(exterior, holes, height):
    """外轮廓 + 内孔列表 → 带孔 extruded solid(z: 0..height)。
    失败返回 None(调用方可降级为 poly_solid 仅外轮廓)。"""
    ext = list(exterior)
    if len(ext) > 1 and tuple(ext[0]) == tuple(ext[-1]):
        ext = ext[:-1]
    if len(ext) < 3:
        return None
    ring_lists = [ext]
    for h in holes or []:
        # h 可能是点列表,也可能是 shapely LinearRing(geom.interiors)
        hl = list(h.coords) if hasattr(h, "coords") else list(h)
        if len(hl) > 1 and tuple(hl[0]) == tuple(hl[-1]):
            hl = hl[:-1]
        if len(hl) >= 3:
            ring_lists.append(hl)
    try:
        with BuildPart() as p:
            with BuildSketch(Plane.XY) as s:
                with BuildLine() as l:
                    Polyline(*[bd.Vector(x, y, 0) for x, y in ring_lists[0]], close=True)
                make_face()
                for hole_ring in ring_lists[1:]:
                    with BuildLine() as l:
                        Polyline(*[bd.Vector(x, y, 0) for x, y in hole_ring], close=True)
                    make_face(mode=bd.Mode.SUBTRACT)
            extrude(amount=height)
        return p.part
    except Exception:
        return None


def _pad_to_parts(pad):
    """焊盘条目 → (parts, pad_polarity)。支持三种格式:
    1. dict {"parts":[{polarity,points,holes}], "polarity": "D"} (光绘机新格式)
    2. list of part dict(序列化后的新格式)
    3. flat 顶点列表 [[x,y],...](旧格式)"""
    if isinstance(pad, dict):
        return pad.get("parts", []) or [], str(pad.get("polarity", "D")).upper()
    if isinstance(pad, list) and pad and isinstance(pad[0], dict):
        return pad, "D"
    return ([{"polarity": "D", "points": pad}] if len(pad) >= 3 else []), "D"


def _build_pad_solid(geom, height):
    """shapely 几何 → extruded solid(带内孔);失败返回 None"""
    # Y 镜像等操作会把环方向翻成 CW,先统一:外环 CCW / 内环 CW
    geom = shapely_orient(geom, 1.0)
    solid = poly_solid_rings(geom.exterior.coords, geom.interiors, height)
    if solid is None:
        solid = poly_solid(geom.exterior.coords, height)
    return solid


def _ring_coords(ring):
    """shapely 环 → 干净点列(去闭合重复点)"""
    pts = list(ring.coords) if hasattr(ring, "coords") else list(ring)
    if len(pts) > 1 and tuple(pts[0]) == tuple(pts[-1]):
        pts = pts[:-1]
    return pts


def _shapely_face(g, z):
    """shapely 多边形(带内孔)→ z 平面上的 OCC 平面 face。失败 None。
    外环 CCW / 内环 CW(shapely_orient 保证),face 法向 +Z。"""
    g = shapely_orient(g, 1.0)
    mk = BRepBuilderAPI_MakePolygon()
    for x, y in _ring_coords(g.exterior):
        mk.Add(gp_Pnt(x, y, z))
    mk.Close()
    if not mk.IsDone():
        return None
    mkf = BRepBuilderAPI_MakeFace(mk.Wire())
    if not mkf.IsDone():
        return None
    face = mkf.Face()
    for hole in g.interiors:
        mkh = BRepBuilderAPI_MakePolygon()
        for x, y in _ring_coords(hole):
            mkh.Add(gp_Pnt(x, y, z))
        mkh.Close()
        if not mkh.IsDone():
            continue
        mkf2 = BRepBuilderAPI_MakeFace(face, mkh.Wire())
        if mkf2.IsDone():
            face = mkf2.Face()
    return face


def _ocp_prisms(geoms, z0, height):
    """shapely 多边形列表 → OCC 棱柱 shape 列表(绕过 build123d 构建器)。
    先 shapely union 合并:重叠焊盘融合、结果两两不相交(Glue 布尔前提)。
    支持带内孔多边形(热焊盘等)。"""
    if height <= 0.001:
        return []
    merged = shapely_union(geoms)
    if merged.is_empty:
        return []
    polys = (list(merged.geoms) if merged.geom_type == "MultiPolygon"
             else [merged] if merged.geom_type == "Polygon" else [])
    shapes = []
    for g in polys:
        if g.geom_type != "Polygon" or g.area < 1e-6:
            continue
        g = shapely_orient(g, 1.0)
        mk = BRepBuilderAPI_MakePolygon()
        for x, y in _ring_coords(g.exterior):
            mk.Add(gp_Pnt(x, y, z0))
        mk.Close()
        if not mk.IsDone():
            continue
        mkf = BRepBuilderAPI_MakeFace(mk.Wire())
        if not mkf.IsDone():
            continue
        face = mkf.Face()
        for hole in g.interiors:
            mkh = BRepBuilderAPI_MakePolygon()
            for x, y in _ring_coords(hole):
                mkh.Add(gp_Pnt(x, y, z0))
            mkh.Close()
            if not mkh.IsDone():
                continue
            mkf2 = BRepBuilderAPI_MakeFace(face, mkh.Wire())
            if mkf2.IsDone():
                face = mkf2.Face()
        prism = BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, height))
        if prism.IsDone():
            shapes.append(prism.Shape())
    return shapes


def _glue_cut(part, shapes):
    """并行 + Glue 布尔切割。shapes 必须两两不相交(调用前 shapely union
    已保证);Glue 模式让 OCC 跳过工具间求交,千级工具快 ~4 倍。
    注意:Glue BOP 不接受 COMPOUND 作为参数(静默无效)—— 上次 Glue
    切割的结果是包着实体的 COMPOUND,续切前必须解包成 solid。"""
    builder = BRep_Builder()
    comp = TopoDS_Compound()
    builder.MakeCompound(comp)
    for s in shapes:
        builder.Add(comp, s)
    cut = BRepAlgoAPI_Cut()
    args = TopTools_ListOfShape()
    if part.wrapped.ShapeType() == TopAbs_ShapeEnum.TopAbs_COMPOUND:
        for solid in part.solids():
            args.Append(solid.wrapped)
    if args.Extent() == 0:
        args.Append(part.wrapped)
    tools = TopTools_ListOfShape()
    tools.Append(comp)
    cut.SetArguments(args)
    cut.SetTools(tools)
    cut.SetRunParallel(True)
    cut.SetGlue(BOPAlgo_GlueEnum.BOPAlgo_GlueShift)
    cut.Build()
    if not cut.IsDone():
        raise RuntimeError("OCC Glue 布尔切割失败")
    return bd.Part(cut.Shape())


def _glue_cut_or_fallback(part, shapes):
    """Glue 切割,失败降级为 build123d 串行布尔(慢但兼容)"""
    if not shapes:
        return part
    try:
        return _glue_cut(part, shapes)
    except Exception:
        builder = BRep_Builder()
        comp = TopoDS_Compound()
        builder.MakeCompound(comp)
        for s in shapes:
            builder.Add(comp, s)
        return part - bd.Compound(comp)


def _chamfer_ring_arc(shape, total_h, pocket_half):
    """卡槽环圈弧段的顶缘 0.2 小倒角(入口防刮伤 PCB)。
    只在环圈小实体上做(边数 ~几十),避免在带几千焊盘孔的完整件上
    遍历全部边。倒角边 = 顶面(z≈total_h)且在卡槽开口附近的边,
    与旧版(整件倒角)选择结果一致。失败返回原 shape。"""
    try:
        with BuildPart() as bp:
            add(bd.Part(shape))
            cands = []
            for e in bp.edges():
                c = e.center()
                if abs(c.Z - total_h) > 0.1:
                    continue
                bb = e.bounding_box()
                if max(abs(bb.min.X), abs(bb.max.X),
                       abs(bb.min.Y), abs(bb.max.Y)) < pocket_half + 0.5:
                    cands.append(e)
            if cands:
                chamfer(cands, length=0.2)
                return bp.part.wrapped
    except Exception:
        pass
    return shape


def _stagger_pad_geoms(pad_geoms, gap_thr, offset):
    """密脚错排(参考 Dream_maker):质心间距 < gap_thr 的焊盘连成链,
    链长 ≥3 判为密脚排(0.5mm 间距 QFP/QFN 等),链内二着色隔位沿局部
    法向 ±offset 交错偏移 —— 相邻开孔互相错开,阻焊桥变宽,减少连锡。"""
    n = len(pad_geoms)
    if n < 3 or offset <= 0 or gap_thr <= 0:
        return pad_geoms
    cents = [(g.centroid.x, g.centroid.y) for g, _ in pad_geoms]
    g2 = gap_thr * gap_thr

    # 邻接(质心距 < 阈值)→ union-find 连通链
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            dx = cents[i][0] - cents[j][0]
            dy = cents[i][1] - cents[j][1]
            if dx * dx + dy * dy < g2:
                parent[find(i)] = find(j)

    chains = {}
    for i in range(n):
        chains.setdefault(find(i), []).append(i)

    def canon_normal(nx, ny):
        """法向方向规范化:统一翻到 +Y 半平面(Y≈0 时取 +X),保证链内相邻焊盘的法向可比"""
        if ny < -1e-12 or (abs(ny) <= 1e-12 and nx < 0):
            return -nx, -ny
        return nx, ny

    out = list(pad_geoms)
    for idxs in chains.values():
        if len(idxs) < 3:
            continue
        # 链内邻接表
        adj = {i: [] for i in idxs}
        for a in range(len(idxs)):
            for b in range(a + 1, len(idxs)):
                i, j = idxs[a], idxs[b]
                dx = cents[i][0] - cents[j][0]
                dy = cents[i][1] - cents[j][1]
                if dx * dx + dy * dy < g2:
                    adj[i].append(j)
                    adj[j].append(i)
        # 二着色(路径/偶环严格隔位;奇环个别相邻对同色,影响可忽略)
        color = {}
        for start in idxs:
            if start in color:
                continue
            color[start] = 0
            queue = [start]
            while queue:
                i = queue.pop()
                for j in adj[i]:
                    if j not in color:
                        color[j] = 1 - color[i]
                        queue.append(j)
        # 隔位 ±法向偏移:法向 = 两近邻连线(局部切向)的垂线
        for i in idxs:
            nbrs = sorted(adj[i],
                          key=lambda j: (cents[i][0] - cents[j][0]) ** 2
                          + (cents[i][1] - cents[j][1]) ** 2)
            if not nbrs:
                continue
            if len(nbrs) >= 2:
                tx = cents[nbrs[0]][0] - cents[nbrs[1]][0]
                ty = cents[nbrs[0]][1] - cents[nbrs[1]][1]
            else:
                tx = cents[nbrs[0]][0] - cents[i][0]
                ty = cents[nbrs[0]][1] - cents[i][1]
            tl = math.hypot(tx, ty)
            if tl < 1e-9:
                continue
            nx, ny = canon_normal(-ty / tl, tx / tl)
            s = offset if color.get(i) else -offset
            out[i] = (shapely_translate(out[i][0], nx * s, ny * s), out[i][1])
    return out


def _grid_pad_geom(geom, size_thr, bar_w):
    """大孔开网格(参考 Dream_maker):单边 > size_thr 的开孔加十字网格条,
    分割成多个小开口 —— 大面积锡膏改为网格状漏下,印刷更均匀、不塌陷。
    只在子开口仍 ≥ 最小宽度时才加条(防止切出细条)。"""
    if geom.geom_type == "MultiPolygon":
        parts = [_grid_pad_geom(g, size_thr, bar_w) for g in geom.geoms
                 if g.geom_type == "Polygon"]
        return shapely_union(parts) if parts else geom
    if geom.geom_type != "Polygon":
        return geom
    minx, miny, maxx, maxy = geom.bounds
    w, h = maxx - minx, maxy - miny
    if max(w, h) <= size_thr:
        return geom
    cx, cy = geom.centroid.x, geom.centroid.y
    min_cell = max(0.8, bar_w)  # 子开口最小保留宽度
    bars = []
    if w >= bar_w + 2 * min_cell:
        bars.append(shapely_box(cx - bar_w / 2, miny - 0.5,
                                cx + bar_w / 2, maxy + 0.5))
    if h >= bar_w + 2 * min_cell:
        bars.append(shapely_box(minx - 0.5, cy - bar_w / 2,
                                 maxx + 0.5, cy + bar_w / 2))
    if not bars:
        return geom
    out = geom.difference(shapely_union(bars))
    if out.is_empty or out.area < 1e-6:
        return geom
    return out


def build_stencil(p, side="top"):
    """PCB 钢网:外框 + 顶面 PCB 卡槽 + 槽底薄钢网层(焊盘开孔只穿这一层)

    构建坐标:z=0 = 底面(钢网层/刮刀面,平整),z 向上递增。
    总厚度 = PCB 厚度 + 钢网层厚度。
    PCB 从顶面放入卡槽(焊盘朝下),锡膏从底面钢网层刮入,穿过开孔到达焊盘。
    不依赖夹具,独立使用;无四角定位柱孔(凹槽壁完成 PCB 定位)。

    双面钢网(与 Dream_maker 等实机验证约定一致):
    - side="top":PCB 翻面(绕 X 轴,顶面朝下)放入卡槽 →
      板框与焊盘统一 Y 镜像(y→-y),翻面放入后开孔对准 Top 焊盘。
    - side="bottom":PCB 正放(底面朝下)入槽 → 板框与焊盘用原坐标。

    取放缺口:方向/尺寸与夹具逻辑一致(pry_notch_sides +
    pry_notch_scale × 自动基准),形状为梯形凹陷 —— 长边在里贴槽缘、
    短边朝外,两侧斜坡向内张开(手指进入后越往里越宽,托板空间足),
    底部平直贴齐 PCB 边缘,不倒圆角。
    """
    pcb_t = p["pcb_thickness"]
    stencil_t = float(p.get("stencil_thickness", 0.3))
    frame_w = float(p.get("stencil_frame_width", 12.0))
    pocket_clr = float(p.get("pocket_clearance", 0.1))
    pad_shrink = float(p.get("pad_shrink", 0.0)) / 100.0
    total_h = pcb_t + stencil_t
    r_out = p.get("outer_corner_radius", 5.0)

    # 焊盘后处理(参考 Dream_maker,均有开关/参数)
    # 喇叭孔本版禁用:OCC 对"上下开孔尺寸不同"的几何(台阶分层/领环两种
    # 构造均试过)在千级焊盘时平面分割病态慢(2448 焊盘 >3min),而直孔
    # 纯 2D 分层路径 17s。参数保留(协议/工程文件兼容),统一按直孔处理;
    # 未来找到快速构造后把 taper_s 恢复为 max(1.0, taper_pct/100.0)。
    taper_pct = float(p.get("stencil_taper", 105.0))  # noqa: F841(保留解析)
    taper_s = 1.0
    do_stagger = bool(p.get("stencil_stagger", False))      # 密脚错排
    stagger_gap = float(p.get("stencil_stagger_gap", 0.55))
    stagger_off = float(p.get("stencil_stagger_offset", 0.15))
    # 测试点过滤:小圆形孤立焊盘(测试探针点)不开锡膏孔,匹配嘉立创行为
    filter_tp = bool(p.get("stencil_filter_test_points", True))
    tp_max_dia = float(p.get("stencil_test_point_max_dia", 1.2))
    tp_iso = float(p.get("stencil_test_point_isolation", 1.5))
    do_grid = bool(p.get("stencil_grid", False))           # 大孔开网格
    grid_size = float(p.get("stencil_grid_size", 2.0))
    grid_bar = float(p.get("stencil_grid_bar", 0.5))
    # 焊盘方形化始终开启:钢网厂激光切割出直角矩形,锡膏释放更好;
    # PCB 焊盘视觉上是方的,但 EDA 导出 paste 层可能用 O(长圆)光圈
    # 或带圆角的宏,统一按包围盒转直角矩形。仅对拉长形(长宽比>1.15)
    # 生效,圆/方焊盘不变。
    do_square = True

    # 焊盘来源:top 兜底读旧字段 stencil_pads;bottom 只读 stencil_pads_bottom
    if side == "bottom":
        pads_list = p.get("stencil_pads_bottom", [])
    else:
        pads_list = p.get("stencil_pads_top", p.get("stencil_pads", []))

    # PCB 板框多边形(居中坐标系);top 面翻面入槽 → Y 镜像
    outline_pts = p.get("pcb_outline_points", [])
    if len(outline_pts) >= 3:
        if side == "top":
            outline_pts = [(x, -y) for x, y in outline_pts]
        base_poly = shapely_orient(ShapelyPolygon(outline_pts), 1.0)
        if not base_poly.is_valid:
            base_poly = base_poly.buffer(0)
    else:
        # 矩形兜底:上下对称,Y 镜像后不变
        w, h = p["pcb_size_x"] / 2, p["pcb_size_y"] / 2
        base_poly = shapely_box(-w, -h, w, h)

    if base_poly.is_empty:
        raise ValueError("PCB 板框多边形为空")

    # 卡槽 = 板框 + 间隙
    pocket_poly = base_poly.buffer(pocket_clr, join_style=1, resolution=RES).simplify(0.02)
    # 外框 = 板框整体外扩(间隙+边框宽,miter 尖角)→ 外角半径独立可调
    # (stencil_corner_radius,默认 3mm;先用 miter 拿到直角外框,
    #  再 buffer(-r).buffer(r) 把四个外凸角圆成半径 r 的圆弧)
    frame_poly = base_poly.buffer(
        pocket_clr + frame_w, join_style=2, resolution=RES
    ).simplify(0.02)
    # 外框形状:outline=跟随板形(默认);rect=外扩成矩形(板框包围盒+边框)
    if str(p.get("stencil_frame_shape", "outline")).strip().lower() == "rect":
        minx, miny, maxx, maxy = frame_poly.bounds
        frame_poly = shapely_box(minx, miny, maxx, maxy)
    r_frame = max(0.0, min(float(p.get("stencil_corner_radius", 3.0)), 20.0))
    if r_frame > 0.05:
        fr_inner = frame_poly.buffer(-r_frame, join_style=2, resolution=RES)
        if not fr_inner.is_empty:
            frame_poly = fr_inner.buffer(
                r_frame, join_style=1, resolution=RES
            ).simplify(0.02)

    def _build_full():
        _eps = 0.05  # 切割余量,避免共面
        pocket_bottom = max(0.0, stencil_t - _eps)  # 钢网真实顶面(卡槽底)

        # 2. 2D 构图(shapely,全部平面运算,毫秒~秒级):
        #    取放缺口只切钢网层以上的槽壁(差在 ring 上,底层不挖穿)
        #    → 槽壁让位可直接在平面完成;卡槽环圈 = 外框 - 卡槽。
        #    钢网层是纯棱柱体 → 焊盘开孔同样平面完成,3D 只剩分层挤出
        #    + 一次融合,彻底绕开"几千工具 × 复杂实体"的布尔切割。
        # 取放缺口:方向/尺寸逻辑与夹具一致(pry_notch_sides +
        # pry_notch_scale × 自动基准,钳位同式),形状差异化 ——
        # 从槽缘向外切的浅梯形凹口(长边贴槽缘、短边朝外,两侧
        # 斜坡向内张开,不倒圆角),不贯穿外框,槽壁局部让位,
        # 镊子/手指从上方伸入即可抠起 PCB。
        notch_polys = []
        sides = [
            s for s in (str(x).strip().lower() for x in p.get("pry_notch_sides", ["down"]))
            if s in ("down", "up", "left", "right")
        ]
        # top 面板框已 Y 镜像(翻面入槽),缺口方向须反向映射,
        # 保证顶层/底层缺口在视觉上同侧(用户选"下"就都是"下")
        if side == "top":
            sides = [{"down": "up", "up": "down"}.get(s, s) for s in sides]
        if sides:
            scale = max(0.5, min(1.5, float(p.get("pry_notch_scale", 1.0))))
            minx, miny, maxx, maxy = pocket_poly.bounds
            for nside in sides:
                if nside in ("down", "up"):
                    cu = (minx + maxx) / 2
                    L = maxx - minx
                    edge = maxy if nside == "up" else miny
                else:
                    cu = (miny + maxy) / 2
                    L = maxy - miny
                    edge = maxx if nside == "right" else minx
                sgn = 1 if nside in ("up", "right") else -1
                # 浅梯形凹口:从槽缘(里)向外切一小段(min(4, 边框宽一半)),
                # 不贯穿到外缘 —— 槽壁局部让位,镊子/手指从上方伸入抠起
                # PCB;0.1 切割余量仅保证槽缘切口干净(视觉不可见)
                v_in = edge - sgn * 0.1
                depth = min(4.0, frame_w * 0.5)
                v_out = v_in + sgn * depth
                run = abs(v_out - v_in)
                if run < 1.0:
                    continue
                # 自动基准与夹具同式:边长 15% 与缺口深度(run×0.9)取大,
                # 夹 12~24mm;滑动条比例缩放,钳制边界随板边比例化
                auto_w = max(12.0, min(24.0, max(L * 0.15, run * 0.9)))
                w_s = max(L * 0.06, min(min(30.0, L * 0.5), auto_w * scale))
                w_l = w_s + 2.0 * min(4.0, run * 0.35)
                # 约束收缩:缺口两端距槽角 ≥2mm
                sc = min(1.0, (L / 2 - 2.0) / (w_l / 2))
                if sc < 1.0:
                    w_s, w_l = w_s * sc, w_l * sc
                if w_s < 6.0:
                    continue
                if nside in ("down", "up"):
                    npts = [(cu - w_s / 2, v_out), (cu + w_s / 2, v_out),
                            (cu + w_l / 2, v_in), (cu - w_l / 2, v_in)]
                else:
                    npts = [(v_out, cu - w_s / 2), (v_out, cu + w_s / 2),
                            (v_in, cu + w_l / 2), (v_in, cu - w_l / 2)]
                # 长边(w_l)在里贴槽缘、短边(w_s)朝外:外口收窄,两侧
                # 斜坡向内张开,手指进入后越往里越宽(托板空间更足)
                notch_poly = ShapelyPolygon(npts)
                # 四角圆角过渡:梯形是从外框挖掉的部分,其凸角减到实体
                # 上对应实体凹角 → 用 buffer(+r).buffer(-r) 让梯形凸角
                # 外凸,减完实体凹角即为凹圆角(圆弧朝外框方向过渡);
                # r 随缺口尺寸自适应,上限 1.5mm
                r_n = min(1.5, w_s / 4, run / 4)
                if r_n >= 0.5:
                    rounded = (
                        notch_poly.buffer(r_n, resolution=8)
                        .buffer(-r_n, resolution=8)
                    )
                    if not rounded.is_empty and rounded.geom_type == "Polygon":
                        notch_poly = rounded
                if not notch_poly.is_empty and notch_poly.geom_type == "Polygon":
                    notch_polys.append(notch_poly)
        frame_2d = frame_poly  # 钢网层保持完整(底层不被缺口挖穿)
        ring_2d = frame_poly.difference(pocket_poly)
        if notch_polys:
            # 缺口只切钢网层以上的槽壁(让位以便取放 PCB),
            # 底层钢网面(PCB 支撑/锡膏印刷面)保持完整
            notch_union = shapely_union(notch_polys) if len(notch_polys) > 1 else notch_polys[0]
            ring_2d = ring_2d.difference(notch_union)
            if ring_2d.is_empty:
                raise RuntimeError("取放缺口把槽壁切空")
        if ring_2d.is_empty:
            raise RuntimeError("卡槽把外框切空")

        # 3. 焊盘解析(多部件极性/镜像/收缩/简化)
        pad_geoms = []  # [(shapely geom, 焊盘极性)]
        for pad in pads_list:
            parts, pad_pol = _pad_to_parts(pad)
            if not parts:
                continue
            dark, clear = [], []
            for part_d in parts:
                pts = part_d.get("points", [])
                holes = [h for h in part_d.get("holes", []) if len(h) >= 3]
                if len(pts) < 3:
                    continue
                if side == "top":
                    pts = [(x, -y) for x, y in pts]
                    holes = [[(x, -y) for x, y in h] for h in holes]
                try:
                    g = ShapelyPolygon(pts, holes) if holes else ShapelyPolygon(pts)
                except Exception:
                    continue
                if not g.is_valid:
                    g = g.buffer(0)
                if g.is_empty or g.area < 1e-6:
                    continue
                if str(part_d.get("polarity", "D")).upper() == "C":
                    clear.append(g)
                else:
                    dark.append(g)
            if not dark:
                continue
            geom = shapely_union(dark) if len(dark) > 1 else dark[0]
            if clear:
                geom = geom.difference(shapely_union(clear))
            if geom.is_empty or geom.area < 1e-6:
                continue
            if pad_shrink > 0:
                s = max(0.05, 1.0 - pad_shrink)
                geom = shapely_scale_aff(geom, xfact=s, yfact=s, origin="centroid")
                if geom.is_empty or geom.area < 1e-6:
                    continue
            # 焊盘方形化(在 simplify 之前做):simplify(0.02) 会移除长圆形
            # 圆弧上的顶点,导致 bounds 收缩、中心偏移。
            # 用最小旋转外接矩形(MRR)代替轴对齐 bounds:保持焊盘原始旋转
            # 方向(斜放的电容/电阻不被转正),只补全圆角/缺口。
            # 触发条件(满足任一):
            #   1) 拉长形(MRR 长宽比 > 1.15):O 光圈/圆角矩形 → 直角矩形
            #   2) 有凹陷(面积 < 凸包面积 92%):C 形/开槽焊盘 → 补全矩形
            #      (部分 EDA 工具在锡膏层生成带缺口的 region,钢网应开全孔)
            # 圆/方焊盘不变形。
            if do_square:
                mrr = geom.minimum_rotated_rectangle
                mrr_pts = list(mrr.exterior.coords)
                # MRR 两条相邻边长 → 长宽
                e1 = math.hypot(mrr_pts[1][0] - mrr_pts[0][0],
                                mrr_pts[1][1] - mrr_pts[0][1])
                e2 = math.hypot(mrr_pts[2][0] - mrr_pts[1][0],
                                mrr_pts[2][1] - mrr_pts[1][1])
                bw, bh = max(e1, e2), min(e1, e2)
                if min(bw, bh) > 1e-6:
                    elongated = bw / bh > 1.15
                    # 有凹陷的单连通焊盘(C 形/开槽):面积 < 凸包 92% 且无内孔。
                    # MultiPolygon(如热焊盘被 clear 切成多块)不处理,保持原貌。
                    concave = False
                    if geom.geom_type == "Polygon":
                        has_holes = len(list(geom.interiors)) > 0
                        if not has_holes:
                            ch_area = geom.convex_hull.area
                            if ch_area > 1e-9:
                                concave = geom.area / ch_area < 0.92
                    if elongated or concave:
                        geom = mrr
            # 简化 0.02mm:圆孔 16~32 顶点 → ~6-8 顶点,孔壁面数减半,
            # OCC 网格化耗时与面数成正比(0.3ms/面);0.02mm 远低于锡膏
            # 印刷公差(±0.05mm)和打印机分辨率(FDM 0.4 喷嘴/树脂 0.05)
            geom = geom.simplify(0.02, preserve_topology=True)
            if geom.is_empty or geom.area < 1e-6:
                continue
            pad_geoms.append((geom, pad_pol))

        # 测试点过滤:小圆形 + 孤立的焊盘 = 测试探针点,不开锡膏孔。
        # 区分于 BGA 焊盘(也是小圆但成阵列,间距 < tp_iso)。
        if filter_tp and len(pad_geoms) >= 2:
            cents = [(g.centroid.x, g.centroid.y) for g, _ in pad_geoms]
            iso2 = tp_iso * tp_iso
            kept = []
            for i, (g, pol) in enumerate(pad_geoms):
                is_tp = False
                if pol == "D" and g.geom_type == "Polygon":
                    bx0, by0, bx1, by1 = g.bounds
                    bw, bh = bx1 - bx0, by1 - by0
                    dia = max(bw, bh)
                    # 圆度:圆面积 / 外接矩形面积 = π/4 ≈ 0.785
                    if (dia <= tp_max_dia and min(bw, bh) > 1e-6
                            and bw / bh < 1.1):
                        circ = g.area / (bw * bh)
                        if 0.65 < circ < 0.90:
                            # 孤立检查:tp_iso 内无其他焊盘中心
                            cx, cy = cents[i]
                            isolated = True
                            for j in range(len(pad_geoms)):
                                if j == i:
                                    continue
                                dx = cents[j][0] - cx
                                dy = cents[j][1] - cy
                                if dx * dx + dy * dy < iso2:
                                    isolated = False
                                    break
                            is_tp = isolated
                if not is_tp:
                    kept.append((g, pol))
            pad_geoms = kept

        # 密脚错排(隔位 ±法向偏移)
        if do_stagger and len(pad_geoms) >= 3:
            pad_geoms = _stagger_pad_geoms(pad_geoms, stagger_gap, stagger_off)
        # 大孔开网格(只对 D 极性开口;C 极性是恢复材料,不网格化)
        if do_grid:
            pad_geoms = [((_grid_pad_geom(g, grid_size, grid_bar) if pol == "D"
                           else g), pol) for g, pol in pad_geoms]

        # 开孔几何拆分:D 极性 = 开孔(裁剪到卡槽内,超出板框的开孔
        # 本就无意义);焊盘级 C 极性(%LPC)= 恢复材料。
        dark_geoms, clear_geoms = [], []
        for geom, pad_pol in pad_geoms:
            if geom.is_empty or geom.area < 1e-6:
                continue
            if pad_pol == "C":
                clear_geoms.append(geom)
                continue
            g = geom.intersection(pocket_poly)
            if g.is_empty or g.area < 1e-6:
                continue
            dark_geoms.append(g)

        # 4. 分层 2D:钢网层 = 外框(含缺口) - 开孔 + LPC 恢复材料。
        #    喇叭孔 = 两层(下半区放大/上半区原尺寸);直孔 = 单层。
        #    %LPC 恢复材料在平面上并回(岛落在实心钢网层上,与旧版
        #    3D 融合几何等价,且不会凸出底面)。
        dark_union = shapely_union(dark_geoms) if dark_geoms else None
        clear_union = shapely_union(clear_geoms) if clear_geoms else None

        def _layer_2d(mask):
            g = frame_2d
            if mask is not None and not mask.is_empty:
                g = g.difference(mask)
                if g.is_empty:
                    return g
            if clear_union is not None and not clear_union.is_empty:
                g = g.union(clear_union)
            return g

        # 5. 3D 组装:分层挤出 + 环圈顶缘倒角(小实体)+ Compound 组合。
        pieces = []
        fast_layers = []   # 纯棱柱层 [(shapely geom, z0, z1)]:快速 STL 路径
        fast_solids = []   # 小实体(倒角环圈):OCC 网格化,百面级瞬时
        ring_h = total_h - pocket_bottom
        if ring_h > 0.001:
            pocket_half = max(abs(pocket_poly.bounds[2]), abs(pocket_poly.bounds[3]),
                              abs(pocket_poly.bounds[0]), abs(pocket_poly.bounds[1]))
            for s in _ocp_prisms([ring_2d], pocket_bottom, ring_h):
                cs = _chamfer_ring_arc(s, total_h, pocket_half)
                pieces.append(cs)
                fast_solids.append(cs)
        if pocket_bottom > 0.001:
            # 直孔:单层 2D(外框 - 开孔 + LPC 恢复)一次挤出。
            # (喇叭孔见上方禁用说明)
            up_2d = _layer_2d(dark_union)
            if not up_2d.is_empty:
                pieces += _ocp_prisms([up_2d], 0.0, pocket_bottom)
                fast_layers.append((up_2d, 0.0, pocket_bottom))
        # 不做布尔融合:分层 prism 只在平面接触、接触面完全重合,直接
        # Compound 组合即可。Glue BOP 对"几千孔 × 两万面"实体融合要 15s+
        # (接触面边配对/平面分割),Compound 几何等价且瞬完成;STL 网格化
        # 按面独立进行、切片器对共面重合边完全兼容,3D 打印结果一致。
        if not pieces:
            raise RuntimeError("钢网分层组装失败")
        bld = BRep_Builder()
        comp = TopoDS_Compound()
        bld.MakeCompound(comp)
        for s in pieces:
            bld.Add(comp, s)
        part = bd.Part(comp)
        # 快速 STL 元数据:generate_to_file 用(体积校验失败自动回退 OCC);
        # STEP 导出与 OCC 兜底路径不受影响
        part._fast_stl = (fast_layers, fast_solids)

        return part

    try:
        return _build_full()
    except Exception as e:
        # 降级:只生成外框 + 卡槽(无焊盘/缺口/倒角),保证不崩溃
        if os.environ.get("JIG_DEBUG"):
            import traceback
            traceback.print_exc()
        part = poly_solid(frame_poly.exterior.coords, total_h)
        if part is None:
            raise
        pocket_solid = poly_solid(pocket_poly.exterior.coords, pcb_t + 0.1)
        if pocket_solid is not None:
            part = part - pocket_solid.moved(bd.Location((0, 0, stencil_t)))
        return part


# ---------------------------------------------------------------------------
# 导出与协议(不变)
# ---------------------------------------------------------------------------

def build_part(p, part_name):
    builders = {
        "base": build_base, "insert": build_insert, "cover": build_cover,
        # 双面钢网("stencil" 兼容旧调用 = 顶层)
        "stencil": build_stencil,
        "stencil_top": lambda p: build_stencil(p, "top"),
        "stencil_bottom": lambda p: build_stencil(p, "bottom"),
    }
    if part_name not in builders:
        raise ValueError(f"Unknown part: {part_name}. Use one of {list(builders)}")
    return builders[part_name](p)


# ---------------------------------------------------------------------------
# 快速 STL 导出(钢网纯棱柱层专用)
# ---------------------------------------------------------------------------

def _cap_tris_2d(g):
    """多边形(带内孔)平面三角化:(nodes(N,2), faces(M,3))。
    用 OCC 网格化单个平面 face(C++ Delaunay,几千内环亚秒级);
    face 为 FORWARD(+Z 法向)→ 三角形从 +Z 看是 CCW。"""
    from OCP.BRep import BRep_Tool
    face = _shapely_face(g, 0.0)
    if face is None:
        raise RuntimeError("cap face 构建失败")
    BRepMesh_IncrementalMesh(face, 0.1, False, 0.7, True)
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face, loc)
    if tri is None:
        raise RuntimeError("cap face 网格化失败")
    import numpy as np
    n = tri.NbNodes()
    nodes = np.empty((n, 2), dtype=np.float64)
    for i in range(1, n + 1):
        p = tri.Node(i)
        nodes[i - 1] = (p.X(), p.Y())
    m = tri.NbTriangles()
    faces = np.empty((m, 3), dtype=np.int64)
    for i in range(1, m + 1):
        a, b, c = tri.Triangle(i).Get()
        faces[i - 1] = (a - 1, b - 1, c - 1)
    return nodes, faces


def _prism_tris(g, z0, z1):
    """棱柱(多边形挤出 z0→z1)→ 三角形 (N,3,3)(build 坐标,外向绕序)。
    顶/底面用 OCC 三角化(2 个面);孔壁在 numpy 里直接生成 —— 这是
    OCC 网格化整块的瓶颈(17k 孔壁面 × 0.2ms/面 ≈ 4s)。"""
    import numpy as np
    nodes, faces = _cap_tris_2d(g)
    m = len(faces)
    # 顶面(z1):CCW 原序(法向 +Z = 外向)
    top = np.empty((m, 3, 3), dtype=np.float64)
    for k in range(3):
        xy = nodes[faces[:, k]]
        top[:, k, 0] = xy[:, 0]
        top[:, k, 1] = xy[:, 1]
        top[:, k, 2] = z1
    # 底面(z0):绕序反转
    bot = top[:, ::-1, :].copy()
    bot[:, :, 2] = z0
    # 孔壁:外环 CCW / 内环 CW(orient 保证)→ 同一公式均为外法向
    walls = []
    for ring in [g.exterior, *g.interiors]:
        pts = np.asarray(_ring_coords(ring), dtype=np.float64)
        if len(pts) < 2:
            continue
        nxt = np.roll(pts, -1, axis=0)
        cnt = len(pts)
        a0 = np.column_stack([pts, np.full(cnt, z0)])
        b0 = np.column_stack([nxt, np.full(cnt, z0)])
        a1 = np.column_stack([pts, np.full(cnt, z1)])
        b1 = np.column_stack([nxt, np.full(cnt, z1)])
        walls.append(np.stack([a0, b0, b1], axis=1))
        walls.append(np.stack([a0, b1, a1], axis=1))
    return np.concatenate([top, bot] + walls)


def _occ_solid_tris(shape):
    """OCC 实体网格化 → 三角形 (N,3,3)(build 坐标)。小实体专用
    (环圈 ~百面);大实体会慢,走棱柱快速路径。"""
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_Orientation
    import numpy as np
    BRepMesh_IncrementalMesh(shape, 0.1, False, 0.7, True)
    out = []
    exp = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            tf = loc.Transformation()
            rev = face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                if rev:
                    b, c = c, b
                out.append((tri.Node(a).Transformed(tf).Coord(),
                            tri.Node(b).Transformed(tf).Coord(),
                            tri.Node(c).Transformed(tf).Coord()))
        exp.Next()
    return np.asarray(out, dtype=np.float64)


def _write_stl_fast(output, layers, occ_solids):
    """快速 STL:棱柱层直接生成三角形 + 小实体 OCC 网格化,一次写出。
    layers: [(shapely geom, z0, z1)];occ_solids: [OCC shape]。
    校验失败抛异常,调用方回退 OCC 全量路径。"""
    import struct
    import numpy as np
    chunks = []
    layer_vol = 0.0
    for geom, z0, z1 in layers:
        h = float(z1) - float(z0)
        polys = (list(geom.geoms) if geom.geom_type == "MultiPolygon"
                 else [geom])
        for g in polys:
            if g.geom_type == "Polygon" and g.area > 1e-9:
                chunks.append(_prism_tris(g, float(z0), float(z1)))
                layer_vol += g.area * h
    for s in occ_solids:
        chunks.append(_occ_solid_tris(s))
    if not chunks:
        raise RuntimeError("快速 STL 无三角形")
    tris = np.concatenate(chunks)
    # 绕序校验:外向绕序的封闭网格体积必为正;且不应小于棱柱层体积
    # (环圈等实体只会增加体积;缺口/开孔只减棱柱层自身)
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    vol = np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0
    if vol <= 0 or vol < 0.5 * layer_vol:
        raise RuntimeError(f"快速 STL 体积校验失败: {vol:.1f} vs {layer_vol:.1f}")
    # build Z-up → STL/three.js Y-up:(x,y,z)→(x,z,-y)
    t = tris[:, :, [0, 2, 1]].copy()
    t[:, :, 2] *= -1.0
    n = len(t)
    rec = np.zeros(n, dtype=np.dtype(
        [("normal", "<f4", (3,)), ("verts", "<f4", (3, 3)), ("attr", "<u2")]))
    rec["normal"] = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    rec["verts"] = t
    with open(output, "wb") as f:
        f.write(b"mason fast-stl".ljust(80, b"\0"))
        f.write(struct.pack("<I", n))
        f.write(rec.tobytes())


def generate_to_file(params, part_name, output_path, fmt="stl"):
    """生成单个部件并导出到 output_path(CLI 与 server 模式共用)"""
    part = build_part(params, part_name)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    if fmt == "stl":
        # 快速路径:钢网纯棱柱层(顶底面 OCC 三角化 + 孔壁 numpy 生成),
        # 千孔钢网比 OCC 全量网格化快 ~3x;校验失败回退 OCC 路径
        fast = getattr(part, "_fast_stl", None)
        if fast is not None:
            try:
                _write_stl_fast(output, *fast)
                return output
            except Exception:
                if os.environ.get("JIG_DEBUG"):
                    import traceback
                    traceback.print_exc()
        # OCC 原生路径(兜底 + 非钢网部件):
        # 旋转 Z-up → Y-up 用 O(1) 的 TopLoc_Location(bd.rotate 遍历
        # 变换全部几何,万级面要 1.3s;实测两者 STL 输出完全一致)
        trsf = gp_Trsf()
        trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), -math.pi / 2)
        shape = part.wrapped
        shape.Move(TopLoc_Location(trsf))
        BRepMesh_IncrementalMesh(shape, 0.1, False, 0.7, True)
        writer = StlAPI_Writer()
        writer.ASCIIMode = False
        writer.Write(shape, str(output))
    else:
        # STEP:走 build123d(需 bd 对象,显式旋转)
        part = part.rotate(bd.Axis.X, -90)
        export_step(part, str(output))
    return output


def serve():
    """常驻服务模式:stdin 读 JSON 请求行,stdout 回 JSON 响应行。

    协议(每行一个 JSON 对象):
      请求  {"id": 1, "cmd": "ping"}
            {"id": 2, "cmd": "generate", "part": "base", "format": "stl", "params": {...}}
            {"id": 3, "cmd": "shutdown"}
      响应  {"id": 1, "ok": true, "pong": true}
            {"id": 2, "ok": true, "path": "C:/.../jig-xxx.stl"}
            {"id": 2, "ok": false, "error": "..."}

    stdin 关闭(父进程退出)即自然退出。stderr 仅写日志,不参与协议。
    """
    import tempfile
    import uuid as _uuid

    def respond(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    print("[server] ready", file=sys.stderr)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")

            if cmd == "ping":
                respond({"id": rid, "ok": True, "pong": True})
            elif cmd == "generate":
                fmt = req.get("format", "stl")
                out = Path(tempfile.gettempdir()) / f"jig-{_uuid.uuid4()}.{fmt}"
                generate_to_file(req["params"], req["part"], out, fmt)
                respond({"id": rid, "ok": True, "path": str(out)})
            elif cmd == "shutdown":
                respond({"id": rid, "ok": True})
                break
            else:
                respond({"id": rid, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as e:  # noqa: BLE001 - 协议层兜底,单请求失败不杀服务
            respond({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})
    print("[server] stdin closed, exiting", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="PCB 钢网夹具生成器")
    parser.add_argument("--input", help="JSON params 文件路径")
    parser.add_argument("--output", help="输出 STL/STEP 路径")
    parser.add_argument(
        "--part",
        choices=["base", "insert", "cover", "stencil",
                 "stencil_top", "stencil_bottom"],
        help="生成哪个部件",
    )
    parser.add_argument(
        "--format", default="stl", choices=["stl", "step"], help="输出格式"
    )
    parser.add_argument(
        "--server", action="store_true", help="常驻服务模式(stdin/stdout JSON 协议)"
    )
    args = parser.parse_args()

    if args.server:
        serve()
        return

    if not (args.input and args.output and args.part):
        parser.error("--input/--output/--part 为必填(或使用 --server)")

    with open(args.input, "r", encoding="utf-8") as f:
        params = json.load(f)

    if args.part in ("stencil", "stencil_top", "stencil_bottom"):
        n_top = len(params.get("stencil_pads_top", params.get("stencil_pads", [])))
        n_bot = len(params.get("stencil_pads_bottom", []))
        print(
            f"[info] part={args.part} format={args.format} "
            f"pcb={params['pcb_size_x']:.1f}x{params['pcb_size_y']:.1f} "
            f"stencil_t={params.get('stencil_thickness', 0)} "
            f"pads_top={n_top} pads_bottom={n_bot}",
            file=sys.stderr,
        )
    else:
        print(
            f"[info] part={args.part} format={args.format} "
            f"pcb={params['pcb_size_x']:.1f}x{params['pcb_size_y']:.1f} "
            f"jig={params['jig_size']:.0f} "
            f"outline_pts={len(params.get('pcb_outline_points', []))} "
            f"holes={len(params.get('pcb_outline_holes', []))}",
            file=sys.stderr,
        )

    output = generate_to_file(params, args.part, args.output, args.format)
    print(f"[ok] {output}", file=sys.stderr)


if __name__ == "__main__":
    main()
