import { i18n } from '../../i18n';

/** Retain message keys so an existing import error follows language changes. */
export class GerberImportError extends Error {
  constructor(readonly key: string, readonly parameters: Record<string, string | number> = {}) {
    super(key);
    this.name = 'GerberImportError';
  }
}

export function formatImportError(error: unknown): string | null {
  if (error == null) return null;
  if (error instanceof GerberImportError) return i18n.global.t(error.key, error.parameters);
  return error instanceof Error ? error.message : String(error);
}
