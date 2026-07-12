/**
 * Build step for spraytantelaviv.com
 * ---------------------------------------------------------------
 * Cloudflare Pages runs this on every push. It copies the site into dist/
 * and, on the way, shrinks every image in images/ down to something a phone
 * can actually download.
 *
 * The point: whoever edits the site can upload a 6MB photo straight from an
 * iPhone and never think about it. Visitors get a ~300KB version instead.
 *
 * The originals in the repo are never touched — only the copies that get
 * published. If this script ever fails on one image, it copies that image
 * through untouched rather than failing the whole build.
 */

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');

const MAX_WIDTH = 1600;   // wider than any slot on the page, even on a big screen
const QUALITY = 80;       // visually indistinguishable from the original

// Files at the root that get published as-is.
const ROOT_FILES = [
  'index.html',
  'styles.css',
  'content.json',
  'robots.txt',
  'llms.txt',
  'sitemap.xml',
];

// Folders copied wholesale (the CMS admin page).
const ROOT_DIRS = ['admin'];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const kb = (n) => (n / 1024).toFixed(0) + 'KB';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fs.copyFile(src, dst);
  }
}

/** Resize + compress one image. Returns [before, after] in bytes. */
async function optimizeImage(src, dst) {
  const before = (await fs.stat(src)).size;
  const ext = path.extname(src).toLowerCase();

  let img = sharp(src)
    .rotate()                                   // honour the phone's orientation flag,
                                                // or portrait photos publish sideways
    .resize({ width: MAX_WIDTH, withoutEnlargement: true });

  // sharp drops EXIF by default — which also strips the GPS coordinates that
  // phones bury in photos. Worth knowing: without this, the exact location a
  // client's photo was taken would be published with it.
  if (ext === '.png') img = img.png({ quality: QUALITY, compressionLevel: 9 });
  else if (ext === '.webp') img = img.webp({ quality: QUALITY });
  else img = img.jpeg({ quality: QUALITY, progressive: true, mozjpeg: true });

  await img.toFile(dst);
  const after = (await fs.stat(dst)).size;
  return [before, after];
}

async function processImages(from, to) {
  await fs.mkdir(to, { recursive: true });
  let totalBefore = 0, totalAfter = 0, count = 0;

  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) {
      const sub = await processImages(src, dst);
      totalBefore += sub.before; totalAfter += sub.after; count += sub.count;
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();

    if (IMAGE_EXT.has(ext)) {
      try {
        const [before, after] = await optimizeImage(src, dst);
        const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;
        console.log(
          `  ${entry.name.padEnd(28)} ${kb(before).padStart(8)} -> ${kb(after).padStart(8)}  (-${saved}%)`
        );
        totalBefore += before; totalAfter += after; count++;
      } catch (err) {
        console.warn(`  ${entry.name.padEnd(28)} could not be processed (${err.message}) — copied as-is`);
        await fs.copyFile(src, dst);
      }
    } else {
      // Videos, GIFs, SVGs, anything else — published untouched.
      const size = (await fs.stat(src)).size;
      await fs.copyFile(src, dst);
      console.log(`  ${entry.name.padEnd(28)} ${kb(size).padStart(8)}     (copied, not an image)`);
      if (size > 20 * 1024 * 1024) {
        console.warn(`  ^ WARNING: over 20MB. Cloudflare Pages rejects files above 25MB.`);
      }
    }
  }
  return { before: totalBefore, after: totalAfter, count };
}

async function main() {
  console.log('Building spraytantelaviv.com\n');

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  for (const f of ROOT_FILES) {
    if (await exists(path.join(ROOT, f))) {
      await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
    } else {
      console.warn(`  (${f} not found — skipped)`);
    }
  }

  for (const d of ROOT_DIRS) {
    if (await exists(path.join(ROOT, d))) await copyDir(path.join(ROOT, d), path.join(OUT, d));
  }

  console.log('Images:');
  const imgDir = path.join(ROOT, 'images');
  if (await exists(imgDir)) {
    const { before, after, count } = await processImages(imgDir, path.join(OUT, 'images'));
    console.log(
      `\n  ${count} image(s): ${kb(before)} -> ${kb(after)}` +
      (before > 0 ? `  (${Math.round((1 - after / before) * 100)}% smaller)` : '')
    );
  } else {
    console.log('  no images/ folder found');
  }

  console.log('\nDone. Publishing dist/');
}

main().catch((err) => {
  console.error('\nBuild failed:', err);
  process.exit(1);
});
