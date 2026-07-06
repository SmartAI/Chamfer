from pathlib import Path

import pytest

from policy import ActionPolicy
from sandbox import SandboxProfile, SandboxRunner, default_profiles
from tools import build_local_tool_registry


def test_local_tools_have_required_capability_metadata(tmp_path) -> None:
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)

    by_name = {tool.name: tool for tool in registry.specs()}

    assert set(by_name) == {"read", "write", "edit", "bash"}
    assert by_name["read"].risk == "safe"
    assert by_name["write"].risk == "consequential"
    assert by_name["edit"].sandbox_profile == "workspace_write"
    assert by_name["bash"].sandbox_profile == "test"


def test_write_and_read_cannot_escape_allowed_roots(tmp_path) -> None:
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    outside = tmp_path.parent / f"{tmp_path.name}-outside.txt"

    write_out = registry.execute("write", {"path": str(outside), "content": "nope"})
    read_out = registry.execute("read", {"path": str(outside)})

    assert write_out.startswith("error:")
    assert read_out.startswith("error:")
    assert not outside.exists()


def test_bash_receives_declared_cwd_env_and_timeout(tmp_path) -> None:
    profiles = default_profiles(tmp_path)
    profiles["test"] = SandboxProfile(
        name="test",
        cwd=tmp_path,
        readable_roots=(tmp_path,),
        writable_roots=(tmp_path,),
        env={"CHAMFER_TEST_VALUE": "visible"},
        timeout_s=10,
        network="off",
    )
    registry = build_local_tool_registry(ActionPolicy.auto(), tmp_path)
    registry._profiles = profiles

    out = registry.execute(
        "bash",
        {"command": "pwd && printf \" $CHAMFER_TEST_VALUE\""},
    )
    timeout = registry.execute("bash", {"command": "sleep 5", "timeout_s": 1})

    assert str(tmp_path) in out
    assert "visible" in out
    assert "exit code: 0" in out
    assert "timed out" in timeout


def test_bash_truncation_preserves_full_output_artifact(tmp_path) -> None:
    artifacts = tmp_path / "artifacts"
    registry = build_local_tool_registry(
        ActionPolicy.auto(),
        tmp_path,
        artifacts_dir=artifacts,
    )

    out = registry.execute(
        "bash",
        {"command": "for i in $(seq 1 5000); do echo line$i; done"},
    )

    full = artifacts / "bash-full-output.txt"
    assert "line5000" in out
    assert "line1\n" not in out
    assert "truncated" in out
    assert full.is_file()
    assert "line1" in full.read_text()


def test_sandbox_runner_rejects_cwd_outside_read_roots(tmp_path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    profile = SandboxProfile(
        name="bad",
        cwd=outside,
        readable_roots=(tmp_path / "allowed",),
    )

    with pytest.raises(PermissionError):
        SandboxRunner().run_bash("echo nope", profile)
