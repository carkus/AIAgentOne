"""Turn the Unreleased changes into a numbered release.

frontend/src/releaseNotes.json has an "unreleased" list. Each change made
since the last deploy is added there as it's made, tagged with its kind:

    {"kind": "fix" | "feature" | "breaking", "title": "...", "text": "..."}

On deploy (deploy/redeploy.sh frontend|all) this script works out the next
version from the highest kind present, so nobody picks a number:

    breaking -> major (but below 1.0, minor: 1.0 is a deliberate release)
    feature  -> minor
    fix      -> patch

It then writes that version into frontend/package.json and package-lock.json,
moves the changes into a new first entry of "releases" (dated today) and
empties "unreleased". With no unreleased changes it does nothing.

    python tools/release-notes/release.py            # release, if there's anything to release
    python tools/release-notes/release.py --dry-run  # show what would happen, change nothing
    python tools/release-notes/release.py --major    # the deliberate 1.0 (or next major)

See CLAUDE.md, Versioning.
"""
import argparse
import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
NOTES = ROOT / "frontend/src/releaseNotes.json"
PKG = ROOT / "frontend/package.json"
LOCK = ROOT / "frontend/package-lock.json"

KINDS = ("fix", "feature", "breaking")
GROUPS = [("breaking", "Breaking changes"), ("feature", "New"), ("fix", "Fixes")]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def next_version(current, kinds, major):
    ma, mi, pa = (int(x) for x in current.split("."))
    if major:
        return f"{ma + 1}.0.0"
    if "breaking" in kinds and ma >= 1:
        return f"{ma + 1}.0.0"
    if "breaking" in kinds or "feature" in kinds:
        return f"{ma}.{mi + 1}.0"
    return f"{ma}.{mi}.{pa + 1}"


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "es" if word.endswith("x") else "s")


def main():
    ap = argparse.ArgumentParser(description="Release the Unreleased changes.")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing")
    ap.add_argument("--major", action="store_true", help="make this a major release (e.g. the 1.0)")
    args = ap.parse_args()

    notes = read(NOTES)
    changes = notes.get("unreleased") or []
    if not changes:
        print("release: no unreleased changes, version stays", read(PKG)["version"])
        return
    bad = [c.get("title", "?") for c in changes if c.get("kind") not in KINDS]
    if bad:
        sys.exit("release: these changes need a kind of fix/feature/breaking: " + "; ".join(bad))

    pkg = read(PKG)
    current = pkg["version"]
    kinds = {c["kind"] for c in changes}
    version = next_version(current, kinds, args.major)
    today = datetime.date.today()
    counts = [plural(sum(c["kind"] == k for c in changes), w)
              for k, w in (("breaking", "breaking change"), ("feature", "new feature"), ("fix", "fix"))
              if k in kinds]
    release = {
        "version": version,
        "date": f"{today.day} {today:%B %Y}",
        "title": ", ".join(counts),
        "groups": [
            {"title": label, "fixes": [{k: v for k, v in c.items() if k != "kind"}
                                       for c in changes if c["kind"] == kind]}
            for kind, label in GROUPS if kind in kinds
        ],
    }
    print(f"release: {current} -> {version} ({release['title']})")
    if args.dry_run:
        return

    pkg["version"] = version
    write(PKG, pkg)
    lock = read(LOCK)
    lock["version"] = version
    lock["packages"][""]["version"] = version
    write(LOCK, lock)
    notes["releases"].insert(0, release)
    notes["unreleased"] = []
    write(NOTES, notes)
    print(f"release: wrote v{version} to package.json, package-lock.json and releaseNotes.json")


if __name__ == "__main__":
    main()
