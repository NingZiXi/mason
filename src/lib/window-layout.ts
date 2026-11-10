import { currentMonitor, PhysicalPosition, PhysicalSize, LogicalSize, type Window } from '@tauri-apps/api/window';

interface Size { width: number; height: number }
interface Point { x: number; y: number }
interface Bounds extends Size, Point {}

/** Inputs stay in physical pixels so mixed-DPI monitor origins are never scaled twice. */
export function planWindowFit(workArea: Bounds, outer: Bounds, inner: Size, scaleFactor: number) {
  if (workArea.width <= 0 || workArea.height <= 0) return null;
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const frameWidth = Math.max(0, outer.width - inner.width);
  const frameHeight = Math.max(0, outer.height - inner.height);
  const margin = Math.ceil(12 * scale);
  const availableWidth = Math.max(1, workArea.width - frameWidth - margin * 2);
  const availableHeight = Math.max(1, workArea.height - frameHeight - margin * 2);
  // Keep smaller user windows unchanged; only oversized dimensions need fitting.
  const width = Math.min(inner.width, availableWidth);
  const height = Math.min(inner.height, availableHeight);
  const x = Math.min(Math.max(outer.x, workArea.x), workArea.x + workArea.width - width - frameWidth);
  const y = Math.min(Math.max(outer.y, workArea.y), workArea.y + workArea.height - height - frameHeight);
  return {
    minimum: { width: Math.max(1, Math.min(960, Math.floor(width / scale))), height: Math.max(1, Math.min(560, Math.floor(height / scale))) },
    size: { width, height }, position: { x, y },
    resize: width !== inner.width || height !== inner.height,
    move: x !== outer.x || y !== outer.y,
  };
}

/** Run once at startup; normal resizing and moving remain owned by the user. */
export async function fitMainWindowToMonitor(appWindow: Window) {
  const monitor = await currentMonitor();
  if (!monitor || await appWindow.isMaximized()) return;
  const [inner, outerSize, position] = await Promise.all([
    appWindow.innerSize(), appWindow.outerSize(), appWindow.outerPosition(),
  ]);
  const plan = planWindowFit({ ...monitor.workArea.position, ...monitor.workArea.size },
    { ...position, ...outerSize }, inner, monitor.scaleFactor);
  if (!plan || await appWindow.isMaximized()) return;
  await appWindow.setMinSize(new LogicalSize(plan.minimum));
  if (plan.resize) await appWindow.setSize(new PhysicalSize(plan.size));
  if (plan.move) await appWindow.setPosition(new PhysicalPosition(plan.position));
}
