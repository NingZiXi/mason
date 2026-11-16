import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTooltipInteraction, positionTooltip } from '../tooltip';

afterEach(() => { vi.useRealTimers(); });
const anchor = { left: 100, top: 100, width: 32, height: 28 };
const size = { width: 120, height: 32 };
const viewport = { width: 400, height: 300 };

describe('tooltip placement', () => {
  it('centers the hint with a consistent gap and flips away from viewport edges', () => {
    expect(positionTooltip(anchor, size, viewport)).toEqual({ x: 56, y: 60, side: 'top' });
    expect(positionTooltip({ ...anchor, top: 4 }, size, viewport)).toEqual({ x: 56, y: 40, side: 'bottom' });
    expect(positionTooltip({ ...anchor, top: 270 }, size, viewport, 'bottom')).toEqual({ x: 56, y: 230, side: 'top' });
    expect(positionTooltip({ ...anchor, left: 2 }, size, viewport, 'left')).toEqual({ x: 42, y: 98, side: 'right' });
  });
  it('keeps long hints inside narrow windows and clamps both axes', () => {
    const position = positionTooltip({ left: 188, top: 4, width: 10, height: 10 }, { width: 184, height: 70 }, { width: 200, height: 100 });
    expect(position).toEqual({ x: 8, y: 22, side: 'bottom' });
  });
});

describe('tooltip interaction', () => {
  function setup() {
    vi.useFakeTimers();
    const show = vi.fn(), hide = vi.fn();
    return { show, hide, state: createTooltipInteraction({ show, hide }) };
  }
  it('delays hover hints and cancels them when the pointer leaves early', () => {
    const { state, show } = setup();
    state.enter(); vi.advanceTimersByTime(379); expect(show).not.toHaveBeenCalled();
    state.leave(); vi.advanceTimersByTime(1); expect(show).not.toHaveBeenCalled();
    state.enter(); vi.advanceTimersByTime(380); expect(show).toHaveBeenCalledOnce();
  });
  it('supports keyboard focus and keeps a focused hint open when the pointer leaves', () => {
    const { state, show, hide } = setup();
    state.focus(); vi.advanceTimersByTime(80); expect(show).toHaveBeenCalledOnce();
    state.enter(); state.leave(); expect(hide).not.toHaveBeenCalled();
    state.blur(); expect(hide).toHaveBeenCalledOnce();
  });
  it('does not reopen an Escape/click-dismissed hint until the trigger is left', () => {
    const { state, show } = setup();
    state.enter(); state.focus(); vi.advanceTimersByTime(80);
    state.dismiss(); state.focus(); vi.advanceTimersByTime(500); expect(show).toHaveBeenCalledOnce();
    state.leave(); state.blur(); state.focus(); vi.advanceTimersByTime(80); expect(show).toHaveBeenCalledTimes(2);
  });
  it('ignores touch input and clears pending work when destroyed', () => {
    const { state, show } = setup();
    state.enter('touch'); vi.advanceTimersByTime(500); expect(show).not.toHaveBeenCalled();
    state.enter(); state.dispose(); vi.advanceTimersByTime(500); expect(show).not.toHaveBeenCalled();
    state.focus(); state.enter(); vi.advanceTimersByTime(500); expect(show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
