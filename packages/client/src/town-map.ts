/**
 * The town map: a layout drawn on a canvas, with pan and zoom, a scale bar,
 * lots that can be clicked, and a tool that shows the walking path between
 * two lots.
 *
 * It draws what the layout format holds and nothing more: water, segments as
 * polylines of their own width, and lots as polygons.
 */
import type { District, Layout, LayoutPath, Lot, Point } from '@worldsim/core';
import { h } from './dom.ts';
import { describePath, districtColours, fitBox, formatMetres, lotAt, scaleBar } from './town-format.ts';
import { type View, panBy, toMap, toScreen, zoomAt } from './view.ts';

const LAND = '#f4f1e8';
const WATER = '#9cc3e6';
const INK = '#23272e';
const SEGMENT_COLOURS: Record<Layout['segments'][number]['kind'], string> = {
  arterial: '#8a5a2b',
  street: '#b9b4a8',
  lane: '#d2cec3',
  bridge: '#c0392b',
};
const CLICK_SLOP = 4;

export interface TownMap {
  /** Shows a layout, fitted to the canvas. */
  show(layout: Layout, districts: District[]): void;
  /** Shows a message in place of a map, while loading or on failure. */
  message(text: string): void;
  /** Outlines the lot of a building, or clears the outline. */
  highlight(buildingId: string | undefined): void;
}

export interface TownMapHandlers {
  onLotClick(lot: Lot): void;
  /** Asked for the walking path between two lots. */
  findPath(fromLotId: string, toLotId: string): Promise<LayoutPath>;
}

