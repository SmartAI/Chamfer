# Week-scale test suite: two-stage helical gearbox

A single coherent design that would take an expert ~1 week in professional CAD, decomposed
into ~20 individual parts. **Each part is one Chamfer conversation.** Run them hardest-first:
if the housing and shafts complete as clean single solids, that is a real milestone at 2-3x
the scale of the motor-controller baseplate.

## How to use
- One part per conversation (Chamfer builds one editable solid per run).
- Paste the prompt verbatim; each is self-contained and dimensioned.
- Difficulty: **Core** should complete; **Hard** will strain plan coherence, patterns, and
  non-interference; **Stretch** is a deliberate limit-finder (true involute gears, freeform).
- The assembly step (mating, bolt-up, gear meshing across parts) is beyond one conversation
  today - that gap is itself useful signal, not a failure.

Reference bar already in the repo: `evaluation/fusion/v1/industrial-recovery.json` (10 graded
engineering single parts). The housing below is formalized as a graded case in
`evaluation/fusion/v1/gearbox-housing.case.json`.

---

## Subsystem 1 - Housing (the flagship stress tests)

### 1. Main housing body — Hard/flagship (~40 features)
*Stresses: 3 bearing bores with H7 fits and non-interference, perimeter bolt flange, internal ribs, feet, oil bosses, cast fillet chains.*
> Design the main housing body of a two-stage helical gearbox, one cast-aluminum solid, roughly 260 x 180 x 160 mm. A hollow box with 6 mm walls, open on the right side where a bolted cover mates. On the left wall: an input bearing bore 40 mm H7 and an output bearing bore 80 mm H7; on the internal partition, an intermediate bearing bore 62 mm H7. Bore centers in the wall plane: input (0, 120), intermediate (70, 80), output (150, 60) mm - keep the three bores non-interfering. A full-perimeter bolted flange on the open face, 8 mm thick, with twelve M6 through-holes at 25 mm pitch and a 2 mm sealing lip. Two base mounting feet, each 40 x 30 mm with two 13 mm slotted holes. Four 6 mm internal ribs webbing the bearing bosses to the walls. An M20 oil-fill/breather boss on top, an M12 drain boss at the lowest point, a 34 mm sight-glass boss on the front. Cast fillets R4 on internal junctions, R2 external edge breaks. 6061 aluminum, media-blasted appearance. Keep it one solid; verify with the top and section views that the three bearing bores, ribs, and bosses do not interfere.

### 2. Bearing end cover — Hard (~16 features)
*Stresses: bolt circle that must match part 1, bearing seat, seal recess.*
> Design the bolted end cover for a gearbox, one aluminum solid, a 200 x 160 mm plate 10 mm thick with rounded corners R12. A central bearing counterbore 80 mm diameter x 12 mm deep on the inner face, with a concentric radial-lip-seal recess 62 mm x 8 mm behind it and a 45 mm through-bore for the shaft. Twelve M6 clearance holes (6.6 mm) on the perimeter at 25 mm pitch matching the housing flange, each counterbored 11 mm x 6 mm on the outer face. A 2 mm sealing groove around the mating face. Two 8 mm H7 dowel-pin holes diagonally for alignment. Break all edges 1 mm. 6061 aluminum.

### 3. Inspection/oil-level cover — Core (~10 features)
*Stresses: gasket flange, small bolt pattern.*
> Design a rectangular inspection cover, one aluminum solid, 90 x 60 mm x 5 mm with rounded corners R8. Six M4 clearance holes 6 mm in from the edges. A 2 mm raised sealing rim on the underside 3 mm in from the perimeter. A tapped M10 breather hole in the center. Chamfer top edges 1 mm.

---

## Subsystem 2 - Shafts (revolve + steps + keyways + integral gears)

