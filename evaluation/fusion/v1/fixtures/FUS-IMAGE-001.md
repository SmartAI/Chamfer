# FUS-IMAGE-001: Orange ABS right-angle mounting bracket

Mode: image-plus-text-to-CAD
Environment: Autodesk Fusion
Reference asset: `FUS-IMAGE-001-reference.png`
Reference SHA-256: `80bc33c78bcd890486f7b48ed1845491422384d6445428a9575e74f6ec4ab86c`
Expected outcome: completed parametric mechanical part

## User prompt

Use the attached dimensioned drawing as the authoritative geometry reference and model the bracket as one editable parametric Fusion part in millimeters.
Assign ABS plastic as the engineering material and apply an orange appearance with target RGB 240, 100, 20.
Use a native 6 mm inside fillet along the base-to-upright junction.
Use a native 1.5 mm chamfer on exposed outside base and upright edges, excluding every hole edge and the filleted junction.
Preserve design history, use named dimensions where practical, and do not replace the design with direct geometry.

## Drawing interpretation contract

- The base is 100 mm wide, 60 mm deep, and 8 mm thick.
- The upright spans the full 100 mm width, is 8 mm thick, and rises 60 mm above the base top for a total height of 68 mm.
- Two 7 mm diameter through holes pass through the base normal to its top face.
- Base-hole centers are 20 mm and 80 mm from the left edge and 20 mm from the front edge.
- Two 10 mm diameter through holes pass through the upright normal to its front face.
- Upright-hole centers are 25 mm and 75 mm from the left edge and 35 mm above the base top.
- The base-to-upright inside junction has a 6 mm fillet.
- The specified exposed outside edges have a 1.5 mm chamfer.

## Required checks

- The reference image is classified, its readable dimensions are captured as source-linked specifications, and its front, top, and right-side views are registered consistently.
- Exactly one connected valid solid body exists in one eligible Fusion part document.
- Base and upright extents and thicknesses match the drawing within 0.05 mm.
- Base and upright hole diameters and center positions match the drawing within 0.05 mm.
- Native feature history contains editable base, upright, holes, 6 mm inside fillet, and 1.5 mm chamfer intent.
- The material resolves to installed ABS plastic or a version-mapped canonical equivalent with recorded provenance.
- The appearance is orange and its recorded target is RGB 240, 100, 20, separately from the engineering material.
- Standardized inspection views show no unexplained silhouette, orientation, feature-placement, or proportion mismatch against the drawing.
- Typed checks, visual-verification coverage, and the Fusion design revision all concern the same resulting document state.
- Every completed Chamfer modeling action contributes exactly one native Undo entry.

## Forbidden outcomes

- Guessing over a readable drawing dimension, silently weakening a dimension, or omitting a requested hole or edge treatment does not satisfy the fixture.
- Reversing the upright, placing holes on the wrong face, swapping base and upright hole sizes, or measuring upright height from the wrong datum does not satisfy the fixture.
- A mesh, direct-modeling replacement, history-free body, wrong material, missing appearance, displaced camera, wrong document mutation, or unsupported verification claim is an integrity failure.