export function createTownMap(root: HTMLElement, handlers: TownMapHandlers): TownMap {
  const canvas = h('canvas', { attrs: { 'aria-label': 'Town map' } });
  const note = h('p', { class: 'map-note' });
  const pathButton = h('button', { attrs: { type: 'button' }, title: 'Show the shortest walking path between two lots' }, 'Path');
  const fitButton = h('button', { attrs: { type: 'button' }, title: 'Show the whole town' }, '⌂');
  const pathStatus = h('span', { class: 'path-status' });
  root.replaceChildren(canvas, note, h('div', { class: 'map-tools' }, fitButton, pathButton, pathStatus));
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  let layout: Layout | undefined;
  let districtNames = new Map<string, string>();
  /** Paths are built once per layout, in map coordinates, and redrawn under the view's transform. */
  let lotPaths: Array<{ colour: string; path: Path2D }> = [];
  let segmentPaths: Array<{ colour: string; width: number; path: Path2D }> = [];
  let view: View = { scale: 1, x: 0, y: 0 };
  let fitScale = 1;
  let size = { width: 0, height: 0 };
  let highlighted: Lot | undefined;
  let path: LayoutPath | undefined;
  /** The path tool: off, or waiting for its first or second lot. */
  let picking: { from?: Lot; to?: Lot } | undefined;
  let frame = 0;

  const trace = (target: Path2D | CanvasRenderingContext2D, points: readonly Point[], close: boolean) => {
    points.forEach(([x, y], index) => (index === 0 ? target.moveTo(x, y) : target.lineTo(x, y)));
    if (close) target.closePath();
  };

  function draw(): void {
    frame = 0;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = LAND;
    ctx.fillRect(0, 0, size.width, size.height);
    if (!layout) return;

    ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    const px = 1 / view.scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (const water of layout.waters) {
      ctx.beginPath();
      if (water.kind === 'sea') {
        trace(ctx, water.polygon, true);
        ctx.fillStyle = WATER;
        ctx.fill();
      } else {
        trace(ctx, water.centreLine, false);
        ctx.strokeStyle = WATER;
        ctx.lineWidth = water.width;
        ctx.stroke();
      }
    }
    for (const { colour, width, path: line } of segmentPaths) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(width, px);
      ctx.stroke(line);
    }
    for (const { colour, path: shape } of lotPaths) {
      ctx.fillStyle = colour;
      ctx.fill(shape);
      ctx.strokeStyle = 'rgba(35, 39, 46, 0.45)';
      ctx.lineWidth = Math.min(0.5, 1.5 * px);
      ctx.stroke(shape);
    }

    const outline = (lot: Lot, colour: string) => {
      ctx.beginPath();
      trace(ctx, lot.polygon, true);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 3 * px;
      ctx.stroke();
    };
    if (path) {
      ctx.beginPath();
      trace(ctx, path.points, false);
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 4 * px;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    if (highlighted) outline(highlighted, '#d92d20');
    if (picking?.from) outline(picking.from, '#1d4ed8');
    if (picking?.to) outline(picking.to, '#1d4ed8');

    // Labels and the scale bar keep their size on screen.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const label = (text: string, [x, y]: Point, font: string, align: CanvasTextAlign = 'left') => {
      ctx.font = font;
      ctx.textAlign = align;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = INK;
      ctx.fillText(text, x, y);
    };
    if (view.scale / fitScale < 6) {
      for (const area of layout.districtAreas) {
        label(districtNames.get(area.districtId) ?? area.districtId, toScreen(view, area.labelPoint), '600 12px system-ui, sans-serif', 'center');
      }
    }
    const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
    for (const exit of layout.exits) {
      const junction = junctions.get(exit.junctionId);
      if (!junction) continue;
      const [x, y] = toScreen(view, junction.position);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      label(`${exit.name ?? `Unnamed ${exit.kind.replace('-', ' ')}`} →`, [x + 9, y], '12px system-ui, sans-serif');
    }
    const bar = scaleBar(view.scale);
    const left = 14;
    const base = size.height - 16;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, base - 5);
    ctx.lineTo(left, base);
    ctx.lineTo(left + bar.pixels, base);
    ctx.lineTo(left + bar.pixels, base - 5);
    ctx.stroke();
    label(formatMetres(bar.metres), [left + bar.pixels + 8, base - 2], '12px system-ui, sans-serif');
  }

  const requestDraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function fit(): void {
    if (!layout) return;
    view = fitBox(layout.summary.bounds, size.width, size.height);
    fitScale = view.scale;
    requestDraw();
  }

  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const wasFitted = size.width === 0 || view.scale === fitScale;
    size = { width: root.clientWidth, height: root.clientHeight };
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    if (layout && wasFitted) fit();
    else requestDraw();
  }

  function showPathStatus(text: string): void {
    pathStatus.textContent = text;
    pathButton.classList.toggle('active', picking !== undefined);
    pathButton.textContent = picking ? 'Done' : 'Path';
  }

  async function pick(lot: Lot): Promise<void> {
    if (!picking) return;
    if (!picking.from || picking.to) {
      picking = { from: lot };
      path = undefined;
      showPathStatus('Now pick the lot to walk to.');
      requestDraw();
      return;
    }
    picking.to = lot;
    requestDraw();
    const asked = picking;
    try {
      const found = await handlers.findPath(asked.from!.id, lot.id);
      if (picking !== asked) return;
      path = found;
      showPathStatus(`${describePath(found)}. Pick another lot to start again.`);
    } catch (error) {
      if (picking === asked) showPathStatus((error as Error).message);
    }
    requestDraw();
  }

  pathButton.addEventListener('click', () => {
    picking = picking ? undefined : {};
    path = undefined;
    showPathStatus(picking ? 'Pick the lot to walk from.' : '');
    requestDraw();
  });
  fitButton.addEventListener('click', fit);

  let drag: { pointerId: number; lastX: number; lastY: number; travelled: number } | undefined;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, lastX: event.offsetX, lastY: event.offsetY, travelled: 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.offsetX - drag.lastX;
    const dy = event.offsetY - drag.lastY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    drag.lastX = event.offsetX;
    drag.lastY = event.offsetY;
    if (drag.travelled > CLICK_SLOP) {
      view = panBy(view, dx, dy);
      requestDraw();
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.travelled <= CLICK_SLOP;
    drag = undefined;
    if (!wasClick || !layout) return;
    const lot = lotAt(layout.lots, toMap(view, event.offsetX, event.offsetY));
    if (!lot) return;
    if (picking) void pick(lot);
    else handlers.onLotClick(lot);
  });
  canvas.addEventListener('pointercancel', () => (drag = undefined));
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
      view = zoomAt(view, event.offsetX, event.offsetY, factor, { min: fitScale * 0.5, max: fitScale * 80 });
      requestDraw();
    },
    { passive: false },
  );
  new ResizeObserver(resize).observe(root);

  return {
    show(next, districts) {
      layout = next;
      note.hidden = true;
      highlighted = undefined;
      path = undefined;
      picking = undefined;
      showPathStatus('');
      districtNames = new Map(districts.map((district) => [district.id, district.name]));
      const colours = districtColours(districts.map((district) => district.id));
      const byColour = new Map<string, Path2D>();
      for (const lot of next.lots) {
        const colour = colours.get(lot.districtId) ?? '#dddddd';
        let shape = byColour.get(colour);
        if (!shape) byColour.set(colour, (shape = new Path2D()));
        trace(shape, lot.polygon, true);
      }
      lotPaths = [...byColour].map(([colour, shape]) => ({ colour, path: shape }));
      // Segments are grouped by colour and width, the widest kinds drawn last so they lie on top.
      const byStyle = new Map<string, { colour: string; width: number; path: Path2D }>();
      for (const segment of next.segments) {
        const key = `${segment.kind}:${segment.width}`;
        let style = byStyle.get(key);
        if (!style) byStyle.set(key, (style = { colour: SEGMENT_COLOURS[segment.kind], width: segment.width, path: new Path2D() }));
        trace(style.path, segment.points, false);
      }
      segmentPaths = [...byStyle.values()].sort((a, b) => a.width - b.width);
      size = { width: 0, height: 0 };
      resize();
    },
    message(text) {
      layout = undefined;
      note.hidden = false;
      note.textContent = text;
      requestDraw();
    },
    highlight(buildingId) {
      highlighted = buildingId === undefined ? undefined : layout?.lots.find((lot) => lot.buildingId === buildingId);
      requestDraw();
    },
  };
}
