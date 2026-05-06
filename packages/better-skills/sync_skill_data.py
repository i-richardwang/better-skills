"""Sync runtime resources from the canonical skill folder into the package.

The CLI starts grader / viewer subprocesses and needs to feed them files
authored in the skill folder (`skills/better-skills/`). The skill folder is
the single source of truth; this script copies just what the CLI reads at
runtime into `scripts/data/` so the wheel can ship them and `pip install`
users don't need the skill folder on disk to run `better-skills`.

Triggered automatically by the setup.py build hooks (`build_py`, `develop`,
`editable_wheel`). Run by hand after editing skill content during a dev loop:

    python packages/better-skills/sync_skill_data.py

The skill folder location is resolved relative to this file, so as long as
the repo layout stays `<root>/{packages,skills}/better-skills/`, this works.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_ROOT.parent.parent
SKILL_SRC = REPO_ROOT / "skills" / "better-skills"
DATA_DST = PACKAGE_ROOT / "scripts" / "data"

# Only the files the CLI reads at runtime. analyzer.md / comparator.md /
# references/ / assets/ stay in the skill folder — they are read by the LLM
# main agent via SKILL.md, not by Python code.
FILES_TO_SYNC = [
    "agents/grader.md",
    "eval-viewer/generate_review.py",
    "eval-viewer/viewer.html",
]


def sync() -> Path:
    # Sdist install path: the published tarball already ships scripts/data/
    # baked in, but skills/better-skills/ was never included (it's a sibling,
    # not part of the package). Treat pre-populated data/ as already-synced
    # and skip — re-running here would wipe what the sdist provided.
    if not SKILL_SRC.exists():
        if all((DATA_DST / rel).exists() for rel in FILES_TO_SYNC):
            return DATA_DST
        raise FileNotFoundError(
            f"skill source not found at {SKILL_SRC} and scripts/data/ is not "
            f"pre-populated. Expected layout: <repo>/skills/better-skills/ "
            f"next to <repo>/packages/better-skills/."
        )

    if DATA_DST.exists():
        shutil.rmtree(DATA_DST)
    DATA_DST.mkdir(parents=True)

    for rel in FILES_TO_SYNC:
        src = SKILL_SRC / rel
        if not src.exists():
            raise FileNotFoundError(f"missing {src}; cannot sync.")
        dst = DATA_DST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    return DATA_DST


if __name__ == "__main__":
    out = sync()
    print(f"synced {len(FILES_TO_SYNC)} files into {out}", file=sys.stderr)
