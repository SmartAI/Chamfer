---
name: build123d
description: Use registered build123d tools to make named solid components, measure dimensions/volume/clearances/connectivity, validate solids, then export STEP with component names and colours preserved.
required_capabilities: build123d
---

Use build123d capability tools only when registered.

Quality checklist:

- Read available build123d MCP references, such as `build123d://quickref`, before
  writing nontrivial build code when `read_mcp_resource` is available.
- Model in millimeters and encode requested dimensions explicitly.
- Build named final components instead of anonymous temporary solids.
- Measure the resulting model: bounding boxes, volumes, hole diameters/positions,
  clearances, component counts, and any task-specific capacity or fit requirement.
- For assemblies, verify intended contact or clearance between components. Check
  for floating unintended parts, unwanted intersections/crossovers, and unstitched
  gaps in geometry that should be joined.
- Validate every final solid or final assembly before export.
- Repair invalid solids, missing features, wrong sizes, or wrong component counts
  before exporting. Also repair disconnected parts, bad clearances, unwanted
  intersections, and unstitched gaps when geometry tools can detect them.
- Export durable artifacts, preferably STEP. For named multi-component products,
  export the named final objects rather than only a fused aggregate.
- Report measured evidence and known STEP limitations, such as preserved RGB
  colours versus unsupported procedural material textures.
