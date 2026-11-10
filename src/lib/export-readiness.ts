/** Recheck synchronously after the last dialog: native file drops can start
 * while a confirmation is open, before the current geometry is replaced. */
export function exportReadiness(source: {
  gerberImporting: boolean;
  gerberOutlineSource: 'gerber' | 'pads-bounds' | null;
  outlineEstimateReviewed: boolean;
  stencilSizeReviewed: boolean;
  config: { appMode: 'jig' | 'stencil' };
}, hasData: boolean): 'ready' | 'importing' | 'empty' | 'outline' | 'sheet' {
  if (source.gerberImporting) return 'importing';
  if (!hasData) return 'empty';
  if (source.gerberOutlineSource === 'pads-bounds' && !source.outlineEstimateReviewed) return 'outline';
  if (source.config.appMode === 'jig' && !source.stencilSizeReviewed) return 'sheet';
  return 'ready';
}
