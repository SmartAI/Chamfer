"""Provider seams in chamfer.llm: env-key guards and OpenRouter request shape."""

import io
import json

import pytest

from llm import AnthropicLLM, LLMError, OpenAILLM, OpenRouterLLM


def test_openrouter_requires_the_env_key(monkeypatch) -> None:
    monkeypatch.delenv("OPEN_ROUTER_API", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(LLMError, match="OPEN_ROUTER_API"):
        OpenRouterLLM()


def test_openrouter_builds_request_and_parses_reply(monkeypatch) -> None:
    monkeypatch.setenv("OPEN_ROUTER_API", "sk-test")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["body"] = json.loads(req.data)
        reply = {"choices": [{"message": {"content": "hello from or"}}]}
        return io.BytesIO(json.dumps(reply).encode())

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    llm = OpenRouterLLM(model="test/model")

    out = llm.complete("sys prompt", "user prompt")

    assert out == "hello from or"
    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["auth"] == "Bearer sk-test"
    assert captured["body"]["model"] == "test/model"
    assert captured["body"]["messages"][0] == {"role": "system", "content": "sys prompt"}
    assert captured["body"]["messages"][1] == {"role": "user", "content": "user prompt"}


def test_openai_requires_the_env_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(LLMError, match="OPENAI_API_KEY"):
        OpenAILLM()


def test_anthropic_requires_the_env_key(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(LLMError, match="ANTHROPIC_API_KEY"):
        AnthropicLLM()
