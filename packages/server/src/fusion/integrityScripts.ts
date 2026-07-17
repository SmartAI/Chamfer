const MARKER_GROUP = "chamfer.integrity-probe";
const MARKER_NAME = "disposable-document";

function pyString(value: string): string {
  return JSON.stringify(value);
}

function commonInspector(marker: string): string {
  return `
def _point(value):
    return [value.x, value.y, value.z]

def _active_probe():
    app = adsk.core.Application.get()
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not doc or not design:
        raise RuntimeError("No active Fusion design")
    attr = design.rootComponent.attributes.itemByName(${pyString(MARKER_GROUP)}, ${pyString(MARKER_NAME)})
    if not attr or attr.value != ${pyString(marker)}:
        raise RuntimeError("Active document is not the disposable document created by this probe")
    return app, doc, design

def _identity(doc, design):
    data_file = doc.dataFile
    return {
        "probeToken": ${pyString(marker)},
        "documentName": doc.name,
        "dataFileId": data_file.id if data_file else None,
        "rootEntityToken": design.rootComponent.entityToken,
        "productType": design.productType,
    }
`;
}

export function createDisposableDocumentScript(marker: string): string {
  return `import adsk.core
import adsk.fusion
import json

def run(_context: str):
    app = adsk.core.Application.get()
    before_count = app.documents.count
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    if not doc:
        raise RuntimeError("Fusion did not create a disposable design document")
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design or app.activeDocument != doc:
        raise RuntimeError("The newly created disposable document is not active")
    if design.designType != adsk.fusion.DesignTypes.ParametricDesignType:
        design.designType = adsk.fusion.DesignTypes.ParametricDesignType
    attr = design.rootComponent.attributes.add(
        ${pyString(MARKER_GROUP)},
        ${pyString(MARKER_NAME)},
        ${pyString(marker)},
    )
    if not attr:
        raise RuntimeError("Fusion did not mark the disposable document")
    data_file = doc.dataFile
    print(json.dumps({
        "probeToken": ${pyString(marker)},
        "documentName": doc.name,
        "dataFileId": data_file.id if data_file else None,
        "rootEntityToken": design.rootComponent.entityToken,
        "productType": design.productType,
        "documentCountBefore": before_count,
        "documentCountAfter": app.documents.count,
        "fusionVersion": app.version,
    }, sort_keys=True))
`;
}

export function inspectEngineeringScript(marker: string, recompute = false): string {
  return `import adsk.core
import adsk.fusion
import json
${commonInspector(marker)}

def _bbox(box):
    if not box:
        return None
    return {"min": _point(box.minPoint), "max": _point(box.maxPoint)}

def run(_context: str):
    app, doc, design = _active_probe()
    if ${recompute ? "True" : "False"}:
        if not design.computeAll():
            raise RuntimeError("Fusion computeAll failed")
    root = design.rootComponent
    parameters = []
    for index in range(design.userParameters.count):
        parameter = design.userParameters.item(index)
        parameters.append({
            "name": parameter.name,
            "expression": parameter.expression,
            "unit": parameter.unit,
            "value": parameter.value,
        })
    sketches = []
    for index in range(root.sketches.count):
        sketch = root.sketches.item(index)
        sketches.append({
            "name": sketch.name,
            "entityToken": sketch.entityToken,
            "curveCount": sketch.sketchCurves.count,
            "profileCount": sketch.profiles.count,
            "dimensionCount": sketch.sketchDimensions.count,
            "constraintCount": sketch.geometricConstraints.count,
        })
    extrudes = []
    for index in range(root.features.extrudeFeatures.count):
        feature = root.features.extrudeFeatures.item(index)
        extrudes.append({
            "name": feature.name,
            "entityToken": feature.entityToken,
            "isSuppressed": feature.isSuppressed,
            "healthState": int(feature.healthState),
        })
    bodies = []
    for index in range(root.bRepBodies.count):
        body = root.bRepBodies.item(index)
        centroid = body.physicalProperties.centerOfMass
        bodies.append({
            "name": body.name,
            "entityToken": body.entityToken,
            "volume": body.volume,
            "area": body.area,
            "centroid": _point(centroid),
            "boundingBox": _bbox(body.boundingBox),
            "faceCount": body.faces.count,
            "edgeCount": body.edges.count,
        })
    snapshot = {
        "designType": int(design.designType),
        "defaultLengthUnits": design.unitsManager.defaultLengthUnits,
        "parameters": sorted(parameters, key=lambda item: item["name"]),
        "sketches": sorted(sketches, key=lambda item: item["name"]),
        "extrudes": sorted(extrudes, key=lambda item: item["name"]),
        "bodies": sorted(bodies, key=lambda item: item["name"]),
    }
    print(json.dumps({"identity": _identity(doc, design), "snapshot": snapshot}, sort_keys=True))
`;
}

