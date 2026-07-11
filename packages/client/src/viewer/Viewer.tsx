import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import {
  Bounds,
  GizmoHelper,
  GizmoViewcube,
  Grid,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
  useBounds,
} from "@react-three/drei";
import { Box, Focus, Grid3x3, Scan } from "lucide-react";
import type * as THREE from "three";
import { technicalEdges } from "./meshToGeometry";
import { cn } from "@/lib/utils";

interface ViewerProps {
  geometry: THREE.BufferGeometry | null;
}

type Projection = "orthographic" | "perspective";

/** Technical-edge overlay: a line-segment rendering of the geometry's sharp edges. */
function EdgeOverlay({ geometry }: { geometry: THREE.BufferGeometry }) {
  const edges = useMemo(() => technicalEdges(geometry), [geometry]);

  useEffect(() => () => edges.dispose(), [edges]);

  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial color="#1f2937" transparent opacity={0.72} />
    </lineSegments>
  );
}

function FitModel({
  geometry,
  request,
  projection,
}: {
  geometry: THREE.BufferGeometry;
  request: number;
  projection: Projection;
}) {
  const bounds = useBounds();

  useEffect(() => {
    bounds.refresh().clip().fit();
  }, [bounds, geometry, projection, request]);

  return null;
}

function Model({
  geometry,
  fitRequest,
  projection,
  showEdges,
}: {
  geometry: THREE.BufferGeometry;
  fitRequest: number;
  projection: Projection;
  showEdges: boolean;
}) {
  return (
    <Bounds margin={1.5} observe>
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <mesh geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial color="#8b9bad" metalness={0.08} roughness={0.68} />
        </mesh>
        {showEdges && <EdgeOverlay geometry={geometry} />}
      </group>
      <FitModel geometry={geometry} request={fitRequest} projection={projection} />
    </Bounds>
  );
}

function ProjectionButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-foreground text-background hover:bg-foreground hover:text-background",
      )}
    >
      {children}
    </button>
  );
}

export function Viewer({ geometry }: ViewerProps) {
  const [projection, setProjection] = useState<Projection>("orthographic");
  const [showEdges, setShowEdges] = useState(true);
  const [fitRequest, setFitRequest] = useState(0);

  function selectProjection(next: Projection) {
    setProjection(next);
    setFitRequest((value) => value + 1);
  }

  return (
    <div
      data-testid="viewer"
      data-has-geometry={geometry !== null}
      data-projection={projection}
      data-edges={showEdges}
      className="relative h-full w-full overflow-hidden bg-[#f4f5f7]"
    >
      <Canvas shadows dpr={[1, 2]}>
        <color attach="background" args={["#f4f5f7"]} />
        {projection === "orthographic" ? (
          <OrthographicCamera makeDefault position={[100, 100, 100]} near={0.1} far={10000} />
        ) : (
          <PerspectiveCamera makeDefault position={[100, 100, 100]} fov={42} near={0.1} far={10000} />
        )}
        <hemisphereLight intensity={1.4} color="#ffffff" groundColor="#cbd5e1" />
        <directionalLight position={[80, 120, 90]} intensity={2.2} castShadow />
        <directionalLight position={[-60, 40, -40]} intensity={0.7} />
        <Grid
          infiniteGrid
          cellSize={10}
          sectionSize={50}
          cellColor="#c7ccd2"
          sectionColor="#9ca3af"
          fadeDistance={800}
          fadeStrength={1.5}
        />
        {geometry && (
          <Model geometry={geometry} fitRequest={fitRequest} projection={projection} showEdges={showEdges} />
        )}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          zoomToCursor
          minDistance={0.1}
          maxDistance={10000}
        />
        <GizmoHelper alignment="top-right" margin={[64, 64]}>
          <GizmoViewcube color="#ffffff" hoverColor="#22d3ee" textColor="#111827" />
        </GizmoHelper>
      </Canvas>

      <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          data-testid="viewer-fit"
          aria-label="Fit model to view"
          title="Fit model to view"
          disabled={!geometry}
          onClick={() => setFitRequest((value) => value + 1)}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <Focus className="h-4 w-4" />
        </button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <ProjectionButton
          active={projection === "orthographic"}
          label="Orthographic view"
          onClick={() => selectProjection("orthographic")}
        >
          <Scan className="h-4 w-4" />
        </ProjectionButton>
        <ProjectionButton
          active={projection === "perspective"}
          label="Perspective view"
          onClick={() => selectProjection("perspective")}
        >
          <Box className="h-4 w-4" />
        </ProjectionButton>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <ProjectionButton
          active={showEdges}
          label="Toggle edge lines"
          onClick={() => setShowEdges((value) => !value)}
        >
          <Grid3x3 className="h-4 w-4" />
        </ProjectionButton>
      </div>
    </div>
  );
}
