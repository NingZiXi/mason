// Build the standalone website interaction; does not rebuild the desktop app.
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdir, unlink} from 'node:fs/promises';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'docs/assets/story');
const result = await build({
  absWorkingDir: repo, metafile: true,
  entryPoints: [path.join(repo, 'docs/src/pcb2-story.js')],
  outdir: path.join(repo, 'docs/assets/story'),
  bundle: true, splitting: true, format: 'esm', platform: 'browser',
  minify: true, target: 'es2022', entryNames: '[name]', chunkNames: '[name]-[hash]', legalComments: 'eof',
});
// Only remove superseded scene bundles after a successful build; retain all CAD assets.
const emitted = new Set(Object.keys(result.metafile.outputs).map(file => path.resolve(repo, file)));
for (const file of await readdir(output)) {
  const absolute = path.join(output, file);
  if (/^(?:pcb2-scene|detail-viewer|OrbitControls|chunk)-[A-Z0-9]+\.js$/.test(file) && !emitted.has(absolute)) await unlink(absolute);
}
console.log('Built docs/assets/story/pcb2-story.js and its lazy CAD renderer.');
