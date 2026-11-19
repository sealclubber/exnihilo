/**
 * Draws the world map on a 2D canvas.
 */
import type { MapGeometry, Point, RouteKind, SettlementListItem, SizeGroup } from '@worldsim/core';
import { type View, toScreen } from './view.ts';

const WATER = '#b9d3ea';
const UNCLAIMED_LAND = '#dcd8c8';
const RIVER = '#3f7fbf';
const INK = '#23272e';

const ROUTE_STYLES: Record<RouteKind, { colour: string; width: number; dash: number[] }> = {
  road: { colour: '#6b4423', width: 1.6, dash: [] },
  trail: { colour: '#8a6a4a', width: 1, dash: [4, 3] },
  'sea-route': { colour: 'rgba(255, 255, 255, 0.85)', width: 1, dash: [1, 4] },
};

/** Marker radius in screen pixels, and the zoom (relative to the whole-map view) at which the name appears. */
export const MARKER_STYLES: Record<SizeGroup, { radius: number; labelFromZoom: number }> = {
  capital: { radius: 5, labelFromZoom: 0 },
  city: { radius: 4, labelFromZoom: 1.8 },
  town: { radius: 3, labelFromZoom: 3.5 },
  fort: { radius: 3, labelFromZoom: 3.5 },
  village: { radius: 2, labelFromZoom: 5 },
};

/**
 * How much to scale markers at a zoom level: small when the whole map is in
 * view and the markers crowd each other, larger once there is room.
 */
export function markerScale(zoom: number): number {
  return Math.min(Math.max(0.35 + 0.15 * zoom, 0.5), 1.6);
}

/** Mixes a #rrggbb colour toward white so that lines and markers stay readable on top of it. */
export function soften(colour: string, amount = 0.35): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!match) return colour;
  const channel = (hex: string) => Math.round(parseInt(hex, 16) * (1 - amount) + 255 * amount);
  return `rgb(${channel(match[1] as string)}, ${channel(match[2] as string)}, ${channel(match[3] as string)})`;
}

/** Map geometry prepared for drawing: paths are built once, in map coordinates. */
export interface Scene {
  map: MapGeometry;
  land: Array<{ colour: string; path: Path2D }>;
  rivers: Path2D;
  routes: Array<{ kind: RouteKind; path: Path2D }>;
}

function addPolyline(path: Path2D, points: readonly Point[], close: boolean): void {
  points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
  if (close) path.closePath();
}

export function buildScene(map: MapGeometry): Scene {
  const stateColours = new Map<string, string>();
  for (const state of map.states) {
    stateColours.set(state.id, state.isPlaceholder || !state.colour ? UNCLAIMED_LAND : soften(state.colour));
  }

  // One path per fill colour, so the whole land is a couple of dozen fills.
  const landByColour = new Map<string, Path2D>();
  for (const cell of map.cells) {
    if (!cell.isLand) continue;
    const colour = stateColours.get(cell.stateId) ?? UNCLAIMED_LAND;
    let path = landByColour.get(colour);
    if (!path) landByColour.set(colour, (path = new Path2D()));
    addPolyline(path, cell.polygon, true);
  }

  const rivers = new Path2D();
  for (const river of map.rivers) addPolyline(rivers, river.points, false);

  const routes = (['sea-route', 'trail', 'road'] as const).map((kind) => {
    const path = new Path2D();
    for (const route of map.routes) if (route.kind === kind) addPolyline(path, route.points, false);
    return { kind, path };
  });

  return {
    map,
    land: [...landByColour].map(([colour, path]) => ({ colour, path })),
    rivers,
    routes,
  };
}

export interface DrawOptions {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  pixelRatio: number;
  /** Zoom relative to the view that shows the whole map. */
  zoom: number;
  selectedId?: string;
  hoveredId?: string;
}

export function draw(ctx: CanvasRenderingContext2D, scene: Scene, view: View, options: DrawOptions): void {
  const { pixelRatio: ratio } = options;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = WATER;
  ctx.fillRect(0, 0, options.width, options.height);

  // Geometry is drawn in map coordinates; line widths are divided by the scale to stay constant on screen.
  ctx.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
  const px = 1 / view.scale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const { colour, path } of scene.land) {
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.lineWidth = px;
    ctx.fill(path);
    ctx.stroke(path); // hides the hairline seams between neighbouring cells
  }

  ctx.strokeStyle = RIVER;
  ctx.lineWidth = 1.4 * px;
  ctx.stroke(scene.rivers);

  for (const { kind, path } of scene.routes) {
    const style = ROUTE_STYLES[kind];
    ctx.strokeStyle = style.colour;
    ctx.lineWidth = style.width * px;
    ctx.setLineDash(style.dash.map((length) => length * px));
    ctx.stroke(path);
  }
  ctx.setLineDash([]);

  // Markers and names are drawn in screen coordinates so they keep their size.
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const onScreen = ([x, y]: Point) => x > -50 && y > -20 && x < options.width + 50 && y < options.height + 20;
  const labelled: Array<{ item: SettlementListItem; at: Point }> = [];
  const radiusOf = (item: SettlementListItem) =>
    MARKER_STYLES[item.sizeGroup].radius * (item.isCapital ? Math.max(markerScale(options.zoom), 1) : markerScale(options.zoom));

  for (const item of scene.map.settlements) {
    const at = toScreen(view, item.position);
    if (!onScreen(at)) continue;
    const style = MARKER_STYLES[item.sizeGroup];
    drawMarker(ctx, item.sizeGroup, at, radiusOf(item), '#ffffff', INK);
    const emphasised = item.id === options.selectedId || item.id === options.hoveredId;
    if (emphasised || options.zoom >= style.labelFromZoom) labelled.push({ item, at });
  }

  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const { item, at } of labelled) {
    const selected = item.id === options.selectedId;
    const radius = radiusOf(item);
    if (selected) {
      ctx.strokeStyle = '#d92d20';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(at[0], at[1], radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    const weight = item.isCapital || selected ? '600' : '400';
    ctx.font = `${weight} ${item.isCapital ? 13 : 11}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeText(item.name, at[0] + radius + 5, at[1]);
    ctx.fillStyle = INK;
    ctx.fillText(item.name, at[0] + radius + 5, at[1]);
  }
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  sizeGroup: SizeGroup,
  [x, y]: Point,
  radius: number,
  fill: string,
  stroke: string,
): void {
  ctx.beginPath();
  if (sizeGroup === 'fort') {
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
  } else {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = sizeGroup === 'capital' ? stroke : fill;
  ctx.strokeStyle = sizeGroup === 'capital' ? fill : stroke;
  ctx.lineWidth = sizeGroup === 'capital' ? 1.5 : Math.min(1, radius / 2);
  ctx.fill();
  ctx.stroke();
  if (sizeGroup === 'capital') {
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
