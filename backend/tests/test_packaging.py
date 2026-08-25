"""Packaging regression tests for wheel-installed runtime dependencies."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
REQUIRED_RUNTIME_DISTRIBUTIONS = {
    "fastapi",
    "litellm",
    "numpy",
    "pydantic",
    "uvicorn",
}
REQUIREMENT_DISTRIBUTION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*")


def test_setuptools_wheel_uses_runtime_requirements_file():
    project_config = tomllib.loads(
        (PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )
    project_metadata = project_config["project"]

    assert "dependencies" not in project_metadata, (
        "Packaging dependency source mismatch: do not duplicate runtime requirements "
        "in project.dependencies"
    )
    assert "dependencies" in project_metadata.get("dynamic", []), (
        "Packaging dependency source mismatch: project.dependencies must be dynamic"
    )

    dependency_files = project_config["tool"]["setuptools"]["dynamic"]["dependencies"]["file"]
    assert dependency_files == ["requirements.txt"], (
        "Packaging dependency source mismatch: setuptools wheels must read requirements.txt"
    )

    runtime_requirement_lines = [
        line.strip()
        for line in (PROJECT_ROOT / dependency_files[0])
        .read_text(encoding="utf-8")
        .splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    declared_runtime_distributions = {
        requirement_match.group(0).lower()
        for line in runtime_requirement_lines
        if (requirement_match := REQUIREMENT_DISTRIBUTION_PATTERN.match(line)) is not None
    }
    missing_runtime_distributions = (
        REQUIRED_RUNTIME_DISTRIBUTIONS - declared_runtime_distributions
    )

    assert not missing_runtime_distributions, (
        "Packaging runtime dependencies missing from requirements.txt: "
        f"{sorted(missing_runtime_distributions)}"
    )