export function fingerprintEngineeringScript(marker: string): string {
  return `import adsk.core
import adsk.fusion
import json

def run(_context: str):
    # Chamfer integrity probe ${marker}: token-free engineering fingerprint.
    # This script must never read entityToken (or any other lazily persisted
    # identity): those reads push a new entry onto the native Undo stack, so a
    # verified-rollback loop that used them could never reach the action.
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        raise RuntimeError("No active Fusion design")
    root = design.rootComponent
    parameters = []
    for index in range(design.userParameters.count):
        parameter = design.userParameters.item(index)
        parameters.append({
            "name": parameter.name,
            "expression": parameter.expression,
            "unit": parameter.unit,
            "value": parameter.value,
        })
    sketches = []
    for index in range(root.sketches.count):
        sketch = root.sketches.item(index)
        sketches.append({
            "name": sketch.name,
            "curveCount": sketch.sketchCurves.count,
            "dimensionCount": sketch.sketchDimensions.count,
            "constraintCount": sketch.geometricConstraints.count,
        })
    extrudes = []
    for index in range(root.features.extrudeFeatures.count):
        feature = root.features.extrudeFeatures.item(index)
        extrudes.append({
            "name": feature.name,
            "isSuppressed": feature.isSuppressed,
        })
    bodies = []
    for index in range(root.bRepBodies.count):
        body = root.bRepBodies.item(index)
        bodies.append({
            "name": body.name,
            "volume": body.volume,
            "area": body.area,
            "faceCount": body.faces.count,
            "edgeCount": body.edges.count,
        })
    print(json.dumps({"fingerprint": {
        "designType": int(design.designType),
        "defaultLengthUnits": design.unitsManager.defaultLengthUnits,
        "parameters": sorted(parameters, key=lambda item: item["name"]),
        "sketches": sorted(sketches, key=lambda item: item["name"]),
        "extrudes": sorted(extrudes, key=lambda item: item["name"]),
        "bodies": sorted(bodies, key=lambda item: item["name"]),
    }}, sort_keys=True))
`;
}

export function inspectCameraScript(marker: string): string {
  return `import adsk.core
import adsk.fusion
import json
${commonInspector(marker)}

def run(_context: str):
    app, doc, design = _active_probe()
    camera = app.activeViewport.camera
    print(json.dumps({
        "identity": _identity(doc, design),
        "camera": {
            "eye": _point(camera.eye),
            "target": _point(camera.target),
            "upVector": _point(camera.upVector),
            "cameraType": int(camera.cameraType),
            "perspectiveAngle": camera.perspectiveAngle,
            "viewExtents": camera.viewExtents,
            "isFitView": camera.isFitView,
        },
    }, sort_keys=True))
`;
}

