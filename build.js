/**
 * Build step for spraytantelaviv.com
 * ---------------------------------------------------------------
 * Cloudflare Pages runs this on every push. It does three things:
 *
 *   1. Renders the site in four languages from ONE template (index.html)
 *      plus one content file per language. The text is baked into the HTML
 *      so Google reads it without running any JavaScript.
 *   2. Merges the shared content (prices, phone, photos) into every language,
 *      so those only ever have to be edited once.
 *   3. Shrinks every image so a 6MB phone photo publishes at ~300KB.
 *
 * The originals in the repo are never touched — only the copies in dist/.
 *
 * Adding a language later: add it to LANGS, add content.<code>.json, done.
 */

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const cheerio = require('cheerio');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const SITE = 'https://spraytantelaviv.com';

const MAX_WIDTH = 1600;
const QUALITY = 80;

/* ---------------------------------------------------------------
   The four languages. `dir` drives right-to-left layout.
   `folder` empty means the site root — English stays at the top level
   so every existing link and Google result keeps working.
   --------------------------------------------------------------- */
const LANGS = [
  { code: 'en', folder: '',   dir: 'ltr', label: 'EN', hreflang: 'en', locale: 'en_US' },
  { code: 'he', folder: 'he', dir: 'rtl', label: 'עב', hreflang: 'he', locale: 'he_IL' },
  { code: 'fr', folder: 'fr', dir: 'ltr', label: 'FR', hreflang: 'fr', locale: 'fr_FR' },
  { code: 'ru', folder: 'ru', dir: 'ltr', label: 'RU', hreflang: 'ru', locale: 'ru_RU' },
];

// Fields that only exist on the English page (Hebrew accents for local SEO).
// On the other three the elements are removed rather than left empty.
const EN_ONLY = ['philo_eyebrow_he', 'area_p_he'];

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

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

function urlFor(lang) {
  return lang.folder ? SITE + '/' + lang.folder + '/' : SITE + '/';
}

/* ---------------------------------------------------------------
   Content: shared fields + one language file, merged.
   The gallery is stored split — photo paths in the shared file, captions
   per language — so adding a photo is a one-time edit. They get zipped
   back into the gallery_items shape the page already understands.
   --------------------------------------------------------------- */
function mergeContent(shared, lang) {
  const data = Object.assign({}, shared, lang);

  const images = shared.gallery_images || [];
  const captions = lang.gallery_captions || [];
  data.gallery_items = images.map(function (img, i) {
    const c = captions[i] || {};
    const item = { image: img };
    if (c.caption) item.caption = c.caption;
    if (c.alt) item.alt = c.alt;
    return item;
  });

  delete data.gallery_images;
  delete data.gallery_captions;
  return data;
}

/* --- the same *accent* convention the runtime loader uses ------------ */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function rich(s, cls) {
  return esc(s)
    .replace(/\*([^*]+)\*/g, '<em class="' + cls + '">$1</em>')
    .replace(/\r?\n/g, '<br/>');
}
function has(data, k) {
  return data[k] !== undefined && data[k] !== null && String(data[k]).length > 0;
}

/* ---------------------------------------------------------------
   Language switcher — same markup in the header and the footer.
   --------------------------------------------------------------- */
/* ---------------------------------------------------------------
   styles.css is a COMPILED, PURGED Tailwind build — there is no Tailwind
   step in this repo, so it contains only the utility classes that were
   present in the original English page. Any new class invented here would
   simply not exist and would silently do nothing.

   So the switcher carries its own CSS, written against the site's own
   colour variables. It cannot break when the stylesheet is rebuilt.
   --------------------------------------------------------------- */
const SWITCH_CSS = [
  '.lang-switch{ display:flex; align-items:center; gap:.5rem;',
  '  font-size:.66rem; letter-spacing:.22em; text-transform:uppercase; }',
  '.lang-switch a{ color:rgba(245,231,206,.5); text-decoration:none;',
  '  transition:color .5s cubic-bezier(.22,1,.36,1); }',
  '.lang-switch a:hover{ color:var(--gold); }',
  '.lang-switch a[aria-current="page"]{ color:var(--gold); }',
  '.lang-switch .sep{ color:rgba(245,231,206,.25); }',
  '.hdr-actions{ display:flex; align-items:center; gap:1.25rem; }',
  '@media (max-width:520px){ .hdr-actions{ gap:.75rem; } }',
  '/* on narrow screens the header is tight — shrink, do not wrap */',
  '@media (max-width:520px){ .lang-switch{ gap:.35rem; font-size:.6rem;',
  '  letter-spacing:.12em; } }',
].join('\n');

