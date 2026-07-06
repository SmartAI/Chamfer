"""Small text tool-call protocol for harness agent loops."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

_FENCE = re.compile(r"```tool_call\s*\n(.*?)```", re.DOTALL)


class ProtocolError(Exception):
    pass


@dataclass(frozen=True)
class ToolCall:
    tool: str
    params: dict = field(default_factory=dict)


def parse_reply(text: str) -> ToolCall | None:
    """Extract exactly one fenced tool call, or None when the model is done."""

    blocks = _FENCE.findall(text)
    if not blocks:
        return None
    if len(blocks) > 1:
        raise ProtocolError(
            f"reply contains {len(blocks)} tool_call blocks; emit exactly "
            "one tool_call per reply"
        )
    try:
        data = json.loads(blocks[0])
    except json.JSONDecodeError as e:
        raise ProtocolError(f"tool_call block is not valid JSON: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("tool"), str):
        raise ProtocolError("tool_call JSON must be an object with a 'tool' string")
    params = data.get("params", {})
    if not isinstance(params, dict):
        raise ProtocolError("'params' must be a JSON object")
    return ToolCall(tool=data["tool"], params=params)
