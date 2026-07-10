"""Regenerate golden.json from the scripts/ directory.

Run only when a harness change is *intended* to alter output:
    python py-tests/golden/generate.py
Commit the diff together with the change that justifies it.
"""
import json
import pathlib
import sys

GOLDEN_DIR = pathlib.Path(__file__).parent
sys.path.insert(0, str(GOLDEN_DIR.parent.parent / "packages/client/public/py"))
import harness


def snapshot(source: str) -> dict:
    out = harness.run_script(source)
    return {
        "measurements": out["measurements"],
        "stdout": out["stdout"],
        "positionCount": len(out["positions"]),
        "indexCount": len(out["indices"]),
        "params": harness.parse_params(source),
    }


def main() -> None:
    golden = {
        path.stem: snapshot(path.read_text())
        for path in sorted((GOLDEN_DIR / "scripts").glob("*.py"))
    }
    out_path = GOLDEN_DIR / "golden.json"
    out_path.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out_path} ({len(golden)} scripts)")


if __name__ == "__main__":
    main()
