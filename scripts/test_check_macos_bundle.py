from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
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
        # macOS exposes /var through /private/var; compare canonical fixture
        # paths with the scanner's resolved paths on every platform.
        self.root = Path(self.temp.name).resolve()

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

    @patch.object(checker, "run")
    def test_preserves_valid_signatures_and_ignores_non_runtime_files(self, run):
        engine = self.write("runtime/bin/python3", macho())
        library = self.write("runtime/lib/python3.12/site-packages/module.so", macho(8))
        self.write("runtime/lib/object.o", macho(1))
        self.write("runtime/lib/script.py", b"pass")
        output = io.StringIO()
        with redirect_stdout(output):
            checker.sign_runtime_tree(self.root / "runtime")
        self.assertEqual([call.args[0] for call in run.call_args_list], [
            ["codesign", "--verify", "--strict", "--verbose=2", str(library)],
            ["codesign", "--verify", "--strict", "--verbose=2", str(engine)],
        ])
        self.assertIn("2 native files, 0 repaired", output.getvalue())

    def test_repairs_unsigned_and_invalid_extension_signatures_then_verifies_them(self):
        library = self.write("runtime/lib/charset_normalizer/cd.cpython-312-darwin.so", macho(8))
        verify = ["codesign", "--verify", "--strict", "--verbose=2", str(library)]
        sign = ["codesign", "--force", "--sign", "-", "--timestamp=none", str(library)]
        for reason in ("code object is not signed at all", "invalid signature"):
            with self.subTest(reason=reason):
                output = io.StringIO()
                with patch.object(checker, "run", side_effect=[
                    subprocess.CalledProcessError(1, verify, output=reason), None, None,
                ]) as run, redirect_stdout(output):
                    checker.sign_runtime_tree(self.root / "runtime")
                self.assertEqual([call.args[0] for call in run.call_args_list], [verify, sign, verify])
                self.assertIn(reason, output.getvalue())
                self.assertIn(str(library), output.getvalue())
                self.assertIn("1 native files, 1 repaired", output.getvalue())

    def test_signing_and_post_sign_verification_failures_stop_the_build(self):
        library = self.write("runtime/module.so", macho(8))
        verify = ["codesign", "--verify", "--strict", "--verbose=2", str(library)]
        unsigned = subprocess.CalledProcessError(1, verify)
        for stage, responses in (
            ("sign", [unsigned, subprocess.CalledProcessError(1, ["codesign", "--sign"])]),
            ("verify", [unsigned, None, subprocess.CalledProcessError(1, verify)]),
        ):
            with self.subTest(stage=stage), patch.object(checker, "run", side_effect=responses) as run:
                with self.assertRaises(subprocess.CalledProcessError) as failure, redirect_stdout(io.StringIO()):
                    checker.sign_runtime_tree(self.root / "runtime")
                self.assertIs(failure.exception, responses[-1])
                self.assertEqual(run.call_count, len(responses))

    @patch.object(checker, "run", side_effect=FileNotFoundError("codesign not installed"))
    def test_codesign_invocation_errors_are_not_treated_as_missing_signatures(self, run):
        self.write("runtime/module.so", macho(8))
        with self.assertRaises(FileNotFoundError):
            checker.sign_runtime_tree(self.root / "runtime")
        self.assertEqual(run.call_count, 1)

    @patch.object(checker, "run")
    def test_runtime_symlink_aliases_are_verified_and_signed_only_once(self, run):
        target = self.write("runtime/bin/python3.12", macho())
        alias = target.with_name("python3")
        try:
            alias.symlink_to(target.name)
        except OSError as error:
            self.skipTest(f"This host cannot create symbolic links: {error}")
        checker.sign_runtime_tree(self.root / "runtime")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-1], str(target))

    @patch.object(checker, "run")
    def test_refuses_to_modify_runtime_symlink_targets_outside_the_source_tree(self, run):
        target = self.write("outside/module.so", macho(8))
        runtime = self.root / "runtime"
        runtime.mkdir()
        try:
            (runtime / "alias.so").symlink_to(target)
        except OSError as error:
            self.skipTest(f"This host cannot create symbolic links: {error}")
        with self.assertRaisesRegex(ValueError, "escapes its resource tree"):
            checker.sign_runtime_tree(runtime)
        run.assert_not_called()

    @patch.object(checker, "run")
    def test_refuses_to_repair_already_packaged_app_resources(self, run):
        library = self.write("Mason.app/Contents/Resources/runtime/module.so", macho(8))
        with self.assertRaisesRegex(ValueError, "before packaging"):
            checker.sign_runtime_tree(library.parent)
        run.assert_not_called()

    @patch.object(checker, "run")
    def test_rejects_empty_or_non_directory_runtime_sources(self, run):
        text = self.write("runtime/script.py", b"pass")
        with self.assertRaisesRegex(ValueError, "No native runtime files"):
            checker.sign_runtime_tree(text.parent)
        with self.assertRaisesRegex(ValueError, "Not a runtime resource directory"):
            checker.sign_runtime_tree(text)
        run.assert_not_called()

    @patch.object(checker, "sign_runtime_tree")
    @patch.object(checker, "verify_app")
    def test_signing_cli_does_not_attempt_to_verify_a_packaged_app(self, verify_app, sign):
        checker.main(["--sign-runtime-tree", str(self.root)])
        sign.assert_called_once_with(self.root)
        verify_app.assert_not_called()

    @patch.object(checker, "sign_runtime_tree")
    def test_cli_keeps_all_original_bundle_verification_inputs_required(self, sign):
        for args in (["--app", "Mason.app"], ["--app", "Mason.app", "--dmg", "Mason.dmg"],
                     ["--app", "Mason.app", "--archive", "Mason.app.tar.gz"],
                     ["--sign-runtime-tree", "runtime", "--app", "Mason.app"],
                     ["--sign-runtime-tree", "runtime", "--dmg", "Mason.dmg"],
                     ["--sign-runtime-tree", "runtime", "--archive", "Mason.app.tar.gz"]):
            with self.subTest(args=args), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as failure:
                checker.main(args)
            self.assertEqual(failure.exception.code, 2)
        sign.assert_not_called()

    @patch.object(checker, "verify_dmg")
    @patch.object(checker, "verify_archive")
    @patch.object(checker, "verify_app")
    def test_original_verification_cli_still_checks_app_archive_and_disk_image(self, app, archive, dmg):
        checker.main(["--app", "Mason.app", "--archive", "Mason.app.tar.gz", "--dmg", "Mason.dmg"])
        app.assert_called_once_with(Path("Mason.app"))
        archive.assert_called_once_with(Path("Mason.app.tar.gz"), "Mason.app")
        dmg.assert_called_once_with(Path("Mason.dmg"), "Mason.app")

    def test_unix_build_signs_only_on_macos_after_all_environment_mutations_and_smoke_checks(self):
        script = Path(__file__).with_name("build-python-env.sh").read_text(encoding="utf-8")
        signing = script.index('python3 -B "$ROOT/scripts/check_macos_bundle.py" --sign-runtime-tree "$DEST"')
        for last_mutation in ('"$PY" -m pip install', 'find "$DEST"', '"$PY" -B -c', '--server'):
            self.assertLess(script.rindex(last_mutation), signing)
        self.assertIn('if [[ "$OS" == Darwin* ]]; then', script[:signing])


if __name__ == "__main__":
    unittest.main()
