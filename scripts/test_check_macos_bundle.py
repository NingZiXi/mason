from pathlib import Path
import io
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import check_macos_bundle as checker


def macho(file_type=2):
    return b"\xcf\xfa\xed\xfe" + struct.pack("<III", 0, 0, file_type)


class MacOSBundleCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_identifies_native_runtime_but_not_objects_or_data(self):
        for file_type in (2, 6, 7, 8):
            self.assertTrue(checker.is_native_runtime(self.write(f"native-{file_type}", macho(file_type))))
        self.assertFalse(checker.is_native_runtime(self.write("object.o", macho(1))))
        self.assertFalse(checker.is_native_runtime(self.write("script.py", b"print('hello world')\n")))
        self.assertFalse(checker.is_native_runtime(self.write("short", b"\xcf\xfa\xed\xfe")))

    def test_identifies_universal_runtime(self):
        offset = 64
        header = b"\xca\xfe\xba\xbe" + struct.pack(">I", 1)
        entry = struct.pack(">IIIII", 0, 0, offset, 16, 0)
        path = self.write("universal", (header + entry).ljust(offset, b"\0") + macho(6))
        self.assertTrue(checker.is_native_runtime(path))
        self.assertFalse(checker.is_native_runtime(self.write("malformed", header)))

    @patch.object(checker, "run")
    def test_checks_nested_python_and_libraries_in_resources(self, run):
        app = self.root / "Mason.app"
        self.write("Mason.app/Contents/Info.plist", b"plist")
        engine = self.write("Mason.app/Contents/Resources/python/bin/python3", macho())
        library = self.write("Mason.app/Contents/Resources/python/lib/module.so", macho(8))
        self.write("Mason.app/Contents/Resources/python/lib/script.py", b"pass")
        checker.verify_app(app)
        self.assertEqual(run.call_args_list[0].args[0],
                         ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
        checked = {call.args[0][-1] for call in run.call_args_list[1:]}
        self.assertEqual(checked, {str(engine), str(library)})

    def test_rejects_missing_app(self):
        with self.assertRaises(ValueError):
            checker.verify_app(self.root / "Mason.app")

    @patch.object(checker, "verify_app", side_effect=ValueError("invalid signature"))
    @patch.object(checker, "run")
    def test_unmounts_disk_image_even_when_app_verification_fails(self, run, verify_app):
        dmg = self.write("Mason.dmg", b"image")
        with self.assertRaisesRegex(ValueError, "invalid signature"):
            checker.verify_dmg(dmg, "Mason.app")
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0], ["hdiutil", "verify", str(dmg)])
        self.assertEqual(commands[1][:5], ["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen"])
        self.assertEqual(commands[-1][:2], ["hdiutil", "detach"])

    @patch.object(checker, "run", side_effect=[None, subprocess.CalledProcessError(1, ["hdiutil", "attach"])])
    def test_does_not_detach_unmounted_image(self, run):
        dmg = self.write("Mason.dmg", b"image")
        with self.assertRaises(subprocess.CalledProcessError):
            checker.verify_dmg(dmg, "Mason.app")
        self.assertEqual(run.call_count, 2)

    @patch.object(checker, "verify_app")
    def test_checks_extracted_updater_archive(self, verify_app):
        self.write("Mason.app/Contents/Info.plist", b"plist")
        archive = self.root / "Mason.app.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(self.root / "Mason.app", arcname="Mason.app")
        checker.verify_archive(archive, "Mason.app")
        self.assertEqual(verify_app.call_count, 1)
        self.assertEqual(verify_app.call_args.args[0].name, "Mason.app")

    def test_rejects_updater_archive_path_traversal(self):
        archive = self.root / "Mason.app.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            entry = tarfile.TarInfo("../outside")
            entry.size = 1
            bundle.addfile(entry, io.BytesIO(b"x"))
        with self.assertRaises(tarfile.OutsideDestinationError):
            checker.verify_archive(archive, "Mason.app")


if __name__ == "__main__":
    unittest.main()
