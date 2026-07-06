"""Small harness workflow runner and text-to-CAD preset."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from agent import AgentResult, AgentSession
from tools import ToolRegistry
from workspace import WorkspaceManager


@dataclass(frozen=True)
class StageResult:
    name: str
    ok: bool
    artifact: str | None = None
    detail: str = ""


@dataclass
class WorkflowContext:
    task: str
    agent_session: AgentSession
    tools: ToolRegistry
    reporter: WorkflowReporter | None = None

    @property
    def workspace(self) -> WorkspaceManager:
        return self.agent_session.workspace


class Stage(Protocol):
    name: str

    def run(self, context: WorkflowContext) -> StageResult:
        ...


class WorkflowReporter(Protocol):
    def stage_start(self, name: str) -> None:
        ...

    def stage_end(self, result: StageResult) -> None:
        ...


@dataclass(frozen=True)
class FunctionStage:
    name: str
    fn: Callable[[WorkflowContext], StageResult]

    def run(self, context: WorkflowContext) -> StageResult:
        context.agent_session.session.append("stage_start", stage=self.name)
        if context.reporter is not None:
            context.reporter.stage_start(self.name)
        result = self.fn(context)
        context.agent_session.session.append(
            "stage_end",
            stage=self.name,
            ok=result.ok,
            artifact=result.artifact,
            detail=result.detail,
        )
        if context.reporter is not None:
            context.reporter.stage_end(result)
        return result


class WorkflowRunner:
    def __init__(self, name: str, stages: list[Stage]) -> None:
        self.name = name
        self.stages = stages

    def run(self, context: WorkflowContext) -> list[StageResult]:
        context.agent_session.session.append("workflow_start", workflow=self.name)
        results: list[StageResult] = []
        ok = True
        for stage in self.stages:
            result = stage.run(context)
            results.append(result)
            if not result.ok:
                ok = False
                break
        context.workspace.record_artifact(
            "workflow-results",
            {
                "workflow": self.name,
                "results": [result.__dict__ for result in results],
            },
        )
        context.workspace.finalize("pass" if ok else "fail", workflow=self.name)
        context.agent_session.session.append("workflow_end", workflow=self.name, ok=ok)
        return results


def text_to_cad_workflow(tools: ToolRegistry) -> WorkflowRunner:
    stages: list[Stage] = [
        FunctionStage("requirements", _requirements_stage),
        FunctionStage("plan", _plan_stage),
        FunctionStage("develop", _develop_stage),
    ]
    verifier = _verifier_tool_name(tools)
    if verifier is not None:
        stages.append(FunctionStage("verify", lambda context: _verify_stage(context, verifier)))
    stages.append(FunctionStage("output", _output_stage))
    return WorkflowRunner("text_to_cad", stages)


def _requirements_stage(context: WorkflowContext) -> StageResult:
    path = context.workspace.record_artifact(
        "requirements",
        {
            "version": 1,
            "request": context.task,
            "components": [],
            "assumptions": [],
        },
    )
    return StageResult("requirements", True, artifact=str(path), detail="requirements captured")


def _plan_stage(context: WorkflowContext) -> StageResult:
    tool_names = sorted(tool.name for tool in context.tools.specs())
    cad_tools = [name for name in tool_names if name not in {"read", "write", "edit", "bash"}]
    path = context.workspace.record_artifact(
        "plan",
        {
            "version": 1,
            "workflow": "text_to_cad",
            "available_tools": tool_names,
            "cad_tools": cad_tools,
            "geometry_execution": "available" if cad_tools else "unavailable",
            "verification": "available" if _verifier_tool_name(context.tools) else "unavailable",
        },
    )
    return StageResult("plan", True, artifact=str(path), detail="plan captured")


def _develop_stage(context: WorkflowContext) -> StageResult:
    result: AgentResult = context.agent_session.run_stage(
        (
            "Develop the CAD deliverable for this request using the available tools.\n\n"
            "CAD workflow contract:\n"
            "- Emit short user-facing progress notes before tool calls.\n"
            "- Build bottom-up as distinct named components when the request names components.\n"
            "- Give each final component a stable semantic name matching the requested "
            "part, not generic names such as shape1, solid, or result.\n"
            "- Use millimeters and encode requested nominal dimensions directly in the "
            "CAD model before measuring the result.\n"
            "- For appearance requests, assign explicit per-component CAD colours before "
            "export; for build123d set each named object's `.color` (for example black "
            "plastic parts black and metal parts steel-grey). STEP can preserve colour, "
            "but not procedural brushed or matte texture maps.\n"
            "- Use measured CAD tools for bounding boxes, volumes, hole diameters and "
            "positions, capacity, clearances, component counts, and validity checks.\n"
            "- For assemblies or multi-component parts, check connectivity/contact, "
            "intended clearances, unwanted intersections/crossovers, floating parts, "
            "and unstitched gaps when the MCP exposes suitable tools.\n"
            "- Validate each final solid or the full assembly when validation tools are available.\n"
            "- If measurement or validation shows an invalid solid, missing feature, "
            "wrong size, wrong component count, disconnected part, unintended "
            "intersection, or bad clearance, repair the CAD before export.\n"
            "- If render_view is available and the request mentions appearance, colour, "
            "material, finish, or visual quality, render the assembly before export and "
            "use the render to catch obvious appearance or placement errors.\n"
            "- Export a durable CAD artifact, preferably STEP, when export tools are available.\n"
            "- If the request asks for STEP, do not substitute STL as success. "
            "With build123d and named components, export all named final components with "
            "object_name=\"*\" to preserve product names and per-component colours; do "
            "not export only an aggregate compound such as `assembly` or "
            "`kettle_assembly` unless the task asks for one fused part. Use a filename "
            "ending in .step; if an output directory is missing, use a simple "
            "workspace-root filename or create the directory first.\n"
            "- Finish with a concise report listing deliverable paths, component geometry, "
            "measured bounding boxes, volumes/capacities, clearances, validation/export "
            "evidence, connectivity/intersection checks when available, rendered "
            "appearance checks when performed, and known limitations.\n"
            "If no CAD execution tool is available, create useful local plan/script files "
            "and report that geometry execution is unavailable.\n\n"
            f"Request: {context.task}"
        ),
        stage_name="develop",
    )
    path = context.workspace.record_artifact(
        "develop",
        {
            "ok": result.ok,
            "turns": result.turns,
            "reply": result.reply,
        },
    )
    ok = result.ok
    detail = result.reply
    if ok and _export_available(context.tools) and not context.workspace.manifest().get("generated_files"):
        ok = False
        detail = "CAD export tool was available, but no generated CAD artifact was recorded"
    if ok and _requires_step(context.task) and not _generated_step_paths(context.workspace):
        ok = False
        detail = "request required a STEP file, but no generated STEP artifact was recorded"
    return StageResult("develop", ok, artifact=str(path), detail=detail)


def _verify_stage(context: WorkflowContext, verifier: str) -> StageResult:
    step_paths = _generated_step_paths(context.workspace)
    if not step_paths:
        path = context.workspace.record_artifact(
            "verify",
            {
                "tool": verifier,
                "ok": True,
                "skipped": True,
                "reason": "no generated STEP file recorded",
            },
        )
        return StageResult(
            "verify",
            True,
            artifact=str(path),
            detail="verification skipped: no generated STEP file recorded",
        )
    step_path = step_paths[-1]
    result = context.tools.execute_result(
        verifier,
        {
            "step_path": step_path,
            "spec": {"assertions": []},
        },
    )
    path = context.workspace.record_artifact(
        "verify",
        {
            "tool": verifier,
            "step_path": step_path,
            "ok": result.ok,
            "result": result.output,
        },
    )
    return StageResult("verify", result.ok, artifact=str(path), detail=result.output)


def _output_stage(context: WorkflowContext) -> StageResult:
    manifest = context.workspace.manifest()
    artifacts = manifest.get("artifacts", {})
    verification = "verify" in artifacts
    final_reply = _latest_stage_reply(context, "develop")
    tool_summary = _tool_summary(context)
    report = _render_final_report(
        task=context.task,
        final_reply=final_reply,
        generated_files=manifest.get("generated_files", []),
        verification_status="recorded" if verification else "unavailable",
        tool_summary=tool_summary,
    )
    report_path = context.workspace.record_text_artifact(
        "final-report",
        report,
        filename="final-report.md",
    )
    path = context.workspace.record_artifact(
        "output",
        {
            "request": context.task,
            "deliverables": manifest.get("generated_files", []),
            "verification_status": "recorded" if verification else "unavailable",
            "final_reply": final_reply,
            "tool_summary": tool_summary,
            "report_path": str(report_path),
            "artifacts": context.workspace.manifest().get("artifacts", {}),
        },
    )
    return StageResult("output", True, artifact=str(path), detail="final report written")


def _verifier_tool_name(tools: ToolRegistry) -> str | None:
    for tool in tools.specs():
        if tool.name.startswith("verify"):
            return tool.name
    return None


def _export_available(tools: ToolRegistry) -> bool:
    return any(tool.name == "export" for tool in tools.specs())


def _generated_step_paths(workspace: WorkspaceManager) -> list[str]:
    paths: list[str] = []
    for entry in workspace.manifest().get("generated_files", []):
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "")
        kind = str(entry.get("kind") or "").lower()
        if kind in {"step", "stp"} or path.lower().endswith((".step", ".stp")):
            paths.append(path)
    return paths


def _requires_step(task: str) -> bool:
    return "step" in task.lower() or ".stp" in task.lower()


def _latest_stage_reply(context: WorkflowContext, stage: str) -> str:
    reply = ""
    for record in context.agent_session.session.records():
        if record.get("kind") == "stage_end" and record.get("stage") == stage:
            reply = str(record.get("reply") or reply)
    return reply


def _tool_summary(context: WorkflowContext) -> dict:
    calls = [
        record
        for record in context.agent_session.session.records()
        if record.get("kind") == "tool_call"
    ]
    names = [str(record.get("tool")) for record in calls]
    evidence_tools = (
        "measure",
        "validate",
        "clearance",
        "cross_sections",
        "render_view",
        "export",
        "import_cad_file",
        "verify_step",
    )
    evidence = [
        {
            "turn": record.get("turn"),
            "tool": record.get("tool"),
            "ok": record.get("ok"),
            "artifact_path": record.get("artifact_path"),
        }
        for record in calls
        if str(record.get("tool")) in evidence_tools
    ]
    return {
        "tool_calls": len(calls),
        "tools_used": sorted(set(names)),
        "evidence": evidence,
    }


def _render_final_report(
    *,
    task: str,
    final_reply: str,
    generated_files: list[dict],
    verification_status: str,
    tool_summary: dict,
) -> str:
    deliverables = "\n".join(
        f"- {entry.get('path')} ({entry.get('kind', 'file')})"
        for entry in generated_files
        if isinstance(entry, dict)
    ) or "- No generated files recorded."
    evidence = "\n".join(
        f"- turn {item['turn']}: {item['tool']} ok={item['ok']}"
        + (f" artifact={item['artifact_path']}" if item.get("artifact_path") else "")
        for item in tool_summary.get("evidence", [])
    ) or "- No measurement/validation/export evidence tools recorded."
    final = final_reply.strip() or "No final agent report was provided."
    return (
        "# Chamfer Final Report\n\n"
        f"## Request\n{task}\n\n"
        f"## Deliverables\n{deliverables}\n\n"
        f"## Verification Status\n{verification_status}\n\n"
        f"## Tool Evidence\n{evidence}\n\n"
        "## Agent Report\n"
        f"{final}\n"
    )
