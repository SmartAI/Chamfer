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
import { Box, Download, Focus, Grid3x3, LoaderCircle, Rotate3d, Scan } from "lucide-react";
import type * as THREE from "three";
import { technicalEdges } from "./meshToGeometry";
import { EXPORT_FORMATS, exportModelBlob, type ExportFormatId } from "./exportModel";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

const AUTO_ROTATE_DEFAULT_SPEED = 2.5;
const AUTO_ROTATE_MIN_SPEED = 0.5;
const AUTO_ROTATE_MAX_SPEED = 10;

interface ViewerProps {
  geometry: THREE.BufferGeometry | null;
  /** Raw bytes of the loaded artifact; enables the export menu when present. */
  artifactData?: ArrayBuffer | null;
  /** Filename stem for exported files (e.g. the conversation title's slug). */
  exportName?: string;
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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Viewer({ geometry, artifactData = null, exportName = "model" }: ViewerProps) {
  const [projection, setProjection] = useState<Projection>("perspective");
  const [showEdges, setShowEdges] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [autoRotateSpeed, setAutoRotateSpeed] = useState(AUTO_ROTATE_DEFAULT_SPEED);
  const [fitRequest, setFitRequest] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormatId | null>(null);

  // A cleared workspace (conversation switch) takes the export menu with it.
  useEffect(() => {
    if (!geometry || !artifactData) setExportOpen(false);
  }, [geometry, artifactData]);

  function selectProjection(next: Projection) {
    setProjection(next);
    setFitRequest((value) => value + 1);
  }

  async function exportAs(format: ExportFormatId) {
    if (!geometry || !artifactData || exporting) return;
    setExporting(format);
    try {
      downloadBlob(await exportModelBlob(format, { artifactData, geometry }), `${exportName}.${format}`);
      setExportOpen(false);
    } catch {
      // Conversion failures leave the menu open so the user can pick STL,
      // which never converts and cannot fail.
    } finally {
      setExporting(null);
    }
  }

  return (
    <div
      data-testid="viewer"
      data-has-geometry={geometry !== null}
      data-projection={projection}
      data-edges={showEdges}
      data-auto-rotate={autoRotate}
      data-auto-rotate-speed={autoRotateSpeed}
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
          autoRotate={autoRotate}
          autoRotateSpeed={autoRotateSpeed}
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
        <ProjectionButton
          active={autoRotate}
          label="Toggle auto-rotate"
          onClick={() => setAutoRotate((value) => !value)}
        >
          <Rotate3d className="h-4 w-4" />
        </ProjectionButton>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          data-testid="viewer-export"
          aria-label="Export model"
          title="Export model"
          aria-expanded={exportOpen}
          disabled={!geometry || !artifactData}
          onClick={() => setExportOpen((value) => !value)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
            exportOpen && "bg-foreground text-background hover:bg-foreground hover:text-background",
          )}
        >
          <Download className="h-4 w-4" />
        </button>
      </div>

      {(autoRotate || exportOpen) && (
        <div className="absolute left-3 top-14 z-10 flex flex-col items-start gap-2">
          {autoRotate && (
            <div
              data-testid="auto-rotate-speed"
              className="flex w-44 items-center gap-2 rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur-sm"
            >
              <Rotate3d className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Slider
                min={AUTO_ROTATE_MIN_SPEED}
                max={AUTO_ROTATE_MAX_SPEED}
                step={0.5}
                value={[autoRotateSpeed]}
                onValueChange={(next) => {
                  if (next[0] !== undefined) setAutoRotateSpeed(next[0]);
                }}
                aria-label="Auto-rotate speed"
                className="min-w-0"
              />
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {autoRotateSpeed.toFixed(1)}
              </span>
            </div>
          )}
          {exportOpen && (
            <div
              data-testid="viewer-export-menu"
              className="w-48 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur-sm"
            >
              {EXPORT_FORMATS.map((format) => (
                <button
                  key={format.id}
                  type="button"
                  data-testid={`viewer-export-${format.id}`}
                  disabled={exporting !== null}
                  onClick={() => void exportAs(format.id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  {exporting === format.id ? (
                    <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="font-medium">{format.label}</span>
                  <span className="ml-auto text-muted-foreground">{format.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
