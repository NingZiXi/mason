# -*- coding: utf-8 -*-
"""几何验证测试运行器:依次跑 python/tests/test_*.py,汇总通过/失败

用法(仓库根):python python/tests/run_all.py [test_name ...]
不传参数 = 跑全部。每个测试独立子进程(互不污染 build123d/OCC 全局状态)。
"""
import subprocess
import sys
import time
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent

ALL_TESTS = [
    "test_screw_layout.py",   # 快:纯算法,无几何生成
    "test_screw_spec.py",     # 周圈螺丝规格联动(孔径随规格切换)
    "test_stencil.py",
    "test_stencil_pads.py",   # PCB 钢网(一体式)几何
    "test_notch_depth.py",
    "test_notch_stencil.py",
    "test_notch_side.py",     # top/bottom 钢网缺口落在 PCB 同一物理边缘
    "test_v2.py",
    "test_holes.py",
    "test_irregular.py",
    "test_hex_nut.py",        # B 面底座 M3 六角螺母沉孔
]


def main():
    names = sys.argv[1:] or ALL_TESTS
    results = []
    for name in names:
        path = TESTS_DIR / name
        print(f"\n########## {name} ##########", flush=True)
        t0 = time.time()
        r = subprocess.run([sys.executable, str(path)], cwd=str(TESTS_DIR))
        dt = time.time() - t0
        results.append((name, r.returncode == 0, dt))

    print("\n" + "=" * 50)
    print("汇总:")
    failed = 0
    for name, ok, dt in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name} ({dt:.0f}s)")
        failed += 0 if ok else 1
    print(f"\n{'全部通过' if failed == 0 else f'{failed} 个测试失败'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
