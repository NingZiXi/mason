interface ReviewSource {
  config: { appMode: 'jig' | 'stencil'; stencilSizeX: number; stencilSizeY: number };
  stencilSizeReviewed: boolean;
  stencilSizeReviewRevision: number;
  confirmStencilSizeReview: (revision: number) => boolean;
}

/** Gate all output paths before choosing a directory or writing any files.
 * A dialog can only acknowledge the exact board/dimensions it displayed.
 */
export async function reviewStencilSizeForExport(source: ReviewSource,
  prompt: (size: { x: number; y: number }) => Promise<boolean>, active: () => boolean = () => true,
): Promise<'ready' | 'cancelled' | 'changed' | 'disposed'> {
  if (!active()) return 'disposed';
  if (source.config.appMode !== 'jig' || source.stencilSizeReviewed) return 'ready';
  const revision = source.stencilSizeReviewRevision;
  if (!await prompt({ x: source.config.stencilSizeX, y: source.config.stencilSizeY })) return 'cancelled';
  if (!active()) return 'disposed';
  if (source.config.appMode !== 'jig' || !source.confirmStencilSizeReview(revision)) return 'changed';
  return 'ready';
}
