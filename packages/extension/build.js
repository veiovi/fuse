// Builds the unpacked extension into dist/ (load it with "Load unpacked"):
// bundles the entry points with esbuild, copies the static pages and the
// circuit artifacts, and renders the PNG icons.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIcons } from './scripts/icons.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.join(here, 'dist');

const STATIC_FILES = ['popup.html', 'popup.css', 'offscreen.html'];
const ARTIFACTS = ['fuse.wasm', 'fuse.zkey'];

// Resolve packages the way @fuse/core sees them, so the prover thread matches the snarkjs it uses.
const requireFromCore = createRequire(createRequire(import.meta.url).resolve('@fuse/core'));
const coreArtifacts = path.join(path.dirname(requireFromCore.resolve('@fuse/core')), '..', 'artifacts');
const requireFromSnarkjs = createRequire(requireFromCore.resolve('snarkjs'));
const ffjavascriptThread = path.join(path.dirname(requireFromSnarkjs.resolve('ffjavascript')), '..', 'src', 'threadman_thread.js');

/** Only the offscreen document proves; everywhere else snarkjs (and its blob: workers) must not load. */
const withoutProver = {
  name: 'without-prover',
  setup(b) {
    b.onResolve({ filter: /^snarkjs$/ }, () => ({ path: 'snarkjs', namespace: 'without-prover' }));
    b.onLoad({ filter: /.*/, namespace: 'without-prover' }, () => ({
      contents:
        'const unavailable = () => { throw new Error("Fuse proofs are generated in the offscreen document"); };\n' +
        'export const groth16 = { fullProve: unavailable, verify: unavailable };\n',
      loader: 'js',
    }));
  },
};

const proverThread = {
  name: 'prover-thread',
  setup(b) {
    b.onResolve({ filter: /^ffjavascript-thread$/ }, () => ({ path: ffjavascriptThread }));
  },
};

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  logLevel: 'warning',
  legalComments: 'eof',
};

export async function buildExtension({ outdir = DIST } = {}) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(path.join(outdir, 'icons'), { recursive: true });
  await mkdir(path.join(outdir, 'artifacts'), { recursive: true });

  await Promise.all([
    build({
      ...common,
      format: 'iife',
      entryPoints: ['background', 'content', 'popup'].map((name) => path.join(here, 'src', `${name}.js`)),
      outdir,
      plugins: [withoutProver],
    }),
    build({
      ...common,
      format: 'esm',
      entryPoints: [path.join(here, 'src', 'offscreen.js')],
      outdir,
    }),
    build({
      ...common,
      format: 'iife',
      entryPoints: [path.join(here, 'src', 'prover-thread.js')],
      outdir,
      plugins: [proverThread],
    }),
  ]);

  const { version } = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(here, 'static', 'manifest.json'), 'utf8'));
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  for (const file of STATIC_FILES) await copyFile(path.join(here, 'static', file), path.join(outdir, file));
  for (const file of ARTIFACTS) await copyFile(path.join(coreArtifacts, file), path.join(outdir, 'artifacts', file));
  for (const [name, png] of Object.entries(renderIcons())) await writeFile(path.join(outdir, 'icons', name), png);
  return outdir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  const outdir = await buildExtension();
  const files = ['manifest.json', 'background.js', 'content.js', 'popup.js', 'offscreen.js', 'prover-thread.js'];
  const sizes = await Promise.all(files.map(async (f) => `${f} ${Math.round((await stat(path.join(outdir, f))).size / 1024)} kB`));
  console.log(`Built ${path.relative(process.cwd(), outdir) || outdir} in ${Date.now() - started} ms: ${sizes.join(', ')}`);
}
