import subprocess
from pathlib import Path

import pytest

from llm import CodexCliLLM, LLMError


def test_codex_cli_llm_reads_output_last_message(monkeypatch, tmp_path) -> None:
    calls = []

    monkeypatch.setattr("llm.shutil.which", lambda _: "/bin/codex")

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        output = Path(cmd[cmd.index("--output-last-message") + 1])
        output.write_text("```tool_call\n{\"tool\": \"read\", \"params\": {\"path\": \"x\"}}\n```")
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout=(
                '{"type":"thread.started","thread_id":"tid-123"}\n'
                '{"type":"turn.completed","usage":{"input_tokens":10,'
                '"cached_input_tokens":4,"output_tokens":3}}\n'
            ),
            stderr="",
        )

    monkeypatch.setattr("llm.subprocess.run", fake_run)

    llm = CodexCliLLM(cwd=tmp_path, timeout_s=12)
    reply = llm.complete("system", "user")

    cmd, kwargs = calls[0]
    assert reply.startswith("```tool_call")
    assert cmd[:2] == ["/bin/codex", "exec"]
    assert "--ephemeral" not in cmd
    assert "--json" in cmd
    assert "--sandbox" in cmd
    assert cmd[cmd.index("--sandbox") + 1] == "read-only"
    assert kwargs["timeout"] == 12
    assert "text-only model inside the Chamfer harness" in kwargs["input"]
    assert llm.last_usage == {
        "input_tokens": 10,
        "cache_read_tokens": 4,
        "output_tokens": 3,
    }


def test_codex_cli_llm_resumes_exact_thread(monkeypatch, tmp_path) -> None:
    calls = []

    monkeypatch.setattr("llm.shutil.which", lambda _: "/bin/codex")

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        output = Path(cmd[cmd.index("--output-last-message") + 1])
        output.write_text("first" if len(calls) == 1 else "second")
        return subprocess.CompletedProcess(
            cmd,
            0,
            stdout='{"type":"thread.started","thread_id":"tid-123"}\n',
            stderr="",
        )

    monkeypatch.setattr("llm.subprocess.run", fake_run)

    llm = CodexCliLLM(cwd=tmp_path)
    assert llm.stateful
    assert llm.send("hello") == "first"
    assert calls[0][0][:2] == ["/bin/codex", "exec"]
    assert "resume" not in calls[0][0]
    assert "text-only model inside the Chamfer harness" in calls[0][1]["input"]

    assert llm.send("[tool result]\nok") == "second"
    assert calls[1][0][:3] == ["/bin/codex", "exec", "resume"]
    assert "tid-123" in calls[1][0]
    assert "-c" in calls[1][0]
    assert 'sandbox_mode="read-only"' in calls[1][0]
    assert calls[1][1]["input"] == "[tool result]\nok"


def test_codex_cli_llm_reports_cli_failure(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("llm.shutil.which", lambda _: "/bin/codex")
    monkeypatch.setattr(
        "llm.subprocess.run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="bad"),
    )

    llm = CodexCliLLM(cwd=tmp_path)

    with pytest.raises(LLMError, match="codex CLI failed"):
        llm.complete("system", "user")
