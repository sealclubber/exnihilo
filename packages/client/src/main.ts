import type { SettlementListItem, WorldInfo } from '@worldsim/core';
import { fetchBrief, fetchDraw, fetchMap, fetchWorld } from './api.ts';
import { describeBrief } from './brief.ts';
import { createInspector } from './inspector.ts';
import { createFoldAll, createPane } from './pane.ts';
import { showBrief, showMessage } from './panel.ts';
import { pickNearest } from './pick.ts';
import { type Scene, buildScene, draw } from './render.ts';
import { type View, fitView, panBy, zoomAt } from './view.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = byId<HTMLCanvasElement>('canvas');
const mapBox = byId('map');
// The settlement panel is a pane like the rest: it folds away to one line, and the map takes the room.
const panelHost = byId('panel');
const panel = document.createElement('div');
panel.className = 'brief';
panel.append(...panelHost.childNodes);
const settlementPane = createPane('settlement', 'Settlement', panel, 'side');
settlementPane.setSummary('none chosen');
panelHost.replaceChildren(settlementPane.element);
document.querySelector('body > header')?.append(createFoldAll());
const tooltip = byId('tooltip');
const status = byId('status');
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

const MAX_ZOOM = 40;
const MIN_ZOOM = 0.5;
const CLICK_SLOP = 4;

let scene: Scene | undefined;
let world: WorldInfo | undefined;
let view: View = { scale: 1, x: 0, y: 0 };
let fitScale = 1;
let size = { width: 0, height: 0 };
let selectedId: string | undefined;
let hoveredId: string | undefined;
let frame = 0;

function requestDraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!scene) return;
    draw(ctx, scene, view, {
      width: size.width,
      height: size.height,
      pixelRatio: window.devicePixelRatio || 1,
      zoom: view.scale / fitScale,
      ...(selectedId !== undefined && { selectedId }),
      ...(hoveredId !== undefined && { hoveredId }),
    });
  });
}

function resize(): void {
  const ratio = window.devicePixelRatio || 1;
  const previous = size;
  size = { width: mapBox.clientWidth, height: mapBox.clientHeight };
  canvas.width = Math.round(size.width * ratio);
  canvas.height = Math.round(size.height * ratio);
  if (scene) {
    const fit = fitView(scene.map.width, scene.map.height, size.width, size.height);
    const wasFitted = previous.width === 0 || view.scale === fitScale;
    fitScale = fit.scale;
    if (wasFitted) view = fit;
  }
  requestDraw();
}

function resetView(): void {
  if (!scene) return;
  view = fitView(scene.map.width, scene.map.height, size.width, size.height);
  fitScale = view.scale;
  requestDraw();
}

function zoom(factor: number, screenX = size.width / 2, screenY = size.height / 2): void {
  view = zoomAt(view, screenX, screenY, factor, { min: fitScale * MIN_ZOOM, max: fitScale * MAX_ZOOM });
  requestDraw();
}

function settlementAt(screenX: number, screenY: number): SettlementListItem | undefined {
  return scene ? pickNearest(scene.map.settlements, view, screenX, screenY) : undefined;
}

// The address after # is a settlement ID, optionally followed by /city for its inspector.
const CITY_SUFFIX = '/city';
const inspector = createInspector(byId('inspector'), () => {
  if (selectedId !== undefined) location.hash = selectedId;
});

function followAddress(): void {
  const address = location.hash.slice(1);
  const wantsCity = address.endsWith(CITY_SUFFIX);
  const id = wantsCity ? address.slice(0, -CITY_SUFFIX.length) : address;
  const known = scene?.map.settlements.some((item) => item.id === id) ?? false;
  if (known && wantsCity) void inspector.open(id);
  else inspector.close();
  if (known && id !== selectedId) void select(id);
}
window.addEventListener('hashchange', followAddress);

async function select(id: string): Promise<void> {
  selectedId = id;
  if (!location.hash.startsWith(`#${id}`)) history.replaceState(null, '', `#${id}`);
  requestDraw();
  try {
    // The draw comes with the brief; if it cannot be had, the brief is shown without.
    const [brief, draw] = await Promise.all([fetchBrief(id), fetchDraw(id).catch(() => undefined)]);
    if (selectedId === id) {
      const text = describeBrief(brief, world, draw);
      settlementPane.setSummary(text.title);
      showBrief(panel, text, () => {
        location.hash = `${id}${CITY_SUFFIX}`;
      });
    }
  } catch (error) {
    if (selectedId === id) showMessage(panel, (error as Error).message, 'error');
  }
}

// Pointer: drag to pan, click to select, move to see a name.
let drag: { pointerId: number; lastX: number; lastY: number; travelled: number } | undefined;

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  drag = { pointerId: event.pointerId, lastX: event.offsetX, lastY: event.offsetY, travelled: 0 };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (drag && event.pointerId === drag.pointerId) {
    const dx = event.offsetX - drag.lastX;
    const dy = event.offsetY - drag.lastY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    drag.lastX = event.offsetX;
    drag.lastY = event.offsetY;
    if (drag.travelled > CLICK_SLOP) {
      canvas.classList.add('dragging');
      tooltip.hidden = true;
      view = panBy(view, dx, dy);
      requestDraw();
    }
    return;
  }
  const hovered = settlementAt(event.offsetX, event.offsetY);
  canvas.classList.toggle('over-settlement', hovered !== undefined);
  tooltip.hidden = hovered === undefined;
  if (hovered) {
    tooltip.textContent = hovered.name;
    tooltip.style.left = `${event.offsetX}px`;
    tooltip.style.top = `${event.offsetY}px`;
  }
  if (hovered?.id !== hoveredId) {
    hoveredId = hovered?.id;
    requestDraw();
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const wasClick = drag.travelled <= CLICK_SLOP;
  drag = undefined;
  canvas.classList.remove('dragging');
  if (wasClick) {
    const clicked = settlementAt(event.offsetX, event.offsetY);
    if (clicked) void select(clicked.id);
  }
});

canvas.addEventListener('pointercancel', () => {
  drag = undefined;
  canvas.classList.remove('dragging');
});

canvas.addEventListener('pointerleave', () => {
  tooltip.hidden = true;
  if (hoveredId !== undefined) {
    hoveredId = undefined;
    requestDraw();
  }
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.offsetX, event.offsetY);
  },
  { passive: false },
);

byId('zoom-in').addEventListener('click', () => zoom(1.5));
byId('zoom-out').addEventListener('click', () => zoom(1 / 1.5));
byId('zoom-reset').addEventListener('click', resetView);
new ResizeObserver(resize).observe(mapBox);

async function start(): Promise<void> {
  status.textContent = 'Loading the world…';
  try {
    const [summary, map] = await Promise.all([fetchWorld(), fetchMap()]);
    world = summary.info;
    scene = buildScene(map);
    document.title = `${world.name} · World Sim`;
    byId('world-name').textContent = world.name;
    byId('world-date').textContent = `${world.currentYear} ${world.eraName}`;
    status.textContent = `${summary.counts.settlements.toLocaleString('en-US')} settlements`;
    resize();
    resetView();

    followAddress();
  } catch (error) {
    status.textContent = 'Not connected';
    status.className = 'error';
    showMessage(panel, (error as Error).message, 'error');
  }
}

void start();
