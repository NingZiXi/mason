"""Verify the shipped macOS app and its embedded native engine, without launching it.

This checks signature integrity, not Gatekeeper approval or notarization. Ad-hoc
signed builds still require the user to allow the app in macOS security settings.
"""
import argparse
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
from typing import Iterator


MACHO_ENDIAN = {b"\xce\xfa\xed\xfe": "<", b"\xcf\xfa\xed\xfe": "<",
                b"\xfe\xed\xfa\xce": ">", b"\xfe\xed\xfa\xcf": ">"}
FAT_ENDIAN = {b"\xca\xfe\xba\xbe": (">", False), b"\xbe\xba\xfe\xca": ("<", False),
              b"\xca\xfe\xba\xbf": (">", True), b"\xbf\xba\xfe\xca": ("<", True)}
# Relocatable object files and static archives do not need executable signatures.
RUNTIME_TYPES = {2, 6, 7, 8}  # execute, dylib, dynamic linker, bundle


def is_native_runtime(path: Path) -> bool:
    with path.open("rb") as stream:
        header = stream.read(16)
        if len(header) < 16:
            return False
        endian = MACHO_ENDIAN.get(header[:4])
        if endian:
            return struct.unpack_from(endian + "I", header, 12)[0] in RUNTIME_TYPES
        fat = FAT_ENDIAN.get(header[:4])
        if not fat:
            return False
        endian, is_64 = fat
        count = struct.unpack_from(endian + "I", header, 4)[0]
        # Reject malformed headers, including Java class files sharing FAT magic.
        if not 1 <= count <= 64:
            return False
        entry_size = 32 if is_64 else 20
        stream.seek(8)
        entries = stream.read(count * entry_size)
        if len(entries) != count * entry_size:
            return False
        for index in range(count):
            offset = struct.unpack_from(endian + ("Q" if is_64 else "I"),
                                        entries, index * entry_size + 8)[0]
            stream.seek(offset)
            member = stream.read(16)
            member_endian = MACHO_ENDIAN.get(member[:4])
            if len(member) == 16 and member_endian:
                if struct.unpack_from(member_endian + "I", member, 12)[0] in RUNTIME_TYPES:
                    return True
        return False


def run(command: list[str]) -> None:
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=True)
    if result.stdout.strip():
        print(result.stdout.strip())


def native_runtimes(root: Path) -> Iterator[Path]:
    """Visit real files once; never follow a runtime alias outside the tree."""
    resolved_root = root.resolve(strict=True)
    checked = set()
    # Sign nested code before shallower executables; the outer .app signature is
    # created later by Tauri, after this source resource tree is complete.
    for path in sorted(root.rglob("*"), key=lambda entry: (-len(entry.parts), str(entry))):
        if not path.is_file():
            continue
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(resolved_root):
            raise ValueError(f"Runtime alias escapes its resource tree: {path}")
        if resolved in checked:
            continue
        checked.add(resolved)
        if is_native_runtime(resolved):
            yield resolved


def sign_runtime_tree(root: Path) -> None:
    """Repair unsigned/invalid native dependencies before the app is sealed.

    Preserve valid upstream signatures. Sign each raw Mach-O individually;
    codesign --deep is deliberately not used for signing nested code.
    """
    resolved = root.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError(f"Not a runtime resource directory: {root}")
    if any(path.suffix.lower() == ".app" for path in (resolved, *resolved.parents)):
        raise ValueError("Sign the source runtime tree before packaging the .app")
    checked = repaired = 0
    for path in native_runtimes(resolved):
        verify = ["codesign", "--verify", "--strict", "--verbose=2", str(path)]
        try:
            run(verify)
        except subprocess.CalledProcessError as error:
            print(f"Repairing native runtime signature: {path}")
            if error.stdout:
                print(error.stdout.strip())
            run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(path)])
            run(verify)
            repaired += 1
        checked += 1
    if not checked:
        raise ValueError(f"No native runtime files found: {root}")
    print(f"Runtime signature integrity OK: {checked} native files, {repaired} repaired")


def verify_app(app: Path) -> None:
    if not (app / "Contents/Info.plist").is_file():
        raise ValueError(f"Not a macOS application bundle: {app}")
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
    # Resources are sealed as data by the outer app signature. Verify each native
    # dependency too: --deep alone need not inspect code stored in Resources.
    for path in native_runtimes(app / "Contents/Resources"):
        run(["codesign", "--verify", "--strict", "--verbose=2", str(path)])
    print(f"Signature integrity OK: {app}")


def verify_dmg(dmg: Path, app_name: str) -> None:
    if not dmg.is_file():
        raise ValueError(f"Missing disk image: {dmg}")
    run(["hdiutil", "verify", str(dmg)])
    with tempfile.TemporaryDirectory(prefix="mason-dmg-check-") as temp:
        mountpoint = Path(temp) / "mounted"
        mountpoint.mkdir()
        mounted = False
        try:
            run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen",
                 "-mountpoint", str(mountpoint), str(dmg)])
            mounted = True
            verify_app(mountpoint / app_name)
        finally:
            if mounted:
                run(["hdiutil", "detach", str(mountpoint)])


def verify_archive(archive: Path, app_name: str) -> None:
    with tempfile.TemporaryDirectory(prefix="mason-updater-check-") as temp:
        with tarfile.open(archive, "r:gz") as bundle:
            bundle.extractall(temp, filter="data")
        entries = list(Path(temp).iterdir())
        if len(entries) != 1 or entries[0].name != app_name:
            raise ValueError(f"Unexpected updater archive contents: {archive}")
        verify_app(entries[0])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--app", type=Path)
    mode.add_argument("--sign-runtime-tree", type=Path,
                      help="Repair native signatures in the source runtime, before app packaging")
    parser.add_argument("--dmg", nargs="+", type=Path)
    parser.add_argument("--archive", type=Path)
    args = parser.parse_args(argv)
    if args.sign_runtime_tree is not None:
        if args.dmg or args.archive:
            parser.error("--sign-runtime-tree cannot be combined with bundle verification options")
        sign_runtime_tree(args.sign_runtime_tree)
        return
    if not args.dmg or args.archive is None:
        parser.error("--app requires both --archive and --dmg")
    verify_app(args.app)
    verify_archive(args.archive, args.app.name)
    for dmg in args.dmg:
        verify_dmg(dmg, args.app.name)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"macOS bundle signature operation failed: {error.cmd}\n{error.stdout or ''}")
