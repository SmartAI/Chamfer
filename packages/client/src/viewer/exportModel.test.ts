import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry } from "three";
import { exportModelBlob } from "./exportModel";

/** jsdom's Blob has no arrayBuffer()/text(); FileReader is the portable read. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function triangleGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

describe("exportModelBlob", () => {
  it("hands out the artifact bytes unmodified as STL", async () => {
    const artifactData = new Uint8Array([1, 2, 3, 4]).buffer;
    const blob = await exportModelBlob("stl", { artifactData, geometry: triangleGeometry() });

    expect(blob.type).toBe("model/stl");
    expect(await blobBytes(blob)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("converts the geometry to Wavefront OBJ text", async () => {
    const blob = await exportModelBlob("obj", {
      artifactData: new ArrayBuffer(0),
      geometry: triangleGeometry(),
    });

    const text = new TextDecoder().decode(await blobBytes(blob));
    expect(text).toContain("v 0 0 0");
    expect(text).toContain("f ");
  });

  it("converts the geometry to binary glTF", async () => {
    const blob = await exportModelBlob("glb", {
      artifactData: new ArrayBuffer(0),
      geometry: triangleGeometry(),
    });

    const magic = new TextDecoder().decode((await blobBytes(blob)).slice(0, 4));
    expect(magic).toBe("glTF");
    expect(blob.type).toBe("model/gltf-binary");
  });
});
