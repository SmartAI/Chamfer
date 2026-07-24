import { Mesh, MeshStandardMaterial, Object3D, type BufferGeometry } from "three";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

export type ExportFormatId = "stl" | "obj" | "glb";

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  /** Shown next to the format name in the export menu. */
  hint: string;
}

/** STL first: it is the kernel's own export, byte-for-byte; the others are
 * mesh conversions done in the browser from the already-loaded geometry. */
export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "stl", label: "STL", hint: "Original CAD export" },
  { id: "obj", label: "OBJ", hint: "Wavefront mesh" },
  { id: "glb", label: "GLB", hint: "Binary glTF" },
];

export interface ExportSource {
  /** Raw bytes of the agent's contracted STL export. */
  artifactData: ArrayBuffer;
  /** The viewer geometry parsed from those bytes; source for conversions. */
  geometry: BufferGeometry;
}

export async function exportModelBlob(format: ExportFormatId, source: ExportSource): Promise<Blob> {
  switch (format) {
    case "stl":
      return new Blob([source.artifactData], { type: "model/stl" });
    case "obj": {
      const text = new OBJExporter().parse(new Mesh(source.geometry));
      return new Blob([text], { type: "model/obj" });
    }
    case "glb": {
      // glTF mandates +Y up while build123d exports Z-up, so the node carries
      // the same rotation the viewer applies for display.
      const root = new Object3D();
      root.rotation.x = -Math.PI / 2;
      root.add(new Mesh(source.geometry, new MeshStandardMaterial({ color: "#8b9bad", metalness: 0.08, roughness: 0.68 })));
      const buffer = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
      return new Blob([buffer], { type: "model/gltf-binary" });
    }
  }
}