export function restoreCameraScript(marker: string, camera: unknown): string {
  const encoded = JSON.stringify(JSON.stringify(camera));
  return `import adsk.core
import adsk.fusion
import json
${commonInspector(marker)}

def run(_context: str):
    app, doc, design = _active_probe()
    state = json.loads(${encoded})
    camera = app.activeViewport.camera
    camera.isSmoothTransition = False
    camera.eye = adsk.core.Point3D.create(*state["eye"])
    camera.target = adsk.core.Point3D.create(*state["target"])
    camera.upVector = adsk.core.Vector3D.create(*state["upVector"])
    camera.cameraType = state["cameraType"]
    camera.perspectiveAngle = state["perspectiveAngle"]
    camera.viewExtents = state["viewExtents"]
    camera.isFitView = state["isFitView"]
    app.activeViewport.camera = camera
    app.activeViewport.refresh()
    print(json.dumps({"identity": _identity(doc, design)}, sort_keys=True))
`;
}

export function commandMutationScript(marker: string, actionId: string): string {
  const commandId = `ChamferIntegrity_${actionId.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return `import adsk.core
import adsk.fusion
import json
import time
import traceback
${commonInspector(marker)}

_handlers = []
_command = None
_complete = False
_destroyed = False
_error = None

class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        global _complete, _error
        try:
            app, doc, design = _active_probe()
            root = design.rootComponent
            sketch = root.sketches.add(root.xYConstructionPlane)
            sketch.name = ${pyString(`Chamfer integrity ${actionId}`)}
            lines = sketch.sketchCurves.sketchLines
            lines.addTwoPointRectangle(
                adsk.core.Point3D.create(0, 0, 0),
                adsk.core.Point3D.create(2, 1, 0),
            )
            if sketch.profiles.count != 1:
                raise RuntimeError("Integrity action did not create exactly one profile")
            extrude = root.features.extrudeFeatures.addSimple(
                sketch.profiles.item(0),
                adsk.core.ValueInput.createByReal(0.5),
                adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
            )
            if not extrude:
                raise RuntimeError("Integrity action extrusion failed")
            extrude.name = ${pyString(`Chamfer integrity ${actionId}`)}
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
        handler = _ExecuteHandler()
        _command.execute.add(handler)
        _handlers.append(handler)
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
    app, doc, design = _active_probe()
    command_id = ${pyString(commandId)}
    old_definition = app.userInterface.commandDefinitions.itemById(command_id)
    if old_definition:
        old_definition.deleteMe()
    definition = app.userInterface.commandDefinitions.addButtonDefinition(
        command_id,
        "Chamfer integrity action",
        "Disposable transaction probe",
    )
    created = _CreatedHandler()
    definition.commandCreated.add(created)
    _handlers.append(created)
    if not definition.execute():
        definition.deleteMe()
        raise RuntimeError("Fusion refused to start the integrity command")
    deadline = time.time() + 10
    while _command is None and time.time() < deadline:
        adsk.doEvents()
    if _command is None:
        definition.deleteMe()
        raise RuntimeError("Fusion did not create the integrity command")
    if not _command.doExecute(True):
        definition.deleteMe()
        raise RuntimeError("Fusion refused to execute the integrity command")
    while not _complete and time.time() < deadline:
        adsk.doEvents()
    if not _complete:
        definition.deleteMe()
        raise RuntimeError("Fusion integrity command timed out")
    if _error:
        definition.deleteMe()
        raise RuntimeError(_error)
    while not _destroyed and time.time() < deadline:
        adsk.doEvents()
    if not _destroyed:
        definition.deleteMe()
        raise RuntimeError("Fusion integrity command did not finish its transaction")
    definition.deleteMe()
    print(json.dumps({"identity": _identity(doc, design), "commandId": command_id}, sort_keys=True))
`;
}

export function closeDisposableDocumentScript(marker: string): string {
  return `import adsk.core
import adsk.fusion
import json
${commonInspector(marker)}

def run(_context: str):
    app, doc, design = _active_probe()
    identity = _identity(doc, design)
    if not doc.close(False):
        raise RuntimeError("Fusion refused to close the disposable document")
    print(json.dumps({"closed": True, "identity": identity}, sort_keys=True))
`;
}
