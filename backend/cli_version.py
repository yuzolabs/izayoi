"""Resolve the izayoi CLI version string from distribution metadata."""

from __future__ import annotations

import argparse
import importlib.metadata
import sys
import tomllib
from collections.abc import Sequence
from pathlib import Path

IZAYOI_DISTRIBUTION_NAME = "izayoi"
IZAYOI_CLI_VERSION_LINE_PREFIX = "izayoi "
SOURCE_CHECKOUT_PYPROJECT_TOML_NAME = "pyproject.toml"


class IzayoiDistributionVersionUnavailable(RuntimeError):
    """Raised when neither installed metadata nor source pyproject.toml has a version."""


def read_izayoi_distribution_version() -> str:
    """Return the izayoi distribution version from package metadata.

    Installed wheels and editable installs use ``importlib.metadata.version``.
    A source checkout that is not installed falls back to ``project.version``
    in the adjacent ``pyproject.toml`` so the printed line still matches the
    checkout metadata. The version number is never hardcoded here.
    """

    try:
        return importlib.metadata.version(IZAYOI_DISTRIBUTION_NAME)
    except importlib.metadata.PackageNotFoundError:
        try:
            return read_izayoi_version_from_source_pyproject()
        except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError) as exc:
            raise IzayoiDistributionVersionUnavailable(
                "izayoi distribution version is unavailable; install the package "
                "or keep pyproject.toml next to the backend package"
            ) from exc


def read_izayoi_version_from_source_pyproject() -> str:
    """Read ``project.version`` from the source checkout ``pyproject.toml``.

    This is the uninstalled-checkout fallback used when the izayoi
    distribution is not on ``importlib.metadata``.
    """

    pyproject_path = (
        Path(__file__).resolve().parents[1] / SOURCE_CHECKOUT_PYPROJECT_TOML_NAME
    )
    with pyproject_path.open("rb") as pyproject_file:
        project_data = tomllib.load(pyproject_file)
    version = project_data["project"]["version"]
    if not isinstance(version, str) or not version:
        raise IzayoiDistributionVersionUnavailable(
            "izayoi distribution version is unavailable; pyproject.toml "
            "project.version must be a non-empty string"
        )
    return version


def format_izayoi_cli_version_line() -> str:
    """Format the single-line CLI version display as ``izayoi <version>``."""

    return f"{IZAYOI_CLI_VERSION_LINE_PREFIX}{read_izayoi_distribution_version()}"


class PrintIzayoiCliVersionAction(argparse.Action):
    """Print the izayoi CLI version line to stdout and exit.

    Top-level only: ``izayoi --version`` and ``izayoi -V``. Not accepted after
    ``run`` or ``export``.
    """

    def __init__(
        self,
        option_strings: Sequence[str],
        dest: str,
        default: object = argparse.SUPPRESS,
        help: str | None = None,
    ) -> None:
        super().__init__(
            option_strings=option_strings,
            dest=dest,
            nargs=0,
            default=default,
            help=help,
        )

    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        option_string: str | None = None,
    ) -> None:
        try:
            version_line = format_izayoi_cli_version_line()
        except IzayoiDistributionVersionUnavailable as exc:
            parser.exit(status=1, message=f"izayoi: error: {exc}\n")
        sys.stdout.write(f"{version_line}\n")
        parser.exit(status=0)