### 4. Input pinion shaft — Hard (~14 features)
*Stresses: revolve, stepped diameters, keyway, integral helical pinion (stretch teeth).*
> Design an input pinion shaft, one steel solid, revolved along a 180 mm axis. Diameters left-to-right: 25 mm x 30 mm long (bearing seat), 20 mm x 40 mm (seal/coupling with a 6 x 6 mm parallel keyway 30 mm long), stepping up to a 40 mm x 45 mm integral pinion blank, then 25 mm x 25 mm (second bearing seat), then 22 mm x 15 mm end. Cut 17 helical teeth (module 2, 15-degree helix) into the pinion blank as real trapezoidal teeth in a circular pattern. Chamfer both shaft ends 1.5 mm x 45deg and add a 0.5 mm undercut relief at each shoulder. Alloy steel.

### 5. Intermediate (layshaft) gear shaft — Hard (~18 features)
*Stresses: two gear features on one shaft, spacing, keyways.*
> Design the intermediate layshaft of a two-stage gearbox, one steel solid revolved along a 200 mm axis. From left: 30 mm bearing seat x 30 mm, then a 90 mm x 30 mm integral first-stage gear blank (43 trapezoidal teeth, module 2), a 20 mm plain spacer, a 50 mm x 25 mm integral second-stage pinion blank (19 teeth, module 3), then a 30 mm bearing seat x 25 mm and a 25 mm end. A 8 x 7 mm keyway is not needed (gears integral). Chamfer ends and relieve shoulders 0.5 mm. Keep the two gear blanks non-interfering with 20 mm clear spacer between them.

### 6. Output gear shaft — Hard (~13 features)
*Stresses: large integral gear, output coupling interface.*
> Design the output shaft, one steel solid revolved along a 210 mm axis. From left: 40 mm bearing seat x 35 mm, a 140 mm x 35 mm integral output gear blank (57 trapezoidal teeth, module 3), a 40 mm bearing seat x 30 mm, then a 35 mm x 60 mm output coupling stub with a 10 x 8 mm parallel keyway and an M10 center tap 25 mm deep. Chamfer the coupling end 2 mm and both bearing seats 1.5 mm.

---

## Subsystem 3 - Gears as separate parts (Stretch - true gear geometry)

### 7. First-stage helical gear — Stretch (~14 features)
*Stresses: circular tooth pattern; true involute is the hard part.*
> Design a helical gear as one steel solid: a 90 mm pitch-diameter blank 24 mm wide, module 2, 43 teeth cut as a 43-fold circular pattern of trapezoidal teeth 4 mm deep with a 15-degree helix. A 30 mm H7 bore with a 8 x 3.3 mm keyway. Three 20 mm lightening holes on a 55 mm circle. Chamfer both faces 1 mm and break the tooth-tip edges. *(If involute is out of reach, trapezoidal teeth are acceptable for the test.)*

### 8. Second-stage output gear — Stretch (~14 features)
> Design a large helical output gear, one steel solid: 174 mm pitch diameter, 30 mm wide, module 3, 57 trapezoidal teeth in a circular pattern, 6 mm deep, 15-degree helix. A 40 mm H7 bore with a 12 x 3.3 mm keyway. Six 28 mm lightening holes on a 110 mm circle with a 12 mm web. Chamfer faces 1.5 mm.

---

## Subsystem 4 - Rotating hardware (revolves + threads)

### 9. Radial lip oil seal — Core (~7 features)
> Design a radial shaft oil seal, one solid, revolved: 62 mm outer diameter, 45 mm shaft bore, 8 mm wide, with an outer press-fit band, an internal sealing lip that necks to 44 mm, and a garter-spring groove behind the lip. Chamfer the leading edges. Model as one elastomer-style solid.

### 10. Deep-groove ball bearing (representative) — Hard (~10 features)
*Stresses: concentric revolves, raceway grooves; balls as a circular pattern.*
> Design a representative 6208 deep-groove ball bearing as one solid for fit-checking: 80 mm outer diameter, 40 mm bore, 18 mm wide. An outer ring and inner ring separated by a raceway, with a semicircular ball groove in each, and twelve 11 mm balls in a 12-fold circular pattern seated in the raceway. Chamfer the ring bores 1 mm. (One fused solid is fine - this is an envelope/fit part.)

