/** macOS ZIP metadata mirrors the real filenames but is never fabrication data. */
export function isArchiveContentFile(filename: string): boolean {
  return !filename.split(/[/\\]/).some(part => part.toLowerCase() === '__macosx' || part.startsWith('._'));
}
