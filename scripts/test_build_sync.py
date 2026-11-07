"""Exercise the real build.rs sync without loading Tauri's build dependencies."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("rustc"), "Rust compiler is required")
class BuildSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compilation = tempfile.TemporaryDirectory(prefix="mason-build-sync-")
        cls.addClassCleanup(cls.compilation.cleanup)
        directory = Path(cls.compilation.name)
        source = Path(__file__).resolve().parents[1] / "src-tauri" / "build.rs"
        wrapper = directory / "sync.rs"
        wrapper.write_text('mod tauri_build { pub fn build() {} }\n'
                           f'include!(r#"{source.as_posix()}"#);\n', encoding="utf-8")
        cls.binary = directory / ("sync.exe" if os.name == "nt" else "sync")
        subprocess.run(["rustc", "--edition=2021", str(wrapper), "-o", str(cls.binary)], check=True)

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="mason sync fixture ")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.crate = root / "src-tauri"
        self.crate.mkdir()
        self.source = root / "python" / "jig_generator.py"
        self.source.parent.mkdir()
        self.source.write_bytes(b"# current engine\n")
        self.destination = self.crate / "resources" / "scripts" / "jig_generator.py"

    def run_sync(self):
        return subprocess.run([str(self.binary)], capture_output=True, text=True, encoding="utf-8",
                              env={**os.environ, "CARGO_MANIFEST_DIR": str(self.crate)})

    def test_watches_external_source_and_copies_latest_engine(self):
        result = self.run_sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"cargo:rerun-if-changed={self.source}", result.stdout)
        self.assertEqual(self.source.read_bytes(), self.destination.read_bytes())
        self.source.write_bytes(b"# changed engine\n")
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.source.read_bytes(), self.destination.read_bytes())

    def test_unchanged_engine_does_not_rewrite_resource(self):
        self.assertEqual(self.run_sync().returncode, 0)
        os.utime(self.destination, (1000000000, 1000000000))
        timestamp = self.destination.stat().st_mtime_ns
        self.assertEqual(self.run_sync().returncode, 0)
        self.assertEqual(self.destination.stat().st_mtime_ns, timestamp)

    def test_missing_source_stops_the_build(self):
        self.source.unlink()
        self.assertNotEqual(self.run_sync().returncode, 0)

    def test_failed_write_stops_the_build(self):
        self.destination.mkdir(parents=True)
        self.assertNotEqual(self.run_sync().returncode, 0)

    def test_failed_directory_creation_stops_the_build(self):
        (self.crate / "resources").write_bytes(b"not a directory")
        self.assertNotEqual(self.run_sync().returncode, 0)


if __name__ == "__main__":
    unittest.main()
