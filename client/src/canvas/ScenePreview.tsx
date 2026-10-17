import { useEffect, useRef, useState } from 'react';
import { StaticCanvas } from 'fabric';
import type { Scene } from '../../../shared/types.ts';
import { syncScene } from './render.ts';

/** Read-only render of a scene, scaled to a fixed width, or to the width of its container when `width` is omitted. */
export function ScenePreview({ scene, width }: { scene: Scene; width?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<StaticCanvas | null>(null);
  const [measured, setMeasured] = useState(0);
  const w = width ?? measured;
  const zoom = w / scene.width;

  useEffect(() => {
    const canvas = new StaticCanvas(elRef.current!, { enableRetinaScaling: true });
    canvasRef.current = canvas;
    return () => {
      canvas.dispose();
    };
  }, []);

  useEffect(() => {
    if (width || !boxRef.current) return;
    const ro = new ResizeObserver(([entry]) => setMeasured(Math.floor(entry.contentRect.width)));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [width]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!w) return;
    canvas.setDimensions({ width: Math.round(scene.width * zoom), height: Math.round(scene.height * zoom) });
    canvas.setZoom(zoom);
    syncScene(canvas, scene);
  }, [scene, zoom, w]);

  if (width) return <canvas ref={elRef} />;
  return (
    <div ref={boxRef} className="scene-fill" style={{ aspectRatio: `${scene.width} / ${scene.height}` }}>
      <canvas ref={elRef} />
    </div>
  );
}
