#!/usr/bin/env python3
"""
Skill Packager - Creates a distributable .skill file of a skill folder.

Invoked via the `better-skills package <skill-path> [--output-dir DIR]` CLI.
Progress lines go to stderr so the CLI wrapper can keep stdout reserved for
its structured JSON result.
"""

import fnmatch
import sys
import zipfile
from pathlib import Path
from .quick_validate import validate_skill


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)

# Patterns to exclude when packaging skills.
EXCLUDE_DIRS = {"__pycache__", "node_modules"}
EXCLUDE_GLOBS = {"*.pyc"}
EXCLUDE_FILES = {".DS_Store"}
# Directories excluded only at the skill root (not when nested deeper).
ROOT_EXCLUDE_DIRS = {"evals"}


def should_exclude(rel_path: Path) -> bool:
    """Check if a path should be excluded from packaging."""
    parts = rel_path.parts
    if any(part in EXCLUDE_DIRS for part in parts):
        return True
    # rel_path is relative to skill_path.parent, so parts[0] is the skill
    # folder name and parts[1] (if present) is the first subdir.
    if len(parts) > 1 and parts[1] in ROOT_EXCLUDE_DIRS:
        return True
    name = rel_path.name
    if name in EXCLUDE_FILES:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_GLOBS)


def package_skill(skill_path, output_dir=None):
    """
    Package a skill folder into a .skill file.

    Args:
        skill_path: Path to the skill folder
        output_dir: Optional output directory for the .skill file (defaults to current directory)

    Returns:
        Path to the created .skill file, or None if error
    """
    skill_path = Path(skill_path).resolve()

    # Validate skill folder exists
    if not skill_path.exists():
        _log(f"❌ Error: Skill folder not found: {skill_path}")
        return None

    if not skill_path.is_dir():
        _log(f"❌ Error: Path is not a directory: {skill_path}")
        return None

    # Validate SKILL.md exists
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        _log(f"❌ Error: SKILL.md not found in {skill_path}")
        return None

    # Run validation before packaging
    _log("🔍 Validating skill...")
    valid, message = validate_skill(skill_path)
    if not valid:
        _log(f"❌ Validation failed: {message}")
        _log("   Please fix the validation errors before packaging.")
        return None
    _log(f"✅ {message}\n")

    # Determine output location
    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"

    # Create the .skill file (zip format)
    try:
        with zipfile.ZipFile(skill_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Walk through the skill directory, excluding build artifacts
            for file_path in skill_path.rglob('*'):
                if not file_path.is_file():
                    continue
                arcname = file_path.relative_to(skill_path.parent)
                if should_exclude(arcname):
                    _log(f"  Skipped: {arcname}")
                    continue
                zipf.write(file_path, arcname)
                _log(f"  Added: {arcname}")

        _log(f"\n✅ Successfully packaged skill to: {skill_filename}")
        return skill_filename

    except Exception as e:
        _log(f"❌ Error creating .skill file: {e}")
        return None


