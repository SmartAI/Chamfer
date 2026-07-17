import { describe, expect, it } from "vitest";
import { FUSION_ACTION_POLICY_VERSION, validateFusionActionBody } from "./actionPolicy";
import { FUS_IMAGE_001_ACTION_BODY, FUS_TEXT_001_ACTION_BODY, FUS_TEXT_002_ACTION_BODY } from "@chamfer/fusion-fixtures";

describe("Fusion action capability policy", () => {
  it("accepts the reviewed disposable FUS-TEXT-001 fixture action", () => {
    expect(validateFusionActionBody(FUS_TEXT_001_ACTION_BODY)).toEqual({
      ok: true,
      policyVersion: FUSION_ACTION_POLICY_VERSION,
    });
  });

  it("accepts the reviewed disposable FUS-TEXT-002 industrial fixture action", () => {
    expect(validateFusionActionBody(FUS_TEXT_002_ACTION_BODY)).toEqual({
      ok: true,
      policyVersion: FUSION_ACTION_POLICY_VERSION,
    });
  });

  it("accepts the reviewed disposable FUS-IMAGE-001 fixture action", () => {
    expect(validateFusionActionBody(FUS_IMAGE_001_ACTION_BODY)).toEqual({
      ok: true,
      policyVersion: FUSION_ACTION_POLICY_VERSION,
    });
  });

  it("accepts direct reviewed Fusion modeling API code over supplied capabilities", () => {
    expect(validateFusionActionBody(`
import adsk.core
import adsk.fusion

sketch = root.sketches.add(root.xYConstructionPlane)
lines = sketch.sketchCurves.sketchLines
lines.addTwoPointRectangle(
    adsk.core.Point3D.create(0, 0, 0),
    adsk.core.Point3D.create(8, 5, 0),
)
distance = adsk.core.ValueInput.createByString("20 mm")
root.features.extrudeFeatures.addSimple(
    sketch.profiles.item(0),
    distance,
    adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
)
`)).toEqual({ ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION });
  });

  it("accepts the world_to_sketch harness helper for no-guess sketch placement", () => {
    expect(validateFusionActionBody(`
import adsk.core
import adsk.fusion

sketch = root.sketches.add(root.xZConstructionPlane)
centre = world_to_sketch(sketch, 0, 0, 45)
sketch.sketchCurves.sketchCircles.addByCenterRadius(centre, 2.5)
`)).toEqual({ ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION });
  });

  it.each([
    ["filesystem access", "import pathlib\npathlib.Path('/tmp/x').write_text('x')"],
    ["dynamic execution", "eval(action.intent)"],
    ["unreviewed built-ins", "print(action.intent)"],
    ["dunder access", "root.__class__"],
    ["ambient application acquisition", "adsk.core.Application.get()"],
    ["aliased application acquisition", "import adsk.core as core\ncore.Application.get()"],
    ["unbounded loops", "while True:\n    pass"],
    ["unreviewed delete statements", "del references['root']"],
    ["unreviewed decorators", "@staticmethod\ndef build():\n    pass"],
    ["document lifecycle", "document.save('surprise')"],
    ["arbitrary UI commands", "root.parentDesign.parentDocument.parentApplication.userInterface.commandDefinitions.itemById('Save').execute()"],
    ["network access", "import urllib.request\nurllib.request.urlopen('https://example.com')"],
    ["process access", "import subprocess\nsubprocess.run(['sh'])"],
    ["thread access", "import threading\nthreading.Thread(target=build).start()"],
    ["environment access", "import os\nos.environ['TOKEN']"],
    ["native-library access", "import ctypes\nctypes.CDLL('native.so')"],
    ["serialization access", "import pickle\npickle.loads(action.payload)"],
    ["trusted harness serialization access", "payload = json.dumps(action)"],
    ["trusted harness reflection access", "traceback.extract_stack()"],
    ["reflection", "getattr(root, action.member)"],
    ["project data", "root.parentDesign.parentDocument.dataFile.parentProject"],
    ["non-modeling namespace", "import adsk\nadsk.cam.CAM.cast(root.parentDesign)"],
    ["electronics namespace", "import adsk\nadsk.electronics.ElectronicsDesign.cast(root.parentDesign)"],
    ["aliased non-modeling namespace", "from adsk import cam as modeling\nmodeling.CAM.cast(root.parentDesign)"],
    ["filesystem dialog", "adsk.core.FileDialog.create()"],
    ["export manager", "design.exportManager.execute(action.options)"],
    ["transaction event escape", "transaction.firingEvent.sender"],
    ["ambient application capability", "product = app.activeProduct"],
    ["trusted harness application helper", "app2, design2 = (_active_design)()"],
    ["transaction command access", "transaction.command.parentCommandDefinition.execute()"],
  ])("rejects %s before execution", (_label, body) => {
    const result = validateFusionActionBody(body);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ policyVersion: FUSION_ACTION_POLICY_VERSION });
  });

  it("allows the complete published import boundary", () => {
    expect(validateFusionActionBody("import adsk\nimport adsk.core\nimport adsk.fusion\nimport math\nangle = math.radians(45)"))
      .toEqual({ ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION });
  });

  it("allows reviewed symbols imported from a published module", () => {
    expect(validateFusionActionBody("from adsk.core import Point3D\npoint = Point3D.create(0, 0, 0)"))
      .toEqual({ ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION });
    expect(validateFusionActionBody("from adsk import core as fusion_core\npoint = fusion_core.Point3D.create(0, 0, 0)"))
      .toEqual({ ok: true, policyVersion: FUSION_ACTION_POLICY_VERSION });
  });

  it("rejects ambient roots that are neither declared nor supplied capabilities", () => {
    expect(validateFusionActionBody("response = rogue_network.send(action)"))
      .toMatchObject({ ok: false, violations: expect.arrayContaining([
        expect.stringContaining("Ambient capability rogue_network"),
      ]) });
  });

  it("does not treat an attribute receiver as a declared local binding", () => {
    expect(validateFusionActionBody("rogue.network = 1\nrogue.send()"))
      .toMatchObject({ ok: false, violations: expect.arrayContaining([
        expect.stringContaining("Ambient capability rogue"),
      ]) });
  });

  it("rejects unreviewed exports imported from the broad adsk root package", () => {
    expect(validateFusionActionBody("from adsk import drawing as modeling\nmodeling.run()"))
      .toMatchObject({ ok: false, violations: expect.arrayContaining([
        expect.stringContaining("Only adsk.core or adsk.fusion"),
      ]) });
  });

  it.each([
    ["function parameter", "def f(rogue):\n    return rogue\nrogue.send()"],
    ["exception alias", "try:\n    pass\nexcept Exception as rogue:\n    pass\nrogue.send()"],
    ["loop target", "for rogue in []:\n    pass\nrogue.send()"],
  ])("does not leak a %s outside its reviewed lexical region", (_label, body) => {
    expect(validateFusionActionBody(body)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("Ambient capability rogue")]),
    });
  });

  it.each([
    "def f(value=rogue):\n    return value",
    "def f(value: rogue):\n    return value",
  ])("does not mistake parameter metadata for a declared capability", (body) => {
    expect(validateFusionActionBody(body)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("Ambient capability rogue")]),
    });
  });

  it.each([
    "for rogue in rogue.items():\n    pass",
    "values = [rogue for rogue in rogue.items()]",
    "def f(rogue=rogue):\n    return rogue",
    "try:\n    rogue.send()\nexcept Exception as rogue:\n    pass",
  ])("does not authorize a binding before Python makes it available", (body) => {
    expect(validateFusionActionBody(body)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("Ambient capability rogue")]),
    });
  });

  it.each([
    "import adsk\nsdk = adsk\nsdk.drawing.run()",
    "import adsk\nroots = [adsk]\nroots[0].drawing.run()",
  ])("does not allow the restricted Autodesk root to be laundered", (body) => {
    expect(validateFusionActionBody(body)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("Broad Autodesk package")]),
    });
  });

  it.each([
    "import adsk\nadsk.drawing.run()",
    "import adsk as sdk\nsdk.manufacturing.run()",
  ])("rejects non-modeling members reached through the broad adsk root", (body) => {
    expect(validateFusionActionBody(body)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("Broad Autodesk package")]),
    });
  });

  it("rejects invalid Python instead of attempting best-effort filtering", () => {
    expect(validateFusionActionBody("if True print('x')")).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([expect.stringContaining("valid Python")]),
    });
  });
});
