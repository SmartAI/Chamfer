import os
import time

from evidence import EvidenceLedger, classify_command
from policy import ActionPolicy
from tools import build_local_tool_registry


def test_classifies_common_command_kinds() -> None:
    assert classify_command("uv run pytest") == "test"
    assert classify_command("ruff check src") == "lint"
    assert classify_command("python -m build") == "build"
    assert classify_command("render preview") == "render_check"
    assert classify_command("python scratch.py") == "debug"


def test_evidence_freshness_and_gap_reporting(tmp_path) -> None:
    ledger = EvidenceLedger(tmp_path / "evidence.jsonl")
    source = tmp_path / "model.py"
    source.write_text("old")
    old_time = time.time() - 10
    record = ledger.record(
        command="uv run pytest",
        kind="test",
        scope="repo",
        status="pass",
        exit_code=0,
        cwd=tmp_path,
        output_summary="passed",
        timestamp=old_time,
    )
    os.utime(source, (time.time(), time.time()))

    assert ledger.is_fresh_for(record, [source]) is False
    assert ledger.verification_gap([source], kind="test") == \
        "latest passing test evidence is stale"


def test_bash_records_evidence_with_full_output_artifact(tmp_path) -> None:
    ledger = EvidenceLedger(tmp_path / "evidence.jsonl")
    artifacts = tmp_path / "artifacts"
    registry = build_local_tool_registry(
        ActionPolicy.auto(),
        tmp_path,
        artifacts_dir=artifacts,
        evidence=ledger,
    )

    out = registry.execute(
        "bash",
        {"command": "for i in $(seq 1 5000); do echo line$i; done"},
    )
    records = ledger.records()

    assert "truncated" in out
    assert len(records) == 1
    record = records[0]
    assert record.kind == "debug"
    assert record.status == "pass"
    assert record.exit_code == 0
    assert record.cwd == str(tmp_path.resolve())
    assert record.full_output_artifact == str(artifacts / "bash-full-output.txt")
    assert "line5000" in record.output_summary
