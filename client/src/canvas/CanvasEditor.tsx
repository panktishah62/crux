import { useEffect, useRef, useState } from 'react';
import { Canvas, InteractiveFabricObject, cache, type Textbox } from 'fabric';
import { nanoid } from 'nanoid';
import { useEditor } from '../store.ts';
import { patchFromObject, syncScene, type LayerObject } from './render.ts';
import type { ImageLayer } from '../../../shared/types.ts';

InteractiveFabricObject.ownDefaults = {
  ...InteractiveFabricObject.ownDefaults,
  borderColor: '#7C5CFF',
  cornerColor: '#FFFFFF',
  cornerStrokeColor: '#7C5CFF',
  cornerStyle: 'circle',
  cornerSize: 11,
  transparentCorners: false,
  borderScaleFactor: 1.5,
  padding: 0,
};

/** Shared handle so the toolbar can export the canvas at native resolution. */
export const editorHandle: { canvas: Canvas | null; zoom: number } = { canvas: null, zoom: 1 };

export function exportPng(): string | null {
  const c = editorHandle.canvas;
  if (!c) return null;
  const active = c.getActiveObject();
  c.discardActiveObject();
  c.renderAll();
  const url = c.toDataURL({ format: 'png', multiplier: 1 / editorHandle.zoom });
  if (active) c.setActiveObject(active);
  c.requestRenderAll();
  return url;
}

export function CanvasEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [fontEpoch, setFontEpoch] = useState(0);
  const scene = useEditor((s) => s.scene);
  const selectedId = useEditor((s) => s.selectedId);

  useEffect(() => {
    const canvas = new Canvas(canvasElRef.current!, {
      preserveObjectStacking: true,
      selection: false,
      controlsAboveOverlay: true,
      enableRetinaScaling: true,
    });
    fabricRef.current = canvas;
    editorHandle.canvas = canvas;

    const onSelect = () => {
      const obj = canvas.getActiveObject() as LayerObject | undefined;
      useEditor.getState().select(obj?.layerId ?? null);
    };
    canvas.on('selection:created', onSelect);
    canvas.on('selection:updated', onSelect);
    canvas.on('selection:cleared', () => useEditor.getState().select(null));

    canvas.on('object:modified', ({ target }) => {
      const obj = target as LayerObject;
      const { scene, updateLayer } = useEditor.getState();
      const layer = scene.layers.find((l) => l.id === obj.layerId);
      if (layer) updateLayer(layer.id, patchFromObject(obj, layer));
    });

    canvas.on('text:editing:exited', ({ target }) => {
      const obj = target as unknown as Textbox & LayerObject;
      const { scene, updateLayer } = useEditor.getState();
      const layer = scene.layers.find((l) => l.id === obj.layerId);
      if (layer?.type === 'text' && obj.text !== (layer.uppercase ? layer.text.toUpperCase() : layer.text)) {
        updateLayer(layer.id, { text: obj.text, height: Math.round(obj.height) });
      }
    });

    const onFontsLoaded = () => {
      cache.clearFontCache();
      for (const obj of canvas.getObjects() as LayerObject[]) {
        if (obj.type === 'textbox' || obj.type === 'group') obj.signature = undefined;
      }
      setFontEpoch((n) => n + 1);
    };
    document.fonts.addEventListener('loadingdone', onFontsLoaded);

    return () => {
      document.fonts.removeEventListener('loadingdone', onFontsLoaded);
      editorHandle.canvas = null;
      canvas.dispose();
    };
  }, []);

  // Fit the artboard into the available space.
  useEffect(() => {
    const el = containerRef.current!;
    const fit = () => {
      const pad = 64;
      const z = Math.min((el.clientWidth - pad) / scene.width, (el.clientHeight - pad) / scene.height, 1);
      setZoom(Math.max(0.1, z));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [scene.width, scene.height]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    canvas.setDimensions({ width: Math.round(scene.width * zoom), height: Math.round(scene.height * zoom) });
    canvas.setZoom(zoom);
    editorHandle.zoom = zoom;
    canvas.requestRenderAll();
  }, [zoom, scene.width, scene.height]);

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    syncScene(canvas, scene, { interactive: true, selectedId }).then((heights) => {
      if (heights) useEditor.getState().reportHeights(heights);
    });
  }, [scene, selectedId, fontEpoch]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData('application/x-asset-id');
    if (!assetId) return;
    const { kit, addLayer, select } = useEditor.getState();
    const asset = kit.assets.find((a) => a.id === assetId);
    const canvasEl = canvasElRef.current;
    if (!asset || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const width = Math.round(scene.width * (asset.category === 'logo' ? 0.22 : 0.35));
    const height = Math.round(width * ((asset.height ?? 1) / (asset.width ?? 1)));
    const x = Math.round((e.clientX - rect.left) / zoom - width / 2);
    const y = Math.round((e.clientY - rect.top) / zoom - height / 2);
    const layer: ImageLayer = {
      id: `ast_${nanoid(5)}`, type: 'image', name: asset.category, role: asset.category === 'logo' ? 'logo' : 'decoration',
      x, y, width, height, src: asset.url, assetId: asset.id, fit: 'contain',
    };
    addLayer(layer);
    select(layer.id);
  };

  return (
    <div className="canvas-stage" ref={containerRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="artboard" style={{ width: Math.round(scene.width * zoom), height: Math.round(scene.height * zoom) }}>
        <canvas ref={canvasElRef} />
      </div>
      <div className="zoom-badge">
        {scene.width}×{scene.height} · {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}
