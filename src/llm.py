"""LLM provider seam and deterministic scripted adapter."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Protocol

DEFAULT_MODEL = "scripted"


class LLMError(Exception):
    pass


class LLM(Protocol):
    last_usage: dict | None

    def complete(self, system: str, user: str) -> str:
        ...


def normalize_usage(raw, cost_usd=None) -> dict | None:
    out: dict = {}
    if isinstance(raw, dict):
        mapping = (
            ("input_tokens", "input_tokens"),
            ("prompt_tokens", "input_tokens"),
            ("output_tokens", "output_tokens"),
            ("completion_tokens", "output_tokens"),
            ("cached_input_tokens", "cache_read_tokens"),
            ("cache_read_input_tokens", "cache_read_tokens"),
            ("cache_creation_input_tokens", "cache_write_tokens"),
            ("reasoning_output_tokens", "reasoning_output_tokens"),
            ("total_tokens", "total_tokens"),
        )
        for src, dst in mapping:
            value = raw.get(src)
            if isinstance(value, (int, float)) and dst not in out:
                out[dst] = int(value)
    if cost_usd is not None:
        try:
            out["cost_usd"] = round(float(cost_usd), 6)
        except (TypeError, ValueError):
            pass
    return out or None


class ScriptedLLM:
    last_usage = None
    model = "scripted"

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        if not self._responses:
            raise LLMError("scripted responses exhausted")
        return self._responses.pop(0)


def scripted_llm_from_dir(path: str | Path) -> ScriptedLLM:
    root = Path(path)
    responses: list[str] = []
    for file in sorted(root.glob("response_*.json")):
        text = file.read_text(encoding="utf-8")
        try:
            data = json.loads(text)
        except ValueError:
            responses.append(text)
            continue
        if isinstance(data, str):
            responses.append(data)
        elif isinstance(data, dict) and isinstance(data.get("reply"), str):
            responses.append(data["reply"])
        else:
            responses.append(text)
    if not responses:
        raise LLMError(f"no scripted response_*.json files in {root}")
    return ScriptedLLM(responses)


class AnthropicLLM:
    def __init__(self, model: str = "claude-opus-4-8", max_tokens: int = 4096) -> None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise LLMError(
                "ANTHROPIC_API_KEY is not set; export it or choose another provider"
            )
        try:
            import anthropic
        except ImportError as e:
            raise LLMError("anthropic package not installed; run: uv sync --extra llm") from e
        self._client = anthropic.Anthropic()
        self.model = model
        self.max_tokens = max_tokens
        self.last_usage: dict | None = None

    def complete(self, system: str, user: str) -> str:
        response = self._client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        usage = getattr(response, "usage", None)
        self.last_usage = normalize_usage(
            {
                key: getattr(usage, key, None)
                for key in (
                    "input_tokens",
                    "prompt_tokens",
                    "output_tokens",
                    "completion_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                )
            }
            if usage else None
        )
        return "".join(b.text for b in response.content if b.type == "text")


class OpenAILLM:
    def __init__(self, model: str = "gpt-5", max_tokens: int = 4096) -> None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise LLMError(
                "OPENAI_API_KEY is not set; export it or choose another provider"
            )
        try:
            import openai
        except ImportError as e:
            raise LLMError("openai package not installed; run: uv sync --extra llm") from e
        self._client = openai.OpenAI()
        self.model = model
        self.max_tokens = max_tokens
        self.last_usage: dict | None = None

    def complete(self, system: str, user: str) -> str:
        response = self._client.chat.completions.create(
            model=self.model,
            max_completion_tokens=self.max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        usage = getattr(response, "usage", None)
        self.last_usage = normalize_usage(
            {
                key: getattr(usage, key, None)
                for key in ("prompt_tokens", "completion_tokens", "total_tokens")
            }
            if usage else None
        )
        return response.choices[0].message.content or ""


class OpenRouterLLM:
    URL = "https://openrouter.ai/api/v1/chat/completions"

    def __init__(
        self,
        model: str | None = None,
        timeout_s: float = 600.0,
        max_tokens: int = 8192,
    ) -> None:
        self._key = (
            os.environ.get("OPEN_ROUTER_API", "")
            or os.environ.get("OPENROUTER_API_KEY", "")
        )
        if not self._key:
            raise LLMError(
                "OPEN_ROUTER_API / OPENROUTER_API_KEY is not set; export it or choose another LLM"
            )
        self.model = model or os.environ.get(
            "OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5"
        )
        self._timeout = timeout_s
        self.max_tokens = max_tokens
        self.last_usage: dict | None = None

    def complete(self, system: str, user: str) -> str:
        return self._chat([
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ])

    def complete_vision(self, system: str, user: str, images: list[bytes]) -> str:
        import base64

        content = [{"type": "text", "text": user}] + [
            {
                "type": "image_url",
                "image_url": {
                    "url": "data:image/png;base64," + base64.b64encode(png).decode()
                },
            }
            for png in images
        ]
        return self._chat([
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ])

    def _chat(self, messages: list[dict]) -> str:
        import urllib.error
        import urllib.request

        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
        }
        req = urllib.request.Request(
            self.URL,
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise LLMError(f"OpenRouter HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, OSError) as e:
            raise LLMError(f"cannot reach OpenRouter: {e}") from e
        usage = data.get("usage") if isinstance(data, dict) else None
        self.last_usage = normalize_usage(
            usage,
            usage.get("cost") if isinstance(usage, dict) else None,
        )
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"unexpected OpenRouter reply: {str(data)[:300]}") from e


class ClaudeCliSessionLLM:
    stateful = True

    def __init__(
        self,
        model: str = "opus",
        timeout_s: float = 900.0,
        effort: str = "medium",
        allowed_tools: tuple[str, ...] = (),
    ) -> None:
        self._exe = shutil.which("claude")
        if not self._exe:
            raise LLMError("claude CLI not found on PATH; install Claude Code or use another LLM")
        self.model = model
        self._timeout = timeout_s
        self._session_id: str | None = None
        self.last_usage: dict | None = None
        self._allowed_tools = tuple(allowed_tools)
        self._env = {**os.environ, "CLAUDE_EFFORT": effort}

    def send(self, text: str) -> str:
        tool_args = (
            ["--allowedTools", ",".join(self._allowed_tools)]
            if self._allowed_tools else ["--tools", ""]
        )
        slim_args = [
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
        ]
        cmd = [
            self._exe,
            "-p",
            "--output-format",
            "json",
            *tool_args,
            *slim_args,
            "--disable-slash-commands",
            "--model",
            self.model,
        ]
        if self._session_id:
            cmd += ["--resume", self._session_id]
        try:
            proc = subprocess.run(
                cmd,
                input=text,
                capture_output=True,
                text=True,
                timeout=self._timeout,
                env=self._env,
            )
        except subprocess.TimeoutExpired as e:
            raise LLMError(f"claude CLI timed out after {self._timeout}s") from e
        if proc.returncode != 0:
            raise LLMError(
                f"claude CLI failed with exit code {proc.returncode}: "
                f"{proc.stderr.strip()[:500]}"
            )
        try:
            data = json.loads(proc.stdout)
        except ValueError as e:
            raise LLMError(f"claude CLI returned non-JSON output: {proc.stdout[:300]}") from e
        if data.get("is_error"):
            raise LLMError(f"claude CLI error: {str(data.get('result'))[:500]}")
        self._session_id = data.get("session_id") or self._session_id
        self.last_usage = normalize_usage(data.get("usage"), data.get("total_cost_usd"))
        return str(data.get("result") or "")

    def complete(self, system: str, user: str) -> str:
        self.reset()
        reply = self.send(f"{system}\n\n---\n\n{user}")
        self.reset()
        return reply

    def reset(self) -> None:
        self._session_id = None


class CodexCliLLM:
    """Stateful non-interactive Codex CLI adapter.

    Codex is invoked as a text provider for Chamfer's own tool protocol. The
    prompt explicitly asks the child agent not to run its own tools; Chamfer
    remains responsible for executing CAD tools. A persisted Codex exec thread
    is created on the first turn and resumed afterward so the child model keeps
    the same conversation context across the agent loop.
    """

    stateful = True
    model = "codex-cli"

    def __init__(
        self,
        *,
        executable: str = "codex",
        cwd: str | Path | None = None,
        timeout_s: float = 900.0,
        model: str | None = None,
    ) -> None:
        self._exe = shutil.which(executable)
        if not self._exe:
            raise LLMError(f"{executable} CLI not found on PATH")
        self.cwd = Path(cwd).resolve() if cwd is not None else Path.cwd()
        self._timeout = timeout_s
        self.model = model or "codex-cli"
        self.last_usage: dict | None = None
        self._thread_id: str | None = None

    def send(self, text: str) -> str:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="chamfer-codex-") as tmp:
            output = Path(tmp) / "last-message.txt"
            prompt = self._initial_prompt(text) if self._thread_id is None else text
            cmd = self._command(output)
            if self.model != "codex-cli":
                cmd[-1:-1] = ["--model", self.model]
            try:
                proc = subprocess.run(
                    cmd,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    timeout=self._timeout,
                    cwd=self.cwd,
                )
            except subprocess.TimeoutExpired as e:
                raise LLMError(f"codex CLI timed out after {self._timeout}s") from e
            if proc.returncode != 0:
                raise LLMError(
                    f"codex CLI failed with exit code {proc.returncode}: "
                    f"{(proc.stderr or proc.stdout).strip()[:800]}"
                )
            try:
                reply = output.read_text(encoding="utf-8")
            except OSError as e:
                raise LLMError(
                    f"codex CLI did not write last message; stdout: {proc.stdout[:800]}"
                ) from e
            self._thread_id = _thread_id_from_codex_stdout(proc.stdout) or self._thread_id
            self.last_usage = _usage_from_codex_stdout(proc.stdout)
            return reply.strip()

    def complete(self, system: str, user: str) -> str:
        self.reset()
        reply = self.send(f"<system>\n{system}\n</system>\n\n<conversation>\n{user}\n</conversation>")
        self.reset()
        return reply

    def reset(self) -> None:
        self._thread_id = None

    def _initial_prompt(self, text: str) -> str:
        return (
            "You are being used as a text-only model inside the Chamfer harness.\n"
            "Do not run shell commands, edit files, or use Codex tools. "
            "Return only the next assistant message for Chamfer's tool_call protocol.\n\n"
            f"{text}"
        )

    def _command(self, output: Path) -> list[str]:
        common = [
            "--ignore-rules",
            "-c",
            'approval_policy="never"',
            "--json",
            "--output-last-message",
            str(output),
        ]
        if self._thread_id is None:
            return [
                self._exe,
                "exec",
                "--cd",
                str(self.cwd),
                "--sandbox",
                "read-only",
                "--color",
                "never",
                *common,
                "-",
            ]
        return [
            self._exe,
            "exec",
            "resume",
            *common,
            "-c",
            'sandbox_mode="read-only"',
            self._thread_id,
            "-",
        ]


def _thread_id_from_codex_stdout(stdout: str) -> str | None:
    for line in stdout.splitlines():
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("type") == "thread.started":
            thread_id = data.get("thread_id")
            if isinstance(thread_id, str) and thread_id:
                return thread_id
    return None


def _usage_from_codex_stdout(stdout: str) -> dict | None:
    json_usage: dict | None = None
    for line in stdout.splitlines():
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("type") == "turn.completed":
            usage = data.get("usage")
            if isinstance(usage, dict):
                json_usage = usage
    if json_usage is not None:
        return normalize_usage(json_usage)
    for line in reversed(stdout.splitlines()):
        text = line.strip().replace(",", "")
        if text.isdigit():
            return {"total_tokens": int(text)}
    return None
