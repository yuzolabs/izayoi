"""Tests for the top-level ``izayoi --version`` / ``-V`` contract."""

from __future__ import annotations

import importlib.metadata
import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from backend import cli_version


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _izayoi_console_script_path() -> Path:
    """Return the venv ``izayoi`` console script next to the test interpreter."""

    # Do not Path.resolve() sys.executable: uv venvs symlink python to a shared
    # interpreter whose bin directory has no console scripts.
    for candidate in (
        Path(sys.executable).parent / "izayoi",
        Path(sys.prefix) / "bin" / "izayoi",
    ):
        if candidate.is_file():
            return candidate
    pytest.skip("izayoi console script is not installed next to sys.executable")


def _source_tree_cli_environment(working_directory: Path) -> dict[str, str]:
    """Build an env that can import the checkout without creating a database."""

    environment = os.environ.copy()
    environment.pop("IZAYOI_DB_PATH", None)
    existing_python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        path for path in (str(PROJECT_ROOT), existing_python_path) if path
    )
    environment["TMPDIR"] = str(working_directory)
    environment["TMP"] = str(working_directory)
    environment["TEMP"] = str(working_directory)
    return environment


def _run_izayoi_cli(
    arguments: list[str],
    *,
    entrypoint: str,
    working_directory: Path,
) -> subprocess.CompletedProcess[str]:
    """Run the CLI through the console script or ``python -m backend.cli``."""

    environment = _source_tree_cli_environment(working_directory)
    if entrypoint == "console":
        command = [str(_izayoi_console_script_path()), *arguments]
    elif entrypoint == "module":
        command = [sys.executable, "-m", "backend.cli", *arguments]
    else:
        raise AssertionError(f"unknown CLI entrypoint: {entrypoint}")

    return subprocess.run(
        command,
        cwd=working_directory,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )


def _expected_izayoi_cli_version_line() -> str:
    """Expected stdout line from installed distribution metadata."""

    return f"izayoi {importlib.metadata.version('izayoi')}"


def _snapshot_directory_paths(root: Path) -> set[str]:
    return {str(path.relative_to(root)) for path in root.rglob("*")}


@pytest.mark.parametrize("flag", ["--version", "-V"])
@pytest.mark.parametrize("entrypoint", ["console", "module"])
def test_izayoi_version_flag_prints_single_metadata_line(
    flag,
    entrypoint,
    tmp_path,
):
    paths_before = _snapshot_directory_paths(tmp_path)

    completed = _run_izayoi_cli([flag], entrypoint=entrypoint, working_directory=tmp_path)

    expected_line = _expected_izayoi_cli_version_line()
    assert completed.returncode == 0
    assert completed.stderr == ""
    assert completed.stdout == f"{expected_line}\n"
    assert completed.stdout.startswith("izayoi ")
    assert completed.stdout.count("\n") == 1
    assert _snapshot_directory_paths(tmp_path) == paths_before
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("entrypoint", ["console", "module"])
def test_izayoi_version_before_subcommand_is_harmless(entrypoint, tmp_path):
    completed = _run_izayoi_cli(
        ["--version", "run", "--theme", "Should not start"],
        entrypoint=entrypoint,
        working_directory=tmp_path,
    )

    assert completed.returncode == 0
    assert completed.stdout == f"{_expected_izayoi_cli_version_line()}\n"
    assert completed.stderr == ""
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("entrypoint", ["console", "module"])
@pytest.mark.parametrize(
    "arguments",
    [
        ["run", "--theme", "Should not start", "--version"],
        ["export", "abcabcabcabc", "--version"],
    ],
    ids=("run", "export"),
)
def test_izayoi_version_after_subcommand_is_usage_error(
    entrypoint,
    arguments,
    tmp_path,
):
    completed = _run_izayoi_cli(
        arguments,
        entrypoint=entrypoint,
        working_directory=tmp_path,
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "unrecognized arguments: --version" in completed.stderr
    assert "Traceback" not in completed.stderr
    assert list(tmp_path.iterdir()) == []


def test_installed_distribution_version_matches_pyproject():
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert importlib.metadata.version("izayoi") == project["project"]["version"]
    assert cli_version.read_izayoi_distribution_version() == project["project"]["version"]
    assert (
        cli_version.read_izayoi_version_from_source_pyproject()
        == project["project"]["version"]
    )
    assert cli_version.format_izayoi_cli_version_line() == (
        f"izayoi {project['project']['version']}"
    )


def test_read_izayoi_distribution_version_falls_back_to_source_pyproject(monkeypatch):
    def raise_package_not_found(_distribution_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(_distribution_name)

    monkeypatch.setattr(cli_version.importlib.metadata, "version", raise_package_not_found)
    project = tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert (
        cli_version.read_izayoi_distribution_version() == project["project"]["version"]
    )


def test_read_izayoi_distribution_version_raises_when_both_sources_missing(monkeypatch):
    def raise_package_not_found(_distribution_name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(_distribution_name)

    def raise_missing_pyproject() -> str:
        raise FileNotFoundError("pyproject.toml")

    monkeypatch.setattr(cli_version.importlib.metadata, "version", raise_package_not_found)
    monkeypatch.setattr(
        cli_version,
        "read_izayoi_version_from_source_pyproject",
        raise_missing_pyproject,
    )

    with pytest.raises(
        cli_version.IzayoiDistributionVersionUnavailable,
        match="izayoi distribution version is unavailable",
    ):
        cli_version.read_izayoi_distribution_version()
