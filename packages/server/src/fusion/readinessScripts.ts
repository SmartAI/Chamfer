export {
  captureInspectionCameraScript as captureCameraScript,
  restoreInspectionCameraScript as restoreCameraScript,
} from "./inspectionScripts";

export function inspectReadinessScript(): string {
  return `# CHAMFER_FUSION_READINESS_V1
import adsk.core
import adsk.fusion
import json

def run(_context: str):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not doc or not design:
        print(json.dumps({"fusionVersion": app.version, "document": None, "inspectorHealthy": True}))
        return
    data_file = doc.dataFile
    root = design.rootComponent
    identity = doc.creationId
    open_document_ids = [app.documents.item(index).creationId for index in range(app.documents.count)]
    active_command = app.userInterface.activeCommand
    print(json.dumps({
        "fusionVersion": app.version,
        "document": {
            "id": identity,
            "name": doc.name,
            "dataFileId": data_file.id if data_file else None,
            "versionId": data_file.versionId if data_file else None,
            "versionNumber": data_file.versionNumber if data_file else None,
        },
        "openDocumentIds": open_document_ids,
        "documentMatchesBinding": True,
        "writable": not bool(data_file and data_file.isReadOnly),
        "isModified": bool(doc.isModified),
        "busy": active_command not in ("", "SelectCommand", "OrbitCommand", "FreeOrbitCommand", "PanCommand", "ZoomCommand", "FitCommand", "LookAtCommand", "ViewCubeCommand"),
        "supported": design.designType == adsk.fusion.DesignTypes.ParametricDesignType,
        "inspectorHealthy": bool(root.entityToken),
    }, sort_keys=True))
`;
}
