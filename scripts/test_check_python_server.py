import tempfile
import unittest
from pathlib import Path
import subprocess

from check_python_server import check_server


class ServerSmokeTests(unittest.TestCase):
    def test_windows_build_script_has_explicit_utf8_encoding(self):
        script = Path(__file__).with_name("build-python-env.ps1")
        self.assertTrue(script.read_bytes().startswith(b"\xef\xbb\xbf"))

    def run_fixture(self, source):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "engine with spaces.py"
            script.write_text(source, encoding="utf-8")
            check_server(script)

    def test_sends_exact_utf8_json_and_closes_stdin(self):
        self.run_fixture('''import sys, json
assert sys.argv[1] == "--server"
assert sys.stdin.buffer.read() == b'{"id": 1, "cmd": "ping"}\\n'
print(json.dumps({"id": 1, "ok": True, "pong": True}))
''')

    def test_rejects_wrong_request_id(self):
        with self.assertRaises(RuntimeError):
            self.run_fixture('print(\'{"id": 2, "ok": true, "pong": true}\')')

    def test_rejects_malformed_response(self):
        with self.assertRaises(ValueError):
            self.run_fixture('print("invalid JSON")')

    def test_rejects_failed_engine(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_fixture('raise SystemExit(1)')


if __name__ == "__main__":
    unittest.main()
