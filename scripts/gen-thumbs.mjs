/**
 * Generate WebP thumbnails for all ENI archival images.
 *
 * Output: public/sources/eni/thumbs/<name>.webp
 *   – 600 px wide (covers sidebar at 2× retina; more than enough for 88 px node cards)
 *   – WebP quality 78
 *   – Never upscales smaller originals
 *
 * Run once:  node scripts/gen-thumbs.mjs
 * Re-run:    node scripts/gen-thumbs.mjs --force   (overwrites existing)
 */

import sharp from 'sharp';
import { readdir, stat } from 'fs/promises';
import { mkdirSync } from 'fs';
import { join, extname, basename } from 'path';

const SRC   = 'public/sources/eni';
const DEST  = 'public/sources/eni/thumbs';
const WIDTH = 600;
const QUALITY = 78;
const FORCE = process.argv.includes('--force');

const IMAGE_RE = /\.(jpe?g|png|tiff?|webp)$/i;

mkdirSync(DEST, { recursive: true });

const files = (await readdir(SRC))
  .filter(f => IMAGE_RE.test(f));

console.log(`Found ${files.length} source images in ${SRC}\n`);

let skipped = 0, generated = 0, errors = 0;
const sizes = [];

for (const file of files) {
  const src  = join(SRC, file);
  const name = basename(file, extname(file));
  const dest = join(DEST, `${name}.webp`);

  // Skip if already exists and not forcing
  if (!FORCE) {
    try {
      await stat(dest);
      skipped++;
      continue;
    } catch { /* doesn't exist yet */ }
  }

  try {
    const { size: srcSize } = await stat(src);
    const { size: destSize } = await sharp(src)
      .resize({ width: WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(dest)
      .then(() => stat(dest));

    const ratio = ((1 - destSize / srcSize) * 100).toFixed(0);
    sizes.push({ file, srcSize, destSize });
    console.log(`  ✓ ${file.padEnd(36)} ${(srcSize/1024).toFixed(0).padStart(5)} KB → ${(destSize/1024).toFixed(0).padStart(4)} KB  (−${ratio}%)`);
    generated++;
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`);
    errors++;
  }
}

const totalSrc  = sizes.reduce((s, r) => s + r.srcSize,  0);
const totalDest = sizes.reduce((s, r) => s + r.destSize, 0);

console.log(`
─────────────────────────────────────────────────
  Generated : ${generated}
  Skipped   : ${skipped}  (use --force to regenerate)
  Errors    : ${errors}
  Before    : ${(totalSrc  / 1024 / 1024).toFixed(1)} MB
  After     : ${(totalDest / 1024 / 1024).toFixed(1)} MB
  Saved     : ${((1 - totalDest / totalSrc) * 100).toFixed(0)}%  (${((totalSrc - totalDest) / 1024 / 1024).toFixed(1)} MB)
─────────────────────────────────────────────────`);
