import { describe, expect, it } from 'vitest';
import { DEFAULT, platterHalfXY, stencilLipMax, windowHalfXY } from '../../stores/config';
import { clampPlan, pcbPlanPath } from '../clamp-plan';

describe('clamp contact plan', () => {
  it('subtracts the actual window clearance rather than labelling the entire lip as grip', () => {
    const plan = clampPlan(DEFAULT);
    expect(plan.gripX).toBe(14.5);
    expect(plan.gripY).toBe(14.5);
    expect(plan.platter.width / plan.scale).toBe(70);
    expect(plan.window.width / plan.scale).toBe(71);
    expect(plan.sheet.width / plan.scale).toBe(100);
  });

  it('keeps rectangular metal sheets and their windows to the model proportions', () => {
    const config = { ...DEFAULT, stencilSizeX: 180, stencilSizeY: 90, stencilLip: 10 };
    const plan = clampPlan(config);
    expect(plan.sheet.width / plan.sheet.height).toBe(2);
    expect(plan.platter.width / plan.scale).toBe(160);
    expect(plan.platter.height / plan.scale).toBe(70);
    expect(plan.window.height / plan.scale).toBe(71);
    expect(plan.gripX).toBe(9.5);
    expect(plan.gripY).toBe(9.5);
  });

  it.each([0, .1, .5])('has no straight-edge grip at lip %s instead of reporting a negative width', stencilLip => {
    const plan = clampPlan({ ...DEFAULT, stencilLip });
    expect(plan.gripX).toBe(0);
    expect(plan.gripY).toBe(0);
    expect(plan.window.width).toBeGreaterThanOrEqual(plan.sheet.width);
  });

  it('keeps the PCB slot supported at the lip limit and respects independent X/Y limits', () => {
    const config = { ...DEFAULT, stencilSizeX: 120, stencilSizeY: 80, pcbSizeX: 90, pcbSizeY: 35 };
    config.stencilLip = stencilLipMax(config);
    const plan = clampPlan(config), platter = platterHalfXY(config), window = windowHalfXY(config);
    expect(plan.platter.width / plan.scale).toBeCloseTo(config.pcbSizeX + 2 * config.pcbPocketClearance);
    expect(plan.platter.height / plan.scale).toBeCloseTo(platter.hy * 2);
    expect(plan.window.width / plan.scale).toBeCloseTo(window.hx * 2);
    expect(plan.gripX).toBeCloseTo(config.stencilLip - config.windowGap);
  });

  it('fits extreme board ratios and oversized windows into a single undistorted view', () => {
    const plan = clampPlan({ ...DEFAULT, stencilSizeX: 290, stencilSizeY: 10, windowGap: 5, stencilLip: 0 });
    expect(Math.max(plan.sheet.width, plan.window.width)).toBeLessThanOrEqual(264 + 1e-8);
    expect(Math.max(plan.sheet.height, plan.window.height)).toBeLessThanOrEqual(142 + 1e-8);
    expect(plan.gripX).toBe(0);
    expect(plan.gripY).toBe(0);
    for (const rect of [plan.sheet, plan.window, plan.platter]) {
      expect(rect.x).toBeCloseTo(-rect.width / 2);
      expect(rect.y).toBeCloseTo(-rect.height / 2);
    }
  });

  it('matches the engine corner radii without mutating configuration or imported geometry', () => {
    const config = JSON.parse(JSON.stringify(DEFAULT));
    const before = JSON.stringify(config);
    const plan = clampPlan(config);
    expect(plan.platter.rx / plan.scale).toBe(4.5);
    expect(plan.window.rx / plan.scale).toBe(1);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('keeps explicit zero-radius platter and window corners square', () => {
    const plan = clampPlan({ ...DEFAULT, platterCornerRadius: 0 });
    expect(plan.platter.rx).toBe(0);
    expect(plan.window.rx).toBe(0);
  });

  it('preserves the actual PCB outline and internal holes as even-odd subpaths', () => {
    const outline: [number, number][] = [[-3, -2], [3, -2], [2, 3], [-3, 3]];
    const hole: [number, number][] = [[-1, 0], [0, 1], [1, 0]];
    const path = pcbPlanPath(outline, [hole], 50, 50);
    expect(path).toBe('M-3,-2L3,-2L2,3L-3,3Z M-1,0L0,1L1,0Z');
    expect(outline[0]).toEqual([-3, -2]);
  });

  it('shows a centred board from manual dimensions before importing a Gerber', () => {
    expect(pcbPlanPath([], [], 50, 30)).toBe('M-25,-15h50v30h-50Z');
  });
});