### 11. Parallel key (DIN 6885) — Core (~4 features)
> Design a parallel machine key, one steel solid, 10 x 8 x 40 mm with both ends rounded R5 and top edges chamfered 0.5 mm.

### 12. External retaining ring (DIN 471) — Hard (~6 features)
*Stresses: thin C-shaped profile, lug holes.*
> Design an external circlip for a 40 mm shaft, one spring-steel solid: a 37.5 mm inner-diameter C-ring, 1.75 mm thick, 3.8 mm radial section tapering toward the open ends, with a 2 mm gap and two 1.7 mm lug holes at the ends. Break edges 0.2 mm.

---

## Subsystem 5 - Fittings and fasteners (small threaded parts)

### 13. Magnetic drain plug — Core (~7 features)
> Design a magnetic oil drain plug, one steel solid: an M12 x 1.5 external thread 14 mm long, a 19 mm across-flats hex head 8 mm thick with a sealing washer seat, and a 8 mm x 6 mm magnet pocket bored into the threaded end. Chamfer the thread start and hex edges.

### 14. Breather vent plug — Core (~7 features)
> Design a gearbox breather plug, one solid: an M20 x 1.5 external thread 12 mm long, a 24 mm hex flange, a domed cap 22 mm diameter x 10 mm tall with four 2 mm side vent slots and a 4 mm labyrinth cap gap. Chamfer thread start.

### 15. Oil sight glass — Core (~8 features)
> Design a threaded oil sight glass body, one solid: an M33 x 2 external thread 10 mm long, a 40 mm hex flange, and a 24 mm stepped bore holding a viewing window with a retaining lip. Two O-ring grooves. Chamfer edges.

### 16. Hex-head cap screw M6x20 — Core (~5 features)
> Design an ISO 4014 hex-head cap screw, one steel solid: M6 x 1 thread on a 20 mm shank (16 mm threaded), a 10 mm across-flats hex head 4 mm thick with a chamfered top, and a chamfered thread start.

### 17. Dowel pin — Core (~3 features)
> Design a cylindrical dowel pin, one hardened-steel solid, 8 mm m6 diameter x 30 mm long with both ends chamfered 1.2 mm x 45deg and a slight crown.

---

## Subsystem 6 - Interface and misc

### 18. Output coupling flange — Hard (~12 features)
*Stresses: bore + keyway + bolt circle + hub.*
> Design an output coupling flange, one steel solid: a 120 mm diameter plate 15 mm thick with a 50 mm long x 60 mm diameter hub. A 35 mm H7 bore through hub and plate with a 10 x 3.3 mm keyway and a radial M8 set-screw tap into the keyway. Six M10 clearance holes on a 90 mm bolt circle. Chamfer the bore mouth and outer edges 2 mm.

### 19. Mounting foot spacer / shim — Core (~3 features)
> Design a stepped alignment shim, one steel solid, a 60 x 40 mm plate 2 mm thick with two 13 mm slots matching the housing feet and a 0.5 mm raised locating pad on top.

### 20. Rating nameplate — Core (~6 features)
> Design a gearbox rating nameplate, one thin aluminum solid, 80 x 50 mm x 1.2 mm with rounded corners R4, a 1 mm recessed bordered field, embossed text "RATIO 12.5:1" raised 0.4 mm, and four 3 mm corner rivet holes. Brushed appearance.

---

## Assembly-level checks (beyond one conversation - track as a finding)
Once the parts exist, the true week-scale test is whether they *fit*: the cover bolt circle
matches the housing; the three shafts drop into their bores; gear pairs mesh at the 95 mm and
other center distances; seals and bearings press into their seats. Chamfer builds these as
separate solids today, so mating/meshing verification is the next capability boundary. A
week-scale design is the cleanest way to expose exactly where that boundary sits.
