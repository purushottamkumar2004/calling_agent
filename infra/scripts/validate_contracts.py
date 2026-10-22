"""Validate frozen v1 contracts in docs/contracts (ADR 0008).

Checks that:
  1. every JSON Schema is a valid draft 2020-12 schema,
  2. the internal OpenAPI spec is valid OpenAPI 3.1 (external $refs resolved),
  3. every example validates against its schema (event examples are checked
     against the envelope and then their payload against the event schema).

Run from the repo root:  python infra/scripts/validate_contracts.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate
from openapi_spec_validator.readers import read_from_filename

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "docs" / "contracts"
EVENTS = CONTRACTS / "events"
EXAMPLES = CONTRACTS / "examples"

# example file -> schema it must satisfy (non-event examples)
PLAIN_EXAMPLES = {
    "agent-config.clinic.json": "agent-config.v1.schema.json",
}


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def validator_for(schema_path: Path) -> Draft202012Validator:
    schema = load_json(schema_path)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def report(errors: list[str], label: str, validator: Draft202012Validator, instance: Any) -> None:
    for err in sorted(validator.iter_errors(instance), key=lambda e: list(e.path)):
        where = "/".join(str(p) for p in err.path) or "<root>"
        errors.append(f"{label}: {where}: {err.message}")


def main() -> int:
    errors: list[str] = []

    schema_files = sorted(CONTRACTS.glob("*.schema.json")) + sorted(EVENTS.glob("*.schema.json"))
    validators: dict[str, Draft202012Validator] = {}
    for path in schema_files:
        try:
            validators[path.name] = validator_for(path)
            print(f"ok   schema   {path.relative_to(ROOT)}")
        except Exception as exc:  # noqa: BLE001 - report every failure, keep going
            errors.append(f"{path.relative_to(ROOT)}: invalid schema: {exc}")

    openapi_path = CONTRACTS / "internal-api.openapi.yaml"
    try:
        spec, base_uri = read_from_filename(str(openapi_path))
        validate(spec, base_uri=base_uri)
        print(f"ok   openapi  {openapi_path.relative_to(ROOT)}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"{openapi_path.relative_to(ROOT)}: {exc}")

    for name, schema_name in PLAIN_EXAMPLES.items():
        path = EXAMPLES / name
        if path.exists() and schema_name in validators:
            before = len(errors)
            report(errors, str(path.relative_to(ROOT)), validators[schema_name], load_json(path))
            if len(errors) == before:
                print(f"ok   example  {path.relative_to(ROOT)}")

    envelope = validators.get("envelope.schema.json")
    for path in sorted(EXAMPLES.glob("*.json")):
        if path.name in PLAIN_EXAMPLES or envelope is None:
            continue
        doc = load_json(path)
        label = str(path.relative_to(ROOT))
        before = len(errors)
        report(errors, f"{label} (envelope)", envelope, doc)
        event_type = doc.get("event_type")
        version = doc.get("schema_version")
        payload_schema = f"{event_type}.v{version}.schema.json"
        if payload_schema in validators:
            report(errors, f"{label} (payload)", validators[payload_schema], doc.get("payload"))
        else:
            errors.append(f"{label}: no schema {payload_schema} for event_type={event_type}")
        if len(errors) == before:
            print(f"ok   example  {label}")

    if errors:
        print("\nContract validation failed:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("\nAll contracts valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