function switcherHtml(current) {
  const links = LANGS.map(function (l) {
    const href = l.folder ? '/' + l.folder + '/' : '/';
    const active = l.code === current;
    return '<a href="' + href + '" hreflang="' + l.hreflang + '" lang="' + l.hreflang + '"' +
      (active ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
  }).join('<span class="sep" aria-hidden="true">·</span>');

  return '<nav aria-label="Language" dir="ltr" class="lang-switch">' + links + '</nav>';
}

/* ---------------------------------------------------------------
   Right-to-left layer. Only injected on the Hebrew page.

   Two things worth knowing:
   - Hebrew has no true italic. Browsers fake one by slanting the letters,
     which reads as a mistake to a Hebrew eye. So the gold *accent* words
     keep the gold and lose the slant.
   - Inter carries no Hebrew glyphs, so Hebrew body text needs Assistant
     or it silently falls back to a system font and looks cheap.
   --------------------------------------------------------------- */
const RTL_CSS = [
  "body{ font-family:'Assistant','Inter',sans-serif; }",
  ".font-display{ font-family:'Frank Ruhl Libre','Cormorant Garamond',serif; }",
  ".font-hebrew{ font-family:'Frank Ruhl Libre',serif; }",
  "",
  "/* Hebrew doesn't italicise - keep the gold, drop the slant. */",
  "em, .italic, .group:hover .group-hover\\:italic{ font-style:normal; }",
  ".ink-gold{ font-style:normal; }",
  "",
  "/* mirror the handful of direction-specific rules */",
  ".text-left{ text-align:right; }",
  ".text-right{ text-align:left; }",
  "@media (min-width:768px){ .md\\:text-right{ text-align:left; } }",
  ".ml-2{ margin-left:0; margin-inline-start:.5rem; }",
  ".ml-auto,.md\\:ml-auto{ margin-left:0; margin-inline-start:auto; }",
  ".pr-4{ padding-right:0; padding-inline-end:1rem; }",
  ".pr-10{ padding-right:0; padding-inline-end:2.5rem; }",
  "",
  "/* the ticker is a seamless loop - keep it running in one direction */",
  "#marquee-track{ direction:ltr; }",
  "",
  "/* prices, phone numbers and shade codes stay left-to-right */",
  ".ltr-num{ direction:ltr; unicode-bidi:isolate; display:inline-block; }",
].join('\n');

/* ---------------------------------------------------------------
   Render one language into dist/<folder>/
   --------------------------------------------------------------- */
function renderPage(template, lang, data) {
  const $ = cheerio.load(template, { decodeEntities: false });
  const url = urlFor(lang);

  /* --- document language and direction ---------------------------- */
  $('html').attr('lang', lang.hreflang).attr('dir', lang.dir);

  /* ---------------------------------------------------------------
     Make every asset path root-absolute.

     The template is written for the site root, so it links to
     "styles.css" and "images/bride.jpg". From /he/ or /fr/ a browser
     resolves those against the folder — /he/styles.css — which does not
     exist, and the page loads with no stylesheet at all.

     Rewriting to "/styles.css" fixes it for every language including
     English, where the meaning is unchanged.

     Note this deliberately only touches href/src ATTRIBUTES. The loader
     script fetches 'content.json' as a relative URL and must stay that
     way — each language folder has its own copy next to its page.
     --------------------------------------------------------------- */
  $('[href], [src]').each(function (_, el) {
    ['href', 'src'].forEach(function (attr) {
      const v = $(el).attr(attr);
      if (!v) return;
      // leave absolute URLs, anchors, and non-http schemes alone
      if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(v)) return;
      $(el).attr(attr, '/' + v.replace(/^\.\//, ''));
    });
  });

  /* --- fields that only belong on the English page ------------------ */
  if (lang.code !== 'en') {
    EN_ONLY.forEach(function (k) { $('[data-cms="' + k + '"]').remove(); });
  }

  /* --- plain text --------------------------------------------------- */
  $('[data-cms]').each(function (_, el) {
    const k = $(el).attr('data-cms');
    if (has(data, k)) $(el).text(data[k]);
  });

  /* --- headlines with *accent* words -------------------------------- */
  $('[data-cms-rich]').each(function (_, el) {
    const k = $(el).attr('data-cms-rich');
    if (has(data, k)) $(el).html(rich(data[k], 'italic ink-gold'));
  });
  $('[data-cms-quote]').each(function (_, el) {
    const k = $(el).attr('data-cms-quote');
    if (has(data, k)) $(el).html(rich(data[k], 'ink-gold not-italic font-normal'));
  });

  /* --- image alt text ----------------------------------------------- */
  $('[data-cms-alt]').each(function (_, el) {
    const k = $(el).attr('data-cms-alt');
    if (has(data, k)) $(el).attr('alt', data[k]);
  });

  /* --- animated stat numbers ---------------------------------------- */
  $('[data-cms-count]').each(function (_, el) {
    const k = $(el).attr('data-cms-count');
    if (!has(data, k)) return;
    const n = parseInt(String(data[k]).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n)) $(el).attr('data-target', String(n));
  });

  /* --- links rebuilt from the shared contact fields ------------------ */
  const wa = String(data.contact_whatsapp || '').replace(/[^0-9]/g, '');
  if (wa) {
    const suffix = data.wa_prefill ? '?text=' + encodeURIComponent(data.wa_prefill) : '';
    $('[data-link="whatsapp"]').attr('href', 'https://wa.me/' + wa + suffix);
  }
  if (has(data, 'contact_phone_dial')) {
    $('[data-link="tel"]').attr('href', 'tel:' + String(data.contact_phone_dial).replace(/[^0-9+]/g, ''));
  }
  if (has(data, 'contact_email')) {
    $('[data-link="email"]').attr('href', 'mailto:' + data.contact_email);
  }
  if (has(data, 'contact_instagram_url')) {
    $('[data-link="instagram"]').attr('href', data.contact_instagram_url);
  }

  /* --- gallery, baked in so it is crawlable without JavaScript ------- */
  const grid = $('#gallery-grid');
  if (grid.length && Array.isArray(data.gallery_items)) {
    const shapes = [
      { ratio: 'aspect-[4/5]', drop: 'md:mt-[10vh]', px: '0.05' },
      { ratio: 'aspect-[3/4]', drop: 'md:-mt-[6vh]', px: '-0.045' },
      { ratio: 'aspect-[4/5]', drop: 'md:mt-[18vh]', px: '0.06' },
    ];
    const html = data.gallery_items
      .filter(function (p) { return p && p.image; })
      .map(function (p, i) {
        const s = shapes[i % shapes.length];
        return '<figure class="col-span-12 sm:col-span-6 md:col-span-4 ' + s.drop +
          '" data-parallax="' + s.px + '">' +
          '<div data-cursor class="frame reveal-clip ' + s.ratio +
          '" style="--reveal-delay:' + ((i % 3) * 140) + 'ms">' +
          '<img src="' + esc(p.image) + '" alt="' + esc(p.alt || p.caption || '') + '" ' +
          'class="h-full w-full object-cover" loading="lazy" decoding="async" /></div>' +
          (p.caption
            ? '<figcaption class="cap mt-4 text-[0.68rem] tracking-[0.3em] uppercase text-champagne/55">' +
              esc(p.caption) + '</figcaption>'
            : '') +
          '</figure>';
      }).join('');
    grid.html(html);
  }

  /* --- scrolling ticker --------------------------------------------- */
  const track = $('#marquee-track');
  if (track.length && Array.isArray(data.marquee_items)) {
    const list = data.marquee_items.filter(function (t) { return String(t).trim().length; });
    if (list.length) {
      const inner = list.concat(list).map(function (t) {
        return esc(t) + ' <i class="not-italic text-blush">◦</i>';
      }).join(' ');
      const span = '<span class="flex items-center gap-10 pr-10 text-[0.7rem] ' +
        'tracking-[0.42em] uppercase text-gold/80">' + inner + '</span>';
      track.html(span + span);
    }
  }

  /* --- title and description ---------------------------------------- */
  if (has(data, 'seo_title')) {
    $('title').text(data.seo_title);
    $('meta[property="og:title"]').attr('content', data.seo_title);
    $('meta[name="twitter:title"]').attr('content', data.seo_title);
  }
  if (has(data, 'seo_description')) {
    $('meta[name="description"]').attr('content', data.seo_description);
    $('meta[property="og:description"]').attr('content', data.seo_description);
    $('meta[name="twitter:description"]').attr('content', data.seo_description);
  }
  $('meta[property="og:url"]').attr('content', url);
  $('meta[property="og:locale"]').attr('content', lang.locale);

  /* --- canonical + hreflang ----------------------------------------- */
  $('link[rel="canonical"]').remove();
  $('link[rel="alternate"][hreflang]').remove();
  $('meta[property="og:locale:alternate"]').remove();

  let head = '\n<link rel="canonical" href="' + url + '" />\n';
  LANGS.forEach(function (l) {
    head += '<link rel="alternate" hreflang="' + l.hreflang + '" href="' + urlFor(l) + '" />\n';
  });
  head += '<link rel="alternate" hreflang="x-default" href="' + SITE + '/" />\n';
  LANGS.filter(function (l) { return l.code !== lang.code; }).forEach(function (l) {
    head += '<meta property="og:locale:alternate" content="' + l.locale + '" />\n';
  });
  $('head').append(head);

  /* --- our own CSS: switcher on every page, RTL layer on Hebrew ------ */
  let ownCss = SWITCH_CSS;
  if (lang.code === 'he') {
    const fontLink = $('link[href*="fonts.googleapis.com/css2"]');
    if (fontLink.length) {
      const href = fontLink.attr('href');
      if (href.indexOf('Assistant') === -1) {
        fontLink.attr('href', href.replace(
          '&display=swap', '&family=Assistant:wght@300;400;600&display=swap'));
      }
    }
    ownCss += '\n' + RTL_CSS;
  }
  $('head').append('\n<style>\n' + ownCss + '\n</style>\n');

  /* --- structured data ---------------------------------------------- */
  $('script[type="application/ld+json"]').each(function (_, el) {
    let json;
    try { json = JSON.parse($(el).html()); } catch (e) { return; }

    if (json['@type'] === 'HealthAndBeautyBusiness') {
      json.url = url;
      json.inLanguage = lang.hreflang;
      if (has(data, 'seo_description')) json.description = data.seo_description;
      // @id stays identical across languages - it is one business, not four.
    }

    if (json['@type'] === 'FAQPage') {
      json.inLanguage = lang.hreflang;
      const pairs = [1, 2, 3, 4]
        .map(function (n) {
          return { q: data['pro' + n + '_title'], a: data['pro' + n + '_body'] };
        })
        .filter(function (p) { return p.q && p.a; });
      if (pairs.length) {
        json.mainEntity = pairs.map(function (p) {
          return {
            '@type': 'Question',
            name: String(p.q).trim(),
            acceptedAnswer: { '@type': 'Answer', text: String(p.a).trim() },
          };
        });
      }
    }

    $(el).html(JSON.stringify(json, null, 2));
  });

  /* --- language switcher, header and footer ------------------------- */
  const sw = switcherHtml(lang.code);

  // Header: sit the switcher next to the Reserve button rather than adding a
  // third item to the justify-between row, which would push the brand off-centre.
  const bar = $('header > div').first();
  const btn = bar.find('[data-cms="nav_button"]').first();
  if (btn.length) {
    btn.before('<div class="hdr-actions"></div>');
    const wrap = bar.find('.hdr-actions').first();
    wrap.append(sw);
    wrap.append(btn);
  } else if (bar.length) {
    bar.append(sw);
  }

  const connect = $('[data-cms="footer_connect_title"]').parent();
  if (connect.length) connect.append('<div class="mt-6">' + sw + '</div>');

  return $.html();
}

/* --- image pipeline (unchanged) ------------------------------------- */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function optimizeImage(src, dst) {
  const before = (await fs.stat(src)).size;
  const ext = path.extname(src).toLowerCase();
  let img = sharp(src).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true });
  if (ext === '.png') img = img.png({ quality: QUALITY, compressionLevel: 9 });
  else if (ext === '.webp') img = img.webp({ quality: QUALITY });
  else img = img.jpeg({ quality: QUALITY, progressive: true, mozjpeg: true });
  await img.toFile(dst);
  return [before, (await fs.stat(dst)).size];
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
        const r = await optimizeImage(src, dst);
        const saved = r[0] > 0 ? Math.round((1 - r[1] / r[0]) * 100) : 0;
        console.log('  ' + entry.name.padEnd(28) + kb(r[0]).padStart(8) +
          ' -> ' + kb(r[1]).padStart(8) + '  (-' + saved + '%)');
        totalBefore += r[0]; totalAfter += r[1]; count++;
      } catch (err) {
        console.warn('  ' + entry.name.padEnd(28) +
          ' could not be processed (' + err.message + ') - copied as-is');
        await fs.copyFile(src, dst);
      }
    } else {
      const size = (await fs.stat(src)).size;
      await fs.copyFile(src, dst);
      console.log('  ' + entry.name.padEnd(28) + kb(size).padStart(8) + '     (copied, not an image)');
      if (size > 20 * 1024 * 1024) {
        console.warn('  ^ WARNING: over 20MB. Cloudflare Pages rejects files above 25MB.');
      }
    }
  }
  return { before: totalBefore, after: totalAfter, count: count };
}

