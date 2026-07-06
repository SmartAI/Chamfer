"""Register the tiered STEP verifier as an agent tool.

The verifier itself lives in this package (spec/step_reader/tiered); this module
exposes it to the agent loop as the `verify_step` tool.
"""

from __future__ import annotations

from tools import ToolDefinition, ToolExecutionContext, ToolRegistry, ToolResult


def register_verify_tools(registry: ToolRegistry) -> list[str]:
    registry.register(verify_step_tool())
    return ["verify_step"]


def verify_step_tool() -> ToolDefinition:
    def execute(params: dict, context: ToolExecutionContext) -> ToolResult:
        from .tiered import TieredVerifier

        step_path = context.profile.resolve_read_path(params["step_path"])
        report = TieredVerifier(allow_geometric=False).verify(
            step_path,
            params.get("spec", {}),
        )
        return ToolResult(
            ok=report.ok,
            output=str(report.to_dict()),
        )

    return ToolDefinition(
        name="verify_step",
        description="Verify a STEP file with the tiered STEP verifier.",
        input_schema={
            "type": "object",
            "required": ["step_path"],
            "properties": {
                "step_path": {"type": "string"},
                "spec": {"type": "object"},
            },
        },
        execute=execute,
        risk="safe",
        sandbox_profile="read_only",
    )
