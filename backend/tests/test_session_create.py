"""Field-contract tests for the shared ``SessionCreate`` input model."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from backend.models import SessionCreate


def build_valid_session_create_input(**updates: object) -> dict[str, Any]:
    """Build the smallest valid SessionCreate input for field validation tests."""

    payload: dict[str, Any] = {
        "theme": "A valid theme",
        "agents": [
            {"persona_type": "INTJ", "provider": "mock", "model": "mock"},
            {"persona_type": "ENFP", "provider": "mock", "model": "mock"},
        ],
        "facilitator": {"provider": "mock", "model": "mock"},
    }
    payload.update(updates)
    return payload


@pytest.mark.parametrize(
    ("field_name", "raw_value", "normalized_value"),
    [
        ("theme", "\u00a0\u3000  Unicode theme  \u2003", "Unicode theme"),
        ("theme", f"\u3000{'t' * 2000}\u00a0", "t" * 2000),
        ("constraints", None, None),
        ("constraints", "", None),
        ("constraints", " \u00a0\u2003\u3000 ", None),
        ("constraints", "\u3000  Keep it local  \u00a0", "Keep it local"),
        ("constraints", f"\u2003{'c' * 2000}\u3000", "c" * 2000),
    ],
    ids=(
        "theme-unicode-strip",
        "theme-trimmed-2000",
        "constraints-null-preserved",
        "constraints-empty-to-null",
        "constraints-unicode-blank-to-null",
        "constraints-unicode-strip",
        "constraints-trimmed-2000",
    ),
)
def test_session_create_normalizes_text_before_length_validation(
    field_name: str,
    raw_value: object,
    normalized_value: str | None,
):
    session_create = SessionCreate.model_validate(
        build_valid_session_create_input(**{field_name: raw_value})
    )

    assert getattr(session_create, field_name) == normalized_value


@pytest.mark.parametrize(
    ("field_name", "raw_value", "expected_error_type"),
    [
        ("theme", " \u00a0\u2003\u3000 ", "string_too_short"),
        ("theme", f"\u3000{'t' * 2001}\u00a0", "string_too_long"),
        ("constraints", f"\u2003{'c' * 2001}\u3000", "string_too_long"),
    ],
    ids=("theme-unicode-blank", "theme-trimmed-2001", "constraints-trimmed-2001"),
)
def test_session_create_rejects_invalid_normalized_text_at_its_field(
    field_name: str,
    raw_value: str,
    expected_error_type: str,
):
    with pytest.raises(ValidationError) as validation_error:
        SessionCreate.model_validate(
            build_valid_session_create_input(**{field_name: raw_value})
        )

    assert [error["loc"] for error in validation_error.value.errors()] == [(field_name,)]
    assert validation_error.value.errors()[0]["type"] == expected_error_type


@pytest.mark.parametrize(
    ("field_name", "wrong_type_value"),
    [
        ("theme", 123),
        ("theme", ["not", "a", "string"]),
        ("constraints", 123),
        ("constraints", ["not", "a", "string"]),
    ],
)
def test_session_create_leaves_wrong_text_types_to_standard_validation(
    field_name: str,
    wrong_type_value: object,
):
    with pytest.raises(ValidationError) as validation_error:
        SessionCreate.model_validate(
            build_valid_session_create_input(**{field_name: wrong_type_value})
        )

    assert validation_error.value.errors()[0]["loc"] == (field_name,)
    assert validation_error.value.errors()[0]["type"] == "string_type"


def test_session_create_json_schema_exposes_nullable_constraints():
    properties = SessionCreate.model_json_schema()["properties"]

    assert properties["theme"]["minLength"] == 1
    assert properties["theme"]["maxLength"] == 2000
    assert properties["constraints"]["default"] is None
    assert properties["constraints"]["anyOf"] == [
        {"maxLength": 2000, "type": "string"},
        {"type": "null"},
    ]
