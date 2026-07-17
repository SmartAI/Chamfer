# FUS-TEXT-001: Blue aluminum CNC mounting plate

Mode: text-to-CAD
Environment: Autodesk Fusion
Expected outcome: completed parametric mechanical part

## User prompt

Create a single-solid CNC mounting plate in millimeters.
Make the finished plate 120 mm long, 80 mm wide, and 12 mm thick.
Add four 8.5 mm diameter through holes whose centers are 12 mm from their two nearest outer edges.
Add a centered 40 mm diameter circular pocket that is 4 mm deep from the top face.
Apply a 4 mm fillet to the four vertical outer corner edges.
Apply a 1.5 mm chamfer to the remaining top and bottom outer perimeter edges, excluding every hole and pocket edge.
Assign Aluminum 6061 as the engineering material and apply a blue anodized appearance with target RGB 30, 90, 180.
Keep the dimensions, holes, pocket, fillet, and chamfer editable as native parametric Fusion features.
Preserve design history and use one connected solid body.

## Required checks

- Exactly one connected valid solid body exists in one eligible Fusion part document.
- Overall extents are 120 by 80 by 12 mm within 0.05 mm.
- Four through holes have 8.5 mm diameter within 0.02 mm and centers 12 mm from their adjacent nominal edges within 0.05 mm.
- One centered pocket has 40 mm diameter and 4 mm depth within 0.05 mm.
- Native feature history contains editable hole, pocket, 4 mm fillet, and 1.5 mm chamfer intent.
- The material resolves to an installed Aluminum 6061 engineering material or a version-mapped canonical equivalent with recorded provenance.
- The appearance is blue and its recorded target is RGB 30, 90, 180, separately from the engineering material.
- Typed checks, standardized inspection views, and the Fusion design revision all concern the same resulting document state.
- Every completed Chamfer modeling action contributes exactly one native Undo entry.

## Forbidden outcomes

- A mesh, direct-modeling replacement, or history-free body does not satisfy the fixture.
- Omitting or weakening a requested dimension, fillet, chamfer, material, or appearance does not satisfy the fixture.
- Coloring an unassigned material or assigning aluminum without the requested appearance does not satisfy the fixture.
- Rebuilding unrelated existing history, mutating another document, leaving camera state displaced, or claiming unsupported verification is an integrity failure.
