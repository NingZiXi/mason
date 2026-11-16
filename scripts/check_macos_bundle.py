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


def verify_app(app: Path) -> None:
    if not (app / "Contents/Info.plist").is_file():
        raise ValueError(f"Not a macOS application bundle: {app}")
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
    # Resources are sealed as data by the outer app signature. Verify each native
    # dependency too: --deep alone need not inspect code stored in Resources.
    resources = app / "Contents/Resources"
    checked = set()
    for path in sorted(resources.rglob("*")):
        if not path.is_file():
            continue
        resolved = path.resolve(strict=True)
        if resolved in checked:
            continue
        checked.add(resolved)
        if is_native_runtime(path):
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--dmg", required=True, nargs="+", type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    args = parser.parse_args()
    verify_app(args.app)
    verify_archive(args.archive, args.app.name)
    for dmg in args.dmg:
        verify_dmg(dmg, args.app.name)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"macOS bundle verification failed: {error.cmd}\n{error.stdout or ''}")
