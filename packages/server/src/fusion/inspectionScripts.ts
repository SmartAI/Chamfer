import { engineeringFingerprintCollector } from "./integrityScripts";

function pythonString(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

const cameraHelpers = `
def _point(value):
    return [value.x, value.y, value.z]

def _camera(camera):
    return {
        "eye": _point(camera.eye),
        "target": _point(camera.target),
        "upVector": _point(camera.upVector),
        "cameraType": int(camera.cameraType),
        "perspectiveAngle": camera.perspectiveAngle,
        "viewExtents": camera.viewExtents,
        "isFitView": camera.isFitView,
        "isSmoothTransition": camera.isSmoothTransition,
    }
`;

export function engineeringSnapshotScript(): string {
  return `# CHAMFER_FUSION_ENGINEERING_SNAPSHOT_V1
import adsk.core
import adsk.fusion
import json
${engineeringFingerprintCollector}
ATTR_GROUP = "com.chamfer.entity"
ATTR_NAME = "uuid"
ATTR_DESCRIPTOR = "semantic"

def _token(entity):
    try:
        return entity.entityToken or ""
    except:
        return ""

def _chamfer_identity(entity):
    try:
        attribute = entity.attributes.itemByName(ATTR_GROUP, ATTR_NAME)
        descriptor = entity.attributes.itemByName(ATTR_GROUP, ATTR_DESCRIPTOR)
        return (attribute.value if attribute else None, descriptor.value if descriptor else None)
    except:
        return (None, None)

def _entity(kind, entity, fallback, semantic_descriptor):
    token = _token(entity)
    chamfer_id, stored_descriptor = _chamfer_identity(entity)
    return {
        "kind": kind,
        "id": ("chamfer:" + chamfer_id) if chamfer_id else fallback,
        "name": entity.name,
        "nativeToken": token,
        "chamferId": chamfer_id,
        "semanticDescriptor": stored_descriptor or semantic_descriptor,
    }

def _round(value):
    return round(float(value), 9)

def _signature_value(value):
    if isinstance(value, bool) or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return _round(value)
    if isinstance(value, (list, tuple)):
        return [_signature_value(item) for item in value]
    if all(hasattr(value, axis) for axis in ("x", "y", "z")):
        return [_round(value.x), _round(value.y), _round(value.z)]
    if hasattr(value, "count") and hasattr(value, "item"):
        return [_signature_value(value.item(index)) for index in range(value.count)]
    return None

def _curve_signature(curve):
    geometry = curve.geometry
    data = {
        "isConstruction": bool(curve.isConstruction),
        "isFixed": bool(curve.isFixed),
    }
    for key in (
        "startPoint", "endPoint", "center", "radius", "startAngle", "endAngle",
        "majorAxis", "majorRadius", "minorRadius", "degree", "isClosed", "isPeriodic",
        "controlPoints", "fitPoints", "knots", "weights",
    ):
        try:
            value = _signature_value(getattr(geometry, key))
            if value is not None:
                data[key] = value
        except:
            pass
    return {"type": curve.objectType.split("::")[-1], "data": data}

def _reference_key(entity, curve_refs, point_refs):
    token = _token(entity)
    if token in curve_refs:
        return curve_refs[token]
    if token in point_refs:
        return point_refs[token]
    return None

def _constraint_detail(constraint, curve_refs, point_refs, parameter=None):
    references = []
    for key in (
        "entityOne", "entityTwo", "curveOne", "curveTwo", "line", "point",
        "firstEntity", "secondEntity", "thirdEntity",
    ):
        try:
            reference = _reference_key(getattr(constraint, key), curve_refs, point_refs)
            if reference and reference not in references:
                references.append(reference)
        except:
            pass
    detail = {"type": constraint.objectType.split("::")[-1], "references": references}
    if parameter:
        detail["parameter"] = parameter
    return detail

def _body_geometry_signature(body):
    face_areas = []
    surface_types = []
    for index in range(body.faces.count):
        face = body.faces.item(index)
        face_areas.append(_round(face.area * 100.0))
        surface_types.append(face.geometry.objectType.split("::")[-1])
    edge_lengths = [_round(body.edges.item(index).length * 10.0) for index in range(body.edges.count)]
    box = body.preciseBoundingBox
    center = body.physicalProperties.centerOfMass
    return {
        "faceCount": body.faces.count,
        "edgeCount": body.edges.count,
        "faceAreasMm2": sorted(face_areas),
        "edgeLengthsMm": sorted(edge_lengths),
        "boundingBoxMinMm": [_round(box.minPoint.x * 10.0), _round(box.minPoint.y * 10.0), _round(box.minPoint.z * 10.0)],
        "boundingBoxMaxMm": [_round(box.maxPoint.x * 10.0), _round(box.maxPoint.y * 10.0), _round(box.maxPoint.z * 10.0)],
        "centerOfMassMm": [_round(center.x * 10.0), _round(center.y * 10.0), _round(center.z * 10.0)],
        "bodyRevisionId": body.revisionId,
        "surfaceTypes": sorted(surface_types),
    }

def _bbox_mm(body):
    box = body.boundingBox
    return [
        (box.maxPoint.x - box.minPoint.x) * 10.0,
        (box.maxPoint.y - box.minPoint.y) * 10.0,
        (box.maxPoint.z - box.minPoint.z) * 10.0,
    ]

def _appearance_rgb(appearance):
    if not appearance:
        return None
    try:
        properties = appearance.appearanceProperties
        for index in range(properties.count):
            prop = properties.item(index)
            try:
                color = prop.value
                if all(hasattr(color, channel) for channel in ("red", "green", "blue")):
                    return [int(color.red), int(color.green), int(color.blue)]
            except:
                pass
    except:
        pass
    return None

def _sketch_plane(sketch):
    try:
        return sketch.referencePlane.name
    except:
        try:
            return sketch.referencePlane.objectType.split("::")[-1]
        except:
            return ""

def run(_context: str):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not doc or not design:
        raise RuntimeError("No active Fusion design")
    data_file = doc.dataFile
    root = design.rootComponent
    units = design.unitsManager
    parameters = []
    entities = [_entity("component", root, "root-component", "component:" + root.name)]
    for index in range(design.allParameters.count):
        parameter = design.allParameters.item(index)
        identity = _entity("parameter", parameter, "parameter:%s" % parameter.name, "parameter:" + parameter.name)
        parameter_id = identity["id"]
        try:
            value_mm = units.convert(parameter.value, "cm", "mm")
        except:
            value_mm = parameter.value
        parameter_record = {
            "id": parameter_id,
            "name": parameter.name,
            "expression": parameter.expression,
            "valueMm": value_mm,
            "unit": parameter.unit,
        }
        if parameter.unit in ("deg", "rad"):
            try:
                parameter_record["valueDegrees"] = units.convert(parameter.value, "rad", "deg")
            except:
                pass
        parameters.append(parameter_record)
        entities.append(identity)

    sketches = []
    for index in range(root.sketches.count):
        sketch = root.sketches.item(index)
        identity = _entity("sketch", sketch, "sketch:%d" % index, "sketch:" + sketch.name + "@" + _sketch_plane(sketch))
        sketch_id = identity["id"]
        curve_refs = {}
        geometry = []
        for curve_index in range(sketch.sketchCurves.count):
            curve = sketch.sketchCurves.item(curve_index)
            curve_refs[_token(curve)] = "curve:%d" % curve_index
            geometry.append(_curve_signature(curve))
        point_refs = {}
        for point_index in range(sketch.sketchPoints.count):
            point_refs[_token(sketch.sketchPoints.item(point_index))] = "point:%d" % point_index
        constraint_types = []
        constraint_details = []
        dimension_expressions = []
        for constraint_index in range(sketch.geometricConstraints.count):
            constraint = sketch.geometricConstraints.item(constraint_index)
            constraint_types.append(constraint.objectType.split("::")[-1])
            constraint_details.append(_constraint_detail(constraint, curve_refs, point_refs))
        for dimension_index in range(sketch.sketchDimensions.count):
            dimension = sketch.sketchDimensions.item(dimension_index)
            dimension_expressions.append(dimension.parameter.expression if dimension.parameter else "")
            constraint_details.append(_constraint_detail(
                dimension, curve_refs, point_refs, dimension.parameter.name if dimension.parameter else None,
            ))
        sketches.append({
            "id": sketch_id,
            "name": sketch.name,
            "plane": _sketch_plane(sketch),
            "profiles": sketch.profiles.count,
            "curves": sketch.sketchCurves.count,
            "constraints": constraint_types,
            "geometry": geometry,
            "constraintDetails": constraint_details,
            "dimensionExpressions": sorted(dimension_expressions),
            "fullyConstrained": bool(sketch.isFullyConstrained),
        })
        entities.append(identity)

    references = []
    for index in range(root.constructionPlanes.count):
        reference = root.constructionPlanes.item(index)
        references.append({
            "id": "construction-plane:%d" % index,
            "name": reference.name,
            "type": "plane",
            "originMm": [_round(reference.geometry.origin.x * 10.0), _round(reference.geometry.origin.y * 10.0), _round(reference.geometry.origin.z * 10.0)],
            "normal": [_round(reference.geometry.normal.x), _round(reference.geometry.normal.y), _round(reference.geometry.normal.z)],
        })

    features = []
    holes = []
    feature_measurements = []
    for index in range(root.features.count):
        feature = root.features.item(index)
        identity = _entity("feature", feature, "feature:%d" % index, "feature:" + feature.objectType.split("::")[-1] + ":" + feature.name)
        feature_id = identity["id"]
        features.append({
            "id": feature_id,
            "name": feature.name,
            "type": feature.objectType.split("::")[-1],
            "timelineIndex": feature.timelineObject.index if feature.timelineObject else index,
            "suppressed": bool(feature.isSuppressed),
        })
        entities.append(identity)
        if feature.objectType.endswith("HoleFeature"):
            try:
                diameter_mm = feature.holeDiameter.value * 10.0
                extent = feature.extentDefinition
                through = extent.objectType.endswith("AllExtentDefinition")
                if not through:
                    try:
                        body_box = root.bRepBodies.item(0).boundingBox
                        body_depth = (body_box.maxPoint.z - body_box.minPoint.z) * 10.0
                        through = extent.distance.value * 10.0 >= body_depth - 0.001
                    except:
                        pass
                if not through:
                    try:
                        body_box = root.bRepBodies.item(0).boundingBox
                        for face_index in range(feature.sideFaces.count):
                            face_box = feature.sideFaces.item(face_index).boundingBox
                            spans_body = face_box.minPoint.z <= body_box.minPoint.z + 0.0001 and face_box.maxPoint.z >= body_box.maxPoint.z - 0.0001
                            if spans_body:
                                through = True
                                break
                    except:
                        pass
                position_definition = feature.holePositionDefinition
                point = position_definition.sketchPoint.worldGeometry if hasattr(position_definition, "sketchPoint") else position_definition.point
                if not through:
                    try:
                        body_box = root.bRepBodies.item(0).boundingBox
                        side_min_z = min(feature.sideFaces.item(side_index).boundingBox.minPoint.z for side_index in range(feature.sideFaces.count))
                        side_max_z = max(feature.sideFaces.item(side_index).boundingBox.maxPoint.z for side_index in range(feature.sideFaces.count))
                        through = side_min_z <= body_box.minPoint.z + 0.0001 and side_max_z >= point.z - 0.0001
                    except:
                        pass
                normal = None
                try:
                    planar = position_definition.planarEntity
                    if planar.objectType.endswith("BRepFace"):
                        success, normal = planar.evaluator.getNormalAtPoint(point)
                        if not success:
                            normal = None
                    else:
                        normal = planar.geometry.normal
                except:
                    sketch = position_definition.sketchPoint.parentSketch
                    normal = sketch.xDirection.crossProduct(sketch.yDirection)
                if normal is None:
                    raise RuntimeError("native hole orientation was not available")
                normal.normalize()
                holes.append({
                    "featureId": feature_id,
                    "name": feature.name,
                    "centerMm": [_round(point.x * 10.0), _round(point.y * 10.0), _round(point.z * 10.0)],
                    "diameterMm": _round(diameter_mm),
                    "through": through,
                    "counterboreDiameterMm": _round(feature.counterboreDiameter.value * 10.0) if feature.holeType == adsk.fusion.HoleTypes.CounterboreHoleType else None,
                    "counterboreDepthMm": _round(feature.counterboreDepth.value * 10.0) if feature.holeType == adsk.fusion.HoleTypes.CounterboreHoleType else None,
                    "direction": "negative" if feature.direction.z < 0 else "positive",
                    "normal": [_round(normal.x), _round(normal.y), _round(normal.z)],
                })
            except:
                pass
        if feature.objectType.endswith("ExtrudeFeature") and feature.name == "Upright Wall and Crown":
            try:
                sketch = feature.profile.parentSketch
                profile_box = feature.profile.boundingBox
                arcs = sketch.sketchCurves.sketchArcs
                crown = max((arcs.item(arc_index) for arc_index in range(arcs.count)), key=lambda arc: arc.radius)
                center = sketch.sketchToModelSpace(crown.centerSketchPoint.geometry)
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "housing-profile",
                    "centerMm": [_round(center.x * 10.0), _round(center.y * 10.0), _round(center.z * 10.0)],
                    "widthMm": _round((profile_box.maxPoint.x - profile_box.minPoint.x) * 10.0),
                    "thicknessMm": _round(feature.extentOne.distance.value * 10.0),
                    "crownRadiusMm": _round(crown.radius * 10.0),
                })
            except Exception as error:
                feature_measurements.append({"featureId": feature_id, "kind": "housing-profile", "error": str(error)})
        if feature.objectType.endswith("ExtrudeFeature") and feature.name in ("Bearing Seat", "Retaining Recess - Datum B Only"):
            try:
                profile_box = feature.profile.boundingBox
                extent = feature.extentOne
                is_bore = feature.name == "Bearing Seat"
                sketch = feature.profile.parentSketch
                local_center = adsk.core.Point3D.create(
                    (profile_box.minPoint.x + profile_box.maxPoint.x) / 2.0,
                    (profile_box.minPoint.y + profile_box.maxPoint.y) / 2.0,
                    0,
                )
                world_center = sketch.sketchToModelSpace(local_center)
                plane = sketch.referencePlane
                plane_name = plane.name if hasattr(plane, "name") else None
                normal = plane.geometry.normal
                end_offsets_mm = []
                for end_face_index in range(feature.endFaces.count):
                    end_point = feature.endFaces.item(end_face_index).pointOnFace
                    end_offsets_mm.append(((end_point.x - world_center.x) * normal.x + (end_point.y - world_center.y) * normal.y + (end_point.z - world_center.z) * normal.z) * 10.0)
                symmetric = bool(end_offsets_mm) and min(end_offsets_mm) < -0.001 and max(end_offsets_mm) > 0.001
                direction = "symmetric" if symmetric else ("positive" if max(end_offsets_mm, default=0) > 0 else "negative")
                wall_thickness = next((parameter.value * 10.0 for parameter in design.userParameters if parameter.name == "wall_thickness"), 0.0)
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "bore" if is_bore else "recess",
                    "centerMm": [
                        _round(world_center.x * 10.0),
                        _round(world_center.y * 10.0),
                        _round(world_center.z * 10.0),
                    ],
                    "diameterMm": _round(max(
                        profile_box.maxPoint.x - profile_box.minPoint.x,
                        profile_box.maxPoint.y - profile_box.minPoint.y,
                    ) * 10.0),
                    "depthMm": _round(max(end_offsets_mm) - min(end_offsets_mm)) if len(end_offsets_mm) > 1 else _round(abs(extent.distance.value) * 10.0),
                    "axis": "y" if abs(plane.geometry.normal.y) >= 0.999 else ("x" if abs(plane.geometry.normal.x) >= 0.999 else "z"),
                    "direction": direction,
                    "through": symmetric and min(end_offsets_mm) <= -wall_thickness / 2.0 and max(end_offsets_mm) >= wall_thickness / 2.0,
                    "datumName": plane_name,
                })
            except:
                pass
        if feature.objectType.endswith("ExtrudeFeature") and feature.name.startswith("Gusset "):
            try:
                sketch = feature.profile.parentSketch
                plane = sketch.referencePlane
                center_x = plane.geometry.origin.x * 10.0
                profile_box = feature.profile.boundingBox
                side_y = profile_box.minPoint.y * 10.0 if abs(profile_box.minPoint.y) < abs(profile_box.maxPoint.y) else profile_box.maxPoint.y * 10.0
                base_z = min(-profile_box.minPoint.x, -profile_box.maxPoint.x) * 10.0
                height = abs(profile_box.maxPoint.x - profile_box.minPoint.x) * 10.0
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "gusset",
                    "centerMm": [_round(center_x), _round(side_y), _round(base_z)],
                    "widthMm": _round(feature.extentOne.distance.value * 10.0),
                    "heightMm": _round(height),
                    "connectedBodyCount": root.bRepBodies.count,
                })
            except:
                pass
        if feature.objectType.endswith("HoleFeature") and feature.name == "Grease Port M6x1":
            try:
                position_definition = feature.holePositionDefinition
                point = position_definition.sketchPoint.worldGeometry if hasattr(position_definition, "sketchPoint") else position_definition.point
                thread = feature.thread
                thread_designation = thread.threadInfo.threadDesignation if thread else None
                thread_pitch = _round(thread.threadInfo.threadPitch * 10.0) if thread else None
                direction_vector = feature.direction
                axis_values = {"x": abs(direction_vector.x), "y": abs(direction_vector.y), "z": abs(direction_vector.z)}
                axis = max(axis_values, key=axis_values.get)
                signed_direction = getattr(direction_vector, axis)
                depth_mm = feature.extentDefinition.distance.value * 10.0
                seat = root.features.extrudeFeatures.itemByName("Bearing Seat")
                seat_box = seat.profile.boundingBox if seat else None
                seat_sketch = seat.profile.parentSketch if seat else None
                seat_center = seat_sketch.sketchToModelSpace(adsk.core.Point3D.create((seat_box.minPoint.x + seat_box.maxPoint.x) / 2.0, (seat_box.minPoint.y + seat_box.maxPoint.y) / 2.0, 0)) if seat_box else None
                intersects_seat = bool(seat_center) and min(point.z, point.z + direction_vector.z * depth_mm / 10.0) <= seat_center.z <= max(point.z, point.z + direction_vector.z * depth_mm / 10.0)
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "threaded-hole",
                    "centerMm": [_round(point.x * 10.0), _round(point.y * 10.0), _round(point.z * 10.0)],
                    "diameterMm": _round(feature.holeDiameter.value * 10.0),
                    "pitchMm": thread_pitch,
                    "axis": axis,
                    "direction": "positive" if signed_direction > 0 else "negative",
                    "threadDesignation": thread_designation,
                    "intersectsFeature": "Bearing Seat" if intersects_seat else None,
                })
            except:
                pass
        if feature.objectType.endswith("ExtrudeFeature") and feature.name == "Centered Pocket":
            try:
                profile_box = feature.profile.boundingBox
                extent = feature.extentOne
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "pocket",
                    "centerMm": [
                        _round((profile_box.minPoint.x + profile_box.maxPoint.x) * 5.0),
                        _round((profile_box.minPoint.y + profile_box.maxPoint.y) * 5.0),
                        _round((profile_box.minPoint.z + profile_box.maxPoint.z) * 5.0),
                    ],
                    "diameterMm": _round(max(
                        profile_box.maxPoint.x - profile_box.minPoint.x,
                        profile_box.maxPoint.y - profile_box.minPoint.y,
                    ) * 10.0),
                    "depthMm": _round(abs(extent.distance.value) * 10.0),
                })
            except:
                pass
        if feature.objectType.endswith("FilletFeature"):
            try:
                radius_candidates = []
                for parameter_index in range(root.modelParameters.count):
                    parameter = root.modelParameters.item(parameter_index)
                    if _token(parameter.createdBy) == _token(feature) and parameter.unit in ("mm", "cm", "m", "in", "ft"):
                        radius_candidates.append(abs(parameter.value) * 10.0)
                if not radius_candidates:
                    raise RuntimeError("native fillet model parameter was not found")
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "fillet",
                    "radiusMm": _round(min(radius_candidates)),
                    "faceCount": feature.faces.count,
                    "faceBoundsMm": [{"min": [_round(face.boundingBox.minPoint.x * 10.0), _round(face.boundingBox.minPoint.y * 10.0), _round(face.boundingBox.minPoint.z * 10.0)], "max": [_round(face.boundingBox.maxPoint.x * 10.0), _round(face.boundingBox.maxPoint.y * 10.0), _round(face.boundingBox.maxPoint.z * 10.0)]} for face in feature.faces],
                })
            except Exception as error:
                feature_measurements.append({"featureId": feature_id, "kind": "fillet", "error": str(error)})
        if feature.objectType.endswith("ChamferFeature"):
            try:
                distance_candidates = []
                for parameter_index in range(root.modelParameters.count):
                    parameter = root.modelParameters.item(parameter_index)
                    if _token(parameter.createdBy) == _token(feature) and parameter.unit in ("mm", "cm", "m", "in", "ft"):
                        distance_candidates.append(abs(parameter.value) * 10.0)
                if not distance_candidates:
                    raise RuntimeError("native chamfer model parameter was not found")
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "chamfer",
                    "distanceMm": _round(min(distance_candidates)),
                    "faceCount": feature.faces.count,
                    "faceBoundsMm": [{"min": [_round(face.boundingBox.minPoint.x * 10.0), _round(face.boundingBox.minPoint.y * 10.0), _round(face.boundingBox.minPoint.z * 10.0)], "max": [_round(face.boundingBox.maxPoint.x * 10.0), _round(face.boundingBox.maxPoint.y * 10.0), _round(face.boundingBox.maxPoint.z * 10.0)]} for face in feature.faces],
                })
            except Exception as error:
                feature_measurements.append({"featureId": feature_id, "kind": "chamfer", "error": str(error)})
        if feature.objectType.endswith("CircularPatternFeature"):
            try:
                if not feature.quantity:
                    raise RuntimeError("native circular pattern quantity was not found")
                feature_measurements.append({
                    "featureId": feature_id,
                    "kind": "circular-pattern",
                    "occurrenceCount": int(round(feature.quantity.value)),
                })
            except Exception as error:
                feature_measurements.append({"featureId": feature_id, "kind": "circular-pattern", "error": str(error)})

    bodies = []
    materials = {}
    for index in range(root.bRepBodies.count):
        body = root.bRepBodies.item(index)
        identity = _entity("body", body, "body:%d" % index, "body:" + body.name)
        body_id = identity["id"]
        material = body.material
        appearance = body.appearance
        bodies.append({
            "id": body_id,
            "name": body.name,
            "solid": bool(body.isSolid),
            "volumeMm3": body.volume * 1000.0,
            "boundingBoxMm": _bbox_mm(body),
            "material": material.name if material else None,
            "appearance": appearance.name if appearance else None,
            "appearanceColor": _appearance_rgb(appearance),
            "geometrySignature": _body_geometry_signature(body),
        })
        if material:
            material_library = getattr(material, "parent", None)
            materials[material.id] = {
                "id": material.id,
                "name": material.name,
                "libraryName": getattr(material_library, "name", None),
            }
        entities.append(identity)

    snapshot = {
        "designIntent": {
            "designType": "parametric" if design.designType == adsk.fusion.DesignTypes.ParametricDesignType else "direct",
            "rootComponent": root.name,
            "timelineMarker": design.timeline.markerPosition,
        },
        "units": {"distance": units.defaultLengthUnits, "angle": "deg", "internalDistance": "cm"},
        "parameters": parameters,
        "sketches": sketches,
        "features": features,
        "bodies": bodies,
        "materials": list(materials.values()),
        "holes": holes,
        "featureMeasurements": feature_measurements,
        "references": references,
        "entities": entities,
    }
    print(json.dumps({
        "document": {
            "id": doc.creationId,
            "name": doc.name,
            "dataFileId": data_file.id if data_file else None,
        },
        "snapshot": snapshot,
        "fingerprint": _chamfer_engineering_fingerprint(design),
    }, sort_keys=True))
`;
}

export function captureInspectionCameraScript(): string {
  return `# CHAMFER_FUSION_INSPECTION_CAMERA_V1
import adsk.core
import json
${cameraHelpers}
def run(_context: str):
    app = adsk.core.Application.get()
    print(json.dumps({"camera": _camera(app.activeViewport.camera)}, sort_keys=True))
`;
}

export function showInspectionSectionScript(expectedDocument?: unknown): string {
  return `# CHAMFER_FUSION_SECTION_SHOW_V1
import adsk.core
import adsk.fusion
import json
def run(_context: str):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    expected = json.loads(${pythonString(expectedDocument ?? null)})
    data_file = doc.dataFile if doc else None
    if expected and (not doc or (data_file.id != expected.get("dataFileId") if expected.get("dataFileId") else doc.creationId != expected.get("id"))):
        print(json.dumps({"activated": False, "reason": "wrong-document"}, sort_keys=True)); return
    design = adsk.fusion.Design.cast(app.activeProduct)
    analyses = design.analyses
    sections = analyses.sectionAnalyses
    state = {"analysesVisible": analyses.isLightBulbOn, "sections": []}
    activated = False
    for index in range(sections.count):
        section = sections.item(index)
        state["sections"].append({"name": section.name, "visible": section.isLightBulbOn})
        visible = section.name == "FUS-TEXT-002 Bearing Section"
        section.isLightBulbOn = visible
        activated = activated or visible
    analyses.isLightBulbOn = True
    app.activeViewport.refresh()
    state["activated"] = activated
    print(json.dumps(state, sort_keys=True))
`;
}

export function restoreInspectionSectionsScript(state: unknown, expectedDocument?: unknown): string {
  return `# CHAMFER_FUSION_SECTION_RESTORE_V1
import adsk.core
import adsk.fusion
import json
def run(_context: str):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    expected = json.loads(${pythonString(expectedDocument ?? null)})
    data_file = doc.dataFile if doc else None
    if expected and (not doc or (data_file.id != expected.get("dataFileId") if expected.get("dataFileId") else doc.creationId != expected.get("id"))):
        print(json.dumps({"restored": False, "reason": "wrong-document"}, sort_keys=True)); return
    saved = json.loads(${pythonString(state)})
    design = adsk.fusion.Design.cast(app.activeProduct)
    analyses = design.analyses
    sections = analyses.sectionAnalyses
    visibility = {item["name"]: item["visible"] for item in saved.get("sections", [])}
    for index in range(sections.count):
        section = sections.item(index)
        if section.name in visibility: section.isLightBulbOn = visibility[section.name]
    analyses.isLightBulbOn = saved.get("analysesVisible", True)
    app.activeViewport.refresh()
    print(json.dumps({"restored": True}, sort_keys=True))
`;
}

export function inspectionDocumentIdentityScript(): string {
  return `# CHAMFER_FUSION_INSPECTION_DOCUMENT_V1
import adsk.core
import json

def run(_context: str):
    app = adsk.core.Application.get()
    doc = app.activeDocument
    if not doc:
        print(json.dumps({"document": None}, sort_keys=True))
        return
    data_file = doc.dataFile
    print(json.dumps({"document": {
        "id": doc.creationId,
        "name": doc.name,
        "dataFileId": data_file.id if data_file else None,
    }}, sort_keys=True))
`;
}

export function restoreInspectionCameraScript(camera: unknown, expectedDocument?: unknown): string {
  return `# CHAMFER_FUSION_CAMERA_RESTORE_V1
import adsk.core
import json
${cameraHelpers}
def run(_context: str):
    app = adsk.core.Application.get()
    expected_document = json.loads(${pythonString(expectedDocument ?? null)})
    if expected_document:
        doc = app.activeDocument
        data_file = doc.dataFile if doc else None
        matches = bool(doc) and (
            data_file.id == expected_document.get("dataFileId")
            if expected_document.get("dataFileId")
            else doc.creationId == expected_document.get("id")
        )
        if not matches:
            print(json.dumps({"restored": False, "reason": "wrong-document"}, sort_keys=True))
            return
    state = json.loads(${pythonString(camera)})
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
    camera = app.activeViewport.camera
    camera.isSmoothTransition = state["isSmoothTransition"]
    app.activeViewport.camera = camera
    app.activeViewport.refresh()
    print(json.dumps({"restored": True}, sort_keys=True))
`;
}
