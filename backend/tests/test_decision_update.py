"""Field-contract tests for the shared ``DecisionUpdate`` input model."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from backend.models import DecisionUpdate


def build_valid_decision_update_input(**updates: object) -> dict[str, Any]:
    """Build the smallest valid DecisionUpdate input for field validation tests."""

    payload: dict[str, Any] = {"decision": "adopted"}
    payload.update(updates)
    return payload


@pytest.mark.parametrize(
    ("raw_value", "normalized_value"),
    [
        (None, None),
        ("", ""),
        (" \u00a0\u2003\u3000 ", ""),
        ("\u00a0\u3000  Keep this note  \u2003", "Keep this note"),
        (f"\u3000{'n' * 2000}\u00a0", "n" * 2000),
    ],
    ids=(
        "note-null-preserved",
        "note-empty-explicit-clear",
        "note-unicode-blank-to-empty",
        "note-unicode-strip",
        "note-trimmed-2000",
    ),
)
def test_decision_update_normalizes_note_before_length_validation(
    raw_value: object,
    normalized_value: str | None,
):
    decision_update = DecisionUpdate.model_validate(
        build_valid_decision_update_input(note=raw_value)
    )

    assert decision_update.note == normalized_value


def test_decision_update_omitted_note_stays_not_updated():
    decision_update = DecisionUpdate.model_validate(build_valid_decision_update_input())

    assert decision_update.note is None


def test_decision_update_rejects_trimmed_2001_note_at_its_field():
    with pytest.raises(ValidationError) as validation_error:
        DecisionUpdate.model_validate(
            build_valid_decision_update_input(note=f"\u3000{'n' * 2001}\u00a0")
        )

    assert [error["loc"] for error in validation_error.value.errors()] == [("note",)]
    assert validation_error.value.errors()[0]["type"] == "string_too_long"


@pytest.mark.parametrize(
    "wrong_type_value",
    [123, ["not", "a", "string"]],
)
def test_decision_update_leaves_wrong_note_types_to_standard_validation(
    wrong_type_value: object,
):
    with pytest.raises(ValidationError) as validation_error:
        DecisionUpdate.model_validate(
            build_valid_decision_update_input(note=wrong_type_value)
        )

    assert validation_error.value.errors()[0]["loc"] == ("note",)
    assert validation_error.value.errors()[0]["type"] == "string_type"


def test_decision_update_json_schema_exposes_nullable_note():
    properties = DecisionUpdate.model_json_schema()["properties"]

    assert properties["note"]["default"] is None
    assert properties["note"]["anyOf"] == [
        {"maxLength": 2000, "type": "string"},
        {"type": "null"},
    ]