/* --- sitemap --------------------------------------------------------- */
function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = LANGS.map(function (l) {
    const alts = LANGS.map(function (a) {
      return '    <xhtml:link rel="alternate" hreflang="' + a.hreflang +
        '" href="' + urlFor(a) + '"/>';
    }).join('\n');
    return '  <url>\n' +
      '    <loc>' + urlFor(l) + '</loc>\n' +
      alts + '\n' +
      '    <xhtml:link rel="alternate" hreflang="x-default" href="' + SITE + '/"/>\n' +
      '    <lastmod>' + today + '</lastmod>\n' +
      '    <changefreq>monthly</changefreq>\n' +
      '    <priority>' + (l.code === 'en' ? '1.0' : '0.9') + '</priority>\n' +
      '  </url>';
  }).join('\n');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls + '\n</urlset>\n';
}

/* --- main ------------------------------------------------------------ */
async function main() {
  console.log('Building spraytantelaviv.com\n');

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const template = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
  const shared = await readJson(path.join(ROOT, 'content.shared.json'));

  console.log('Pages:');
  for (const lang of LANGS) {
    const file = path.join(ROOT, 'content.' + lang.code + '.json');
    if (!(await exists(file))) {
      console.warn('  ' + lang.code + ': content.' + lang.code + '.json not found - skipped');
      continue;
    }
    const data = mergeContent(shared, await readJson(file));
    const html = renderPage(template, lang, data);

    const dir = lang.folder ? path.join(OUT, lang.folder) : OUT;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.html'), html);
    // The runtime loader still fetches content.json relative to the page,
    // so a CMS edit shows up immediately without waiting for a rebuild.
    await fs.writeFile(path.join(dir, 'content.json'), JSON.stringify(data, null, 2));

    console.log('  ' + (lang.folder || '/').padEnd(4) + ' ' + lang.hreflang + '  ' +
      String(Object.keys(data).length).padStart(3) + ' fields  ' +
      kb(Buffer.byteLength(html)).padStart(8));
  }

  for (const f of ['styles.css', 'robots.txt', 'llms.txt']) {
    if (await exists(path.join(ROOT, f))) {
      await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
    } else {
      console.warn('  (' + f + ' not found - skipped)');
    }
  }
  await fs.writeFile(path.join(OUT, 'sitemap.xml'), sitemap());

  // The editor needs the source content files, not just the rendered copies.
  const sources = ['content.shared.json'].concat(LANGS.map(function (l) {
    return 'content.' + l.code + '.json';
  }));
  for (const f of sources) {
    if (await exists(path.join(ROOT, f))) {
      await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
    }
  }

  if (await exists(path.join(ROOT, 'admin'))) {
    await copyDir(path.join(ROOT, 'admin'), path.join(OUT, 'admin'));
  }

  console.log('\nImages:');
  const imgDir = path.join(ROOT, 'images');
  if (await exists(imgDir)) {
    const r = await processImages(imgDir, path.join(OUT, 'images'));
    console.log('\n  ' + r.count + ' image(s): ' + kb(r.before) + ' -> ' + kb(r.after) +
      (r.before > 0 ? '  (' + Math.round((1 - r.after / r.before) * 100) + '% smaller)' : ''));
  } else {
    console.log('  no images/ folder found');
  }

  console.log('\nDone. Publishing dist/');
}

main().catch(function (err) {
  console.error('\nBuild failed:', err);
  process.exit(1);
});
