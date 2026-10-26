"""Verify the bundled engine's real JSON protocol without shell pipe encoding."""
import json
from pathlib import Path
import subprocess
import sys


def check_server(script: Path) -> None:
    request = json.dumps({"id": 1, "cmd": "ping"}).encode("utf-8") + b"\n"
    result = subprocess.run(
        [sys.executable, str(script), "--server"],
        input=request,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=True,
    )
    response = json.loads(result.stdout)
    if response != {"id": 1, "ok": True, "pong": True}:
        raise RuntimeError(f"Unexpected ping response: {response!r}")
    print("server ping OK")


if __name__ == "__main__":
    try:
        check_server(Path(sys.argv[1]).resolve(strict=True))
    except Exception as error:
        print(f"Server smoke check failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr.decode("utf-8", errors="replace"), file=sys.stderr)
        sys.exit(1)
