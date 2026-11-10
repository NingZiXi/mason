interface OutlineReviewSource {
  gerberOutlineSource: 'gerber' | 'pads-bounds' | null;
  outlineEstimateReviewed: boolean;
  outlineReviewRevision: number;
  config: { pcbSizeX: number; pcbSizeY: number };
  confirmOutlineEstimateReview: (revision: number) => boolean;
}

/** An acknowledgement applies to this exact import and board scope, while
 * leaving the outline visibly estimated until a real outline is imported. */
export async function reviewOutlineForExport(source: OutlineReviewSource,
  prompt: (size: { x: number; y: number }) => Promise<boolean>, active: () => boolean = () => true,
): Promise<'ready' | 'cancelled' | 'changed' | 'disposed'> {
  if (!active()) return 'disposed';
  if (source.gerberOutlineSource !== 'pads-bounds' || source.outlineEstimateReviewed) return 'ready';
  const revision = source.outlineReviewRevision;
  if (!await prompt({ x: source.config.pcbSizeX, y: source.config.pcbSizeY })) return 'cancelled';
  if (!active()) return 'disposed';
  return source.confirmOutlineEstimateReview(revision) ? 'ready' : 'changed';
}
