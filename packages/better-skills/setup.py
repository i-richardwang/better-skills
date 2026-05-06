"""Build hook that syncs skill content into scripts/data/ before packaging.

Most of the package metadata lives in pyproject.toml — this file exists only
to override `build_py`, `develop`, and `editable_wheel` so the canonical skill
folder content is copied into the package each time pip installs or builds a
wheel. Run sync_skill_data.py directly for ad-hoc resync during a dev loop.

The sync logic is intentionally inlined here (and duplicated in
sync_skill_data.py) rather than imported, because PEP 517 isolated builds exec
this file via setuptools.build_meta with __file__ unset, which makes any
relative import attempts fragile. Path.cwd() is the project root when
setuptools runs setup.py.
"""

import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py
from setuptools.command.develop import develop

try:
    from setuptools.command.editable_wheel import editable_wheel
except ImportError:  # very old setuptools
    editable_wheel = None  # type: ignore[assignment]


_PACKAGE_ROOT = Path.cwd()
_REPO_ROOT = _PACKAGE_ROOT.parent.parent
_SKILL_SRC = _REPO_ROOT / "skills" / "better-skills"
_DATA_DST = _PACKAGE_ROOT / "scripts" / "data"

# Mirror of FILES_TO_SYNC in sync_skill_data.py — keep the two lists aligned.
_FILES_TO_SYNC = [
    "agents/grader.md",
    "eval-viewer/generate_review.py",
    "eval-viewer/viewer.html",
]


def _sync_skill_data() -> None:
    if not _SKILL_SRC.exists():
        if all((_DATA_DST / rel).exists() for rel in _FILES_TO_SYNC):
            return
        raise FileNotFoundError(
            f"skill source not found at {_SKILL_SRC} and scripts/data/ is not "
            f"pre-populated. Expected layout: <repo>/skills/better-skills/ "
            f"next to <repo>/packages/better-skills/."
        )

    if _DATA_DST.exists():
        shutil.rmtree(_DATA_DST)
    _DATA_DST.mkdir(parents=True)

    for rel in _FILES_TO_SYNC:
        src = _SKILL_SRC / rel
        if not src.exists():
            raise FileNotFoundError(f"missing {src}; cannot sync.")
        dst = _DATA_DST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


class BuildPyWithSync(build_py):
    def run(self):
        _sync_skill_data()
        super().run()


class DevelopWithSync(develop):
    def run(self):
        _sync_skill_data()
        super().run()


cmdclass: dict = {
    "build_py": BuildPyWithSync,
    "develop": DevelopWithSync,
}

if editable_wheel is not None:
    class EditableWheelWithSync(editable_wheel):  # type: ignore[misc, valid-type]
        def run(self):
            _sync_skill_data()
            super().run()

    cmdclass["editable_wheel"] = EditableWheelWithSync


setup(cmdclass=cmdclass)
