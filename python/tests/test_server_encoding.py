"""The engine's JSON pipes must use UTF-8, regardless of Windows locale."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


GENERATOR = Path(__file__).resolve().parents[1] / "jig_generator.py"


def run_server(requests, inherited_encoding):
    env = dict(os.environ, PYTHONIOENCODING=inherited_encoding)
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--server"],
        input="".join(json.dumps(request, ensure_ascii=False) + "\n"
                      for request in requests).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        timeout=120,
    )
    if result.returncode:
        raise AssertionError(result.stderr.decode("utf-8", errors="replace"))
    return [json.loads(line) for line in result.stdout.decode("utf-8").splitlines()]


class ServerEncodingTests(unittest.TestCase):
    def test_non_ascii_requests_and_responses_ignore_ascii_stdio_default(self):
        replies = run_server([
            {"id": "确认-😀", "cmd": "ping"},
            {"id": 2, "cmd": "不存在的命令-😀"},
            {"id": 3, "cmd": "shutdown"},
        ], "ascii")
        self.assertEqual(replies[0], {"id": "确认-😀", "ok": True, "pong": True})
        self.assertEqual(replies[1]["error"], "unknown cmd: 不存在的命令-😀")
        self.assertFalse(replies[1]["ok"])
        self.assertEqual(replies[2], {"id": 3, "ok": True})

    def test_chinese_export_path_is_not_mojibake_with_gbk_stdio_default(self):
        params = {
            "pcb_size_x": 30, "pcb_size_y": 20, "pcb_thickness": 1.6,
            "pcb_outline_points": [[-15, -10], [15, -10], [15, 10], [-15, 10]],
            "pcb_outline_holes": [], "stencil_thickness": 0.3,
            "stencil_frame_width": 5, "pad_shrink": 0,
            "stencil_pads": [[[-1, -1], [1, -1], [1, 1], [-1, 1]]],
        }
        with tempfile.TemporaryDirectory(prefix="mason-encoding-") as directory:
            output = Path(directory) / "实包模型导出" / "钢网.stl"
            replies = run_server([
                {"id": 1, "cmd": "generate", "part": "stencil_top",
                 "format": "stl", "params": params, "output": str(output)},
                {"id": 2, "cmd": "stats", "part": "stencil_top", "params": params},
                {"id": 3, "cmd": "shutdown"},
            ], "gbk")
            self.assertTrue(replies[0]["ok"], replies[0])
            self.assertEqual(Path(replies[0]["path"]), output)
            # A protocol round trip alone can hide GBK/UTF-8 double corruption.
            # Read the exact requested path, not the path returned by the server.
            content = output.read_bytes()
            triangles = struct.unpack_from("<I", content, 80)[0]
            self.assertGreater(triangles, 0)
            self.assertEqual(len(content), 84 + triangles * 50)
            self.assertTrue(replies[1]["ok"], replies[1])
            self.assertGreater(replies[1]["volume"], 0)
            self.assertGreater(replies[1]["area"], 0)
            self.assertEqual(replies[2], {"id": 3, "ok": True})


if __name__ == "__main__":
    unittest.main()
