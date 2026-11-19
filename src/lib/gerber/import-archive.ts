import { detectOutlineFiles } from './outline-detect';
import { extractOutlineScopes } from './parser';

/** Owned by one import, shared by its outline and optional paste readers. */
export async function openGerberArchive(file: File) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const filenames = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  const candidates = detectOutlineFiles(filenames);
  const read = (name: string) => zip.files[name].async('string');
  let outline: Promise<ReturnType<typeof extractOutlineScopes>> | undefined;
  return { filenames, candidates, read, outline: () => candidates.length
    ? (outline ??= read(candidates[0].filename).then(extractOutlineScopes)) : null };
}
export type GerberArchive = ReturnType<typeof openGerberArchive>;
