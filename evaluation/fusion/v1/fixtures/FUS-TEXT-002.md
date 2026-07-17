# FUS-TEXT-002: Industrial conveyor bearing support housing

Mode: text-to-CAD
Environment: Autodesk Fusion
Expected outcome: completed parametric mechanical part
Industry context: finish-machined bearing housing for a conveyor drive shaft

## User prompt

Create a single-solid parametric bearing support housing for an industrial conveyor shaft in millimeters.
The housing will be finish-machined from a ductile-iron near-net blank, so preserve native Fusion feature history and organize the model around the datum scheme below.

Use the bottom mounting face as datum A.
Use the front face of the upright bearing wall as datum B.
Use the left end face of the base as datum C.

Create a base plate 180 mm wide along X, 110 mm deep along Y, and 16 mm thick along Z.
Center the base about X and Y with its bottom face at Z equals 0.
Apply a 5 mm fillet to the four vertical base corner edges.

Create a centered upright bearing wall on the base.
Make the wall 24 mm thick along Y and 110 mm wide along X.
From the top of the base, extend its rectangular lower profile 60 mm to the bearing centerline.
Complete the top with a semicircular crown of 55 mm outer radius centered on the bearing axis, giving a crown top at Z equals 131 mm.

Cut a through bearing seat along Y at X equals 0 and Z equals 76 mm.
The finished bearing-seat diameter must remain within 52.000 to 52.030 mm and its nominal parameter must be 52 mm.
Add a 62 mm diameter retaining recess from datum B only, 5 mm deep into the wall.
Do not mirror the retaining recess onto the back face.

Add four 11 mm diameter through mounting holes in the base at X equals plus or minus 70 mm and Y equals plus or minus 35 mm.
Counterbore each mounting hole from the base top to 18 mm diameter and 8 mm depth for socket-head fasteners.

Add four triangular reinforcing gussets connecting the upright wall to the base.
Place one front and one rear gusset at each of X equals plus or minus 45 mm.
Make each gusset 12 mm wide along X, extend it from the wall face at Y equals plus or minus 12 mm to Y equals plus or minus 45 mm, and make it rise 45 mm above the base top at the wall.
Each gusset must join both the base and upright into the same solid body.

Add a vertical M6 by 1 threaded grease port at X equals 0 and Y equals 0 from the crown top into the bearing seat.
Represent it with native threaded-hole intent and verify that its drilled passage connects to the bearing seat.

Apply 6 mm structural fillets along the accessible wall-to-base and gusset-root junctions.
Apply a 1 mm by 45 degree chamfer at both bearing-seat mouths.
Apply a 0.5 mm entry chamfer to the grease port.
Apply a 2 mm chamfer along the exposed top outer perimeter of the base, stopping cleanly at the corner fillets and excluding mounting-hole edges.

Assign EN-GJS-500-7 ductile cast iron as the engineering material, or use the installed canonical ductile-iron equivalent while recording the mapping.
Apply a dark machine-gray appearance with target RGB 65, 72, 78 separately from the material.
The completed design must remain one connected solid with editable dimensions, holes, recess, gussets, fillets, chamfers, and threaded-hole intent.

## Required checks

- Exactly one connected valid solid body exists in one eligible Fusion part document.
- Datum A, datum B, and datum C are represented by stable named construction or reference geometry suitable for later inspection and revision.
- Base extents are 180 by 110 by 16 mm within 0.05 mm, with the bottom face at the declared datum.
- The upright wall is 24 mm thick, 110 mm wide, and centered on the base within 0.05 mm.
- The bearing axis is at X equals 0 and Z equals 76 mm within 0.02 mm relative to the declared datums.
- The bearing seat remains within 52.000 to 52.030 mm diameter and retains a named nominal parameter of 52 mm.
- The outer crown has 55 mm nominal radius and reaches Z equals 131 mm within 0.05 mm.
- The front retaining recess has 62 mm diameter and 5 mm depth within 0.05 mm and exists on datum B only.
- Four base mounting holes have 11 mm through diameter and datum-relative centers at X equals plus or minus 70 mm and Y equals plus or minus 35 mm within 0.05 mm.
- Each mounting hole has an 18 mm diameter, 8 mm deep counterbore from the base top within 0.05 mm.
- Four 12 mm wide triangular gussets occupy the specified X and Y locations, rise 45 mm at the wall, and join both the wall and base without creating extra bodies.
- The vertical M6 by 1 grease port retains native threaded-hole intent and its drilled passage intersects the bearing seat.
- Native feature history contains editable wall, bore, one-sided retaining recess, mounting holes, counterbores, gussets, 6 mm structural fillets, bearing-mouth chamfers, grease-port chamfer, and 2 mm base-perimeter chamfer intent.
- The material resolves to EN-GJS-500-7 ductile cast iron or a recorded installed canonical equivalent with appropriate physical-property provenance.
- The appearance is dark machine gray and its recorded target is RGB 65, 72, 78, separately from the engineering material.
- Standardized inspection views and a section view expose the bearing seat, one-sided recess, counterbores, gusset attachment, and grease-port connection.
- Typed checks, material evidence, appearance evidence, standardized views, and the Fusion design revision all concern the same resulting document state.
- Every completed Chamfer modeling action contributes exactly one native Undo entry.

## Forbidden outcomes

- A simplified pillow block, rectangular wall without the specified crown, missing gusset, or disconnected rib does not satisfy the fixture.
- A bearing seat outside the declared acceptance range or detached from its named nominal parameter does not satisfy the fixture.
- A retaining recess on both faces, on the wrong face, or cut through the wall does not satisfy the fixture.
- A grease port that lacks native thread intent, stops before the bearing seat, or enters from another location does not satisfy the fixture.
- Plain holes without the required counterbores, reversed counterbores, or incorrect datum-relative patterns do not satisfy the fixture.
- Cosmetic edge shading without native fillet and chamfer features does not satisfy the fixture.
- A mesh, direct-modeling replacement, history-free body, incorrect material, missing appearance, wrong-document mutation, displaced camera, or unsupported verification claim is an integrity failure.
