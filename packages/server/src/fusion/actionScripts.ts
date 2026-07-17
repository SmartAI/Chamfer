import type { FusionActionRequestDto, FusionDocumentIdentityDto } from "@chamfer/shared";

const pyJson = (value: unknown) => JSON.stringify(JSON.stringify(value));

function indentBody(body: string): string {
  return body.split("\n").map((line) => `            ${line}`).join("\n");
}

/** Trusted transaction shell. Generated code is inserted only after the server's
 * syntax-aware policy accepts it and receives capabilities through local names. */
export function fusionActionHarnessScript(
  request: FusionActionRequestDto,
  expectedDocument: FusionDocumentIdentityDto,
  resolvedReferences: Record<string, string>,
  deadlineSeconds = 180,
): string {
  // The whole action body (all its features + a full computeAll) must finish
  // inside this budget. 20s was far too tight for a genuinely complex feature
  // and timed a correct build out into hard-recovery; default generously and
  // let the caller raise it further via CHAMFER_FUSION_ACTION_TIMEOUT_S.
  const budgetSeconds = Number.isFinite(deadlineSeconds) && deadlineSeconds > 0 ? Math.floor(deadlineSeconds) : 180;
  const commandId = `ChamferAction_${request.actionId.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return `# CHAMFER_FUSION_ATOMIC_ACTION_V1
import adsk.core
import adsk.fusion
import json
import time
import traceback
import uuid

_handlers = []
_command = None
_complete = False
_destroyed = False
_error = None
_expected_document = json.loads(${pyJson(expectedDocument)})
_reference_tokens = json.loads(${pyJson(resolvedReferences)})
_action = json.loads(${pyJson({ id: request.actionId, intent: request.intent })})

def register_entity(entity, semantic_descriptor):
    if not entity or not isinstance(semantic_descriptor, str) or not semantic_descriptor.strip():
        raise RuntimeError("Chamfer entity registration requires an entity and semantic descriptor")
    identity = entity.attributes.itemByName("com.chamfer.entity", "uuid")
    if not identity:
        identity = entity.attributes.add("com.chamfer.entity", "uuid", str(uuid.uuid4()))
    descriptor = entity.attributes.itemByName("com.chamfer.entity", "semantic")
    if descriptor:
        descriptor.deleteMe()
    entity.attributes.add("com.chamfer.entity", "semantic", semantic_descriptor.strip())
    return "chamfer:" + identity.value

def world_to_sketch(sketch, x_mm, y_mm, z_mm):
    # Deterministic placement on ANY sketch plane: converts an intended WORLD
    # position (mm) into the sketch's own coordinate space. Hand-mapping sketch
    # axes to world axes flips sign per plane orientation and creation method
    # (observed live: flange rectangles guessed onto a yZ-offset plane landed
    # 80 mm outside the housing); Fusion's own transform is exact for every
    # construction plane, offset plane, and face sketch.
    if not sketch or not hasattr(sketch, "modelToSketchSpace"):
        raise RuntimeError("world_to_sketch requires a Fusion sketch")
    return sketch.modelToSketchSpace(adsk.core.Point3D.create(x_mm / 10.0, y_mm / 10.0, z_mm / 10.0))

def delete_owned(entity):
    # Self-repair: delete a feature/body/sketch Chamfer created this session so the
    # agent can revise its own work. Refuses anything without the Chamfer ownership
    # attribute, so it can never remove pre-existing user history.
    if not entity:
        raise RuntimeError("delete_owned requires a Chamfer-created entity")
    identity = entity.attributes.itemByName("com.chamfer.entity", "uuid")
    if not identity:
        raise RuntimeError("delete_owned refuses an entity Chamfer did not create this session")
    return entity.deleteMe()

def _active_design():
    app = adsk.core.Application.get()
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not doc or not design:
        raise RuntimeError("No active Fusion design")
    data_file = doc.dataFile
    matches = (data_file.id == _expected_document.get("dataFileId")) if _expected_document.get("dataFileId") else (doc.creationId == _expected_document.get("id"))
    if not matches:
        raise RuntimeError("Active Fusion document changed before command execution")
    return app, design

class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args):
        global _complete, _error
        try:
            app, design = _active_design()
            root = design.rootComponent
            materialLibraries = app.materialLibraries
            references = {}
            for reference_id, token in _reference_tokens.items():
                resolved = design.findEntityByToken(token)
                if not resolved or len(resolved) != 1:
                    raise RuntimeError("Affected Fusion reference did not resolve exactly once: " + reference_id)
                references[reference_id] = resolved[0]
            action = _action
            transaction = args
${indentBody(request.body)}
            if not design.computeAll():
                raise RuntimeError("Fusion computeAll failed after the action")
        except Exception:
            _error = traceback.format_exc()
            args.executeFailed = True
            args.executeFailedMessage = _error
        finally:
            _complete = True

class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args):
        global _command
        _command = args.command
        _command.isAutoExecute = False
        execute_handler = _ExecuteHandler()
        _command.execute.add(execute_handler)
        _handlers.append(execute_handler)
        destroy_handler = _DestroyHandler()
        _command.destroy.add(destroy_handler)
        _handlers.append(destroy_handler)

class _DestroyHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()
    def notify(self, args):
        global _destroyed
        _destroyed = True

def run(_context: str):
    global _command
    app, design = _active_design()
    command_id = ${JSON.stringify(commandId)}
    old_definition = app.userInterface.commandDefinitions.itemById(command_id)
    if old_definition:
        old_definition.deleteMe()
    definition = app.userInterface.commandDefinitions.addButtonDefinition(command_id, "Chamfer action", "One reviewed atomic Chamfer modeling action")
    created = _CreatedHandler()
    definition.commandCreated.add(created)
    _handlers.append(created)
    if not definition.execute():
        definition.deleteMe()
        raise RuntimeError("Fusion refused to start the Chamfer action")
    deadline = time.time() + ${budgetSeconds}
    while _command is None and time.time() < deadline:
        adsk.doEvents()
    if _command is None or not _command.doExecute(True):
        definition.deleteMe()
        raise RuntimeError("Fusion refused to execute the Chamfer action")
    while not _complete and time.time() < deadline:
        adsk.doEvents()
    if not _complete:
        definition.deleteMe()
        raise RuntimeError("Chamfer action timed out")
    if _error:
        definition.deleteMe()
        raise RuntimeError(_error)
    while not _destroyed and time.time() < deadline:
        adsk.doEvents()
    if not _destroyed:
        definition.deleteMe()
        raise RuntimeError("Fusion did not finish the Chamfer transaction")
    definition.deleteMe()
    print(json.dumps({"commandId": command_id, "undoEntries": 1}, sort_keys=True))
`;
}
