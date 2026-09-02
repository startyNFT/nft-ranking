const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const HUB_INDEXER = 'https://marketplace-api.cosmos.stargaze-apis.com';
// Optional local file mapping collection name (case-insensitive) -> twitter handle.
// Format: { "Bad Kids": "badkidsnft", ... }. Missing file is fine — tweets will
// fall back to the collection name.
const HANDLES_FILE = path.join(__dirname, '..', 'handles.json');
// Hand-maintained creator handles. Separate from handles.json because
// snapshot-handles.js rebuilds that file wholesale and would wipe them.
const CREATORS_FILE = path.join(__dirname, '..', 'creators.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; StargazeBot/1.0)'
};

// A single dud token used to cost us the whole collection, so try a few
// different random tokens from the same collection before giving up.
const MAX_TOKEN_ATTEMPTS = 4;

// Get date range for the week (Tuesday to Monday).
// The cron fires Tuesday 01:00 UTC, but this resolves the most recent COMPLETED
// Monday from any weekday, so a manual re-run later in the week still targets —
// and overwrites — the same week folder instead of inventing a shifted one.
function getWeekRange() {
  const now = new Date();
  const monday = new Date(now);
  const daysSinceMonday = ((now.getDay() + 6) % 7) || 7; // on a Monday, use the previous one
  monday.setDate(now.getDate() - daysSinceMonday);

  const tuesday = new Date(monday);
  tuesday.setDate(monday.getDate() - 6); // 6 days before Monday

  const format = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const formatFolder = (d) => d.toISOString().split('T')[0];

  return {
    display: `${format(tuesday)} - ${format(monday)}`,
    folderName: `${formatFolder(tuesday)}_to_${formatFolder(monday)}`
  };
}

// Fetch top weekly volume collections from the Cosmos Hub indexer (Fusion indexer).
// Returns items with { name, collection_addr, twitter_acct }. twitter_acct is
// looked up in the optional handles.json file — missing entries fall back to name.
async function fetchRankings() {
  const url = `${HUB_INDEXER}/api/v1/collections?limit=9&offset=0&sort=volume7d:desc`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`Hub indexer error: ${response.status}`);
  const data = await response.json();
  const collections = data?.collections || [];

  const handleMap = loadHandleMap();
  const creatorMap = loadCreatorMap();

  return collections.map((c) => ({
    name: c.name,
    collection_addr: c.contractAddress,
    twitter_acct: handleMap.get(c.name?.toLowerCase()) || null,
    creator: creatorMap.get(c.name?.toLowerCase()) || null,
  }));
}

function loadHandleMap() {
  const map = new Map();
  if (!fs.existsSync(HANDLES_FILE)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8'));
    for (const [name, handle] of Object.entries(raw)) {
      if (name && handle) map.set(name.toLowerCase(), handle);
    }
    console.log(`Loaded ${map.size} handles from ${HANDLES_FILE}`);
  } catch (e) {
    console.log(`handles.json parse failed (${e.message}), continuing without handles`);
  }
  return map;
}

function loadCreatorMap() {
  const map = new Map();
  if (!fs.existsSync(CREATORS_FILE)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(CREATORS_FILE, 'utf8'));
    for (const [name, entry] of Object.entries(raw)) {
      if (name.startsWith('_') || !entry?.handle) continue; // skip _comment
      map.set(name.toLowerCase(), { handle: entry.handle.replace('@', ''), display: entry.display || null });
    }
    console.log(`Loaded ${map.size} creator overrides from ${CREATORS_FILE}`);
  } catch (e) {
    console.log(`creators.json parse failed (${e.message}), continuing without creator overrides`);
  }
  return map;
}

// Fetch the token list for a Cosmos Hub collection from the indexer.
async function fetchTokens(collectionAddr) {
  try {
    const url = `${HUB_INDEXER}/api/v1/tokens/${collectionAddr}?limit=50&offset=0&includeAll=true`;
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      console.log(`Hub indexer tokens error for ${collectionAddr}: ${response.status}`);
      return [];
    }
    const data = await response.json();
    return data?.tokens || [];
  } catch (error) {
    console.error(`Error fetching tokens for ${collectionAddr}:`, error.message);
    return [];
  }
}

// Pull the usable media urls off one token.
function mediaFromToken(token) {
  const media = token?.media || {};
  const mediaType = media.type;
  const mediaUrl = media.url;
  // The indexer's signed imgproxy snapshot. This is the only source that is
  // reliably fetchable from CI — see downloadCover — so we keep it for every
  // media type, not just the non-image ones.
  const staticUrl = media?.visualAssets?.xl?.staticUrl
                 || media?.visualAssets?.lg?.staticUrl
                 || media.fallbackUrl;
  const isImage = !mediaType || mediaType === 'image';
  const imageUrl = isImage ? (mediaUrl || staticUrl) : (staticUrl || mediaUrl);
  if (!imageUrl) return null;
  return { tokenId: token?.tokenId, imageUrl, mediaType, mediaUrl, staticUrl, isImage };
}

// Shuffle a copy so successive attempts land on different tokens.
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Try IPFS gateways for a given URL. Cosmos Hub indexer media lives on
// ipfs.rscdn.art; legacy Stargaze links may still point at ipfs-gw.stargaze-apis.com.
// NOTE (2026-09-02): ipfs.rscdn.art now sits behind a Cloudflare challenge and
// answers 403 to every non-browser client, and the public gateways below are
// rate-limited to the point of uselessness from a CI runner. These hops are a
// last resort — the signed i.rscdn.art staticUrl in downloadCover is the real path.
function getGatewayUrls(url) {
  const candidates = [url];
  const legacyHosts = ['ipfs.rscdn.art', 'ipfs-gw.stargaze-apis.com'];
  // cloudflare-ipfs.com was retired upstream and no longer resolves — dropped.
  const fallbacks = ['gateway.pinata.cloud', 'ipfs.io', 'dweb.link'];
  for (const legacy of legacyHosts) {
    if (url.includes(legacy)) {
      for (const fb of fallbacks) candidates.push(url.replace(legacy, fb));
    }
  }
  return candidates;
}

// Extract a PNG URL from HTML content (og:image or apple-touch-icon)
function extractPngFromHtml(html) {
  // Try og:image — handle both attribute orderings
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+\.png)"/) ||
                  html.match(/<meta[^>]*content="([^"]+\.png)"[^>]*property="og:image"/);
  if (ogMatch) return ogMatch[1];

  // Try apple-touch-icon — handle both attribute orderings, prefer 512px
  const iconMatch = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+png512[^"]*\.png)"/) ||
                    html.match(/<link[^>]*href="([^"]+png512[^"]*\.png)"[^>]*rel="apple-touch-icon"/);
  if (iconMatch) return iconMatch[1];

  // Try any apple-touch-icon png
  const anyIconMatch = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*href="([^"]+\.png)"/) ||
                       html.match(/<link[^>]*href="([^"]+\.png)"[^>]*rel="apple-touch-icon"/);
  if (anyIconMatch) return anyIconMatch[1];

  return null;
}

// Fetch an HTML media URL and extract the embedded PNG
async function extractPngFromMediaUrl(mediaUrl) {
  const gateways = getGatewayUrls(mediaUrl);
  for (const gatewayUrl of gateways) {
    try {
      console.log(`Fetching HTML for PNG extraction: ${gatewayUrl}`);
      const response = await fetch(gatewayUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) {
        const html = await response.text();
        const pngUrl = extractPngFromHtml(html);
        if (pngUrl) return pngUrl;
        console.log(`No PNG found in HTML from ${gatewayUrl}`);
      }
    } catch (e) {
      console.log(`HTML fetch error: ${e.message}`);
    }
  }
  return null;
}

// Download image and save to disk
async function downloadImage(url, filepath) {
  try {
    const gateways = getGatewayUrls(url);

    for (const gatewayUrl of gateways) {
      try {
        console.log(`Trying: ${gatewayUrl}`);
        const response = await fetch(gatewayUrl, {
          headers: HEADERS,
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          console.log(`Failed with status ${response.status}`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';

        // If response is HTML, extract the embedded PNG URL and download that instead
        if (contentType.includes('text/html')) {
          const html = await response.text();
          const pngUrl = extractPngFromHtml(html);
          if (pngUrl) {
            console.log(`HTML response detected, extracted PNG: ${pngUrl}`);
            const pngFilepath = filepath.replace(/\.\w+$/, '.png');
            return await downloadDirectImage(pngUrl, pngFilepath);
          }
          console.log(`HTML response but no embedded PNG found`);
          continue;
        }

        // If response is SVG, rasterize to PNG with sharp
        if (contentType.includes('svg')) {
          console.log(`SVG response detected, rasterizing to PNG`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const pngFilepath = filepath.replace(/\.\w+$/, '.png');
          try {
            await sharp(buffer, { density: 300 }).resize(1024, 1024, { fit: 'inside' }).png().toFile(pngFilepath);
            console.log(`Rasterized SVG to PNG`);
            return true;
          } catch (e) {
            console.error(`SVG rasterize failed: ${e.message}, falling back to .svg`);
            const svgFilepath = filepath.replace(/\.\w+$/, '.svg');
            fs.writeFileSync(svgFilepath, buffer);
            return true;
          }
        }

        // Standard image — save directly
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filepath, Buffer.from(buffer));
        console.log(`Downloaded successfully from ${gatewayUrl}`);
        return true;
      } catch (e) {
        console.log(`Gateway error: ${e.message}`);
      }
    }

    console.error(`All gateways failed for ${url}`);
    return false;
  } catch (error) {
    console.error(`Error downloading ${url}:`, error.message);
    return false;
  }
}

// Download a direct image URL (used for extracted PNGs from HTML)
async function downloadDirectImage(url, filepath) {
  const gateways = getGatewayUrls(url);
  for (const gatewayUrl of gateways) {
    try {
      console.log(`Downloading PNG: ${gatewayUrl}`);
      const response = await fetch(gatewayUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filepath, Buffer.from(buffer));
        console.log(`Downloaded PNG successfully`);
        return true;
      }
    } catch (e) {
      console.log(`PNG gateway error: ${e.message}`);
    }
  }
  console.error(`All gateways failed for PNG: ${url}`);
  return false;
}

// Download one cover for a ranked collection. Returns true on success.
// Order matters: the signed imgproxy staticUrl goes FIRST for every media type.
// It is the only source that reliably answers 200 from CI — the raw ipfs.rscdn.art
// host is Cloudflare-gated (403) and the public gateways rate-limit — and this
// ordering is what stopped plain-image collections dropping out of the grid.
async function downloadCover(candidate, imagesDir, rank, safeName) {
  const { imageUrl, mediaType, mediaUrl, staticUrl } = candidate;

  // imgproxy snapshot -> re-encode to PNG locally. It serves webp and the URL is
  // signed, so we can't ask the proxy for another format, and we never ship webp.
  if (staticUrl) {
    console.log(`Using rasterized staticUrl (${mediaType || 'standard'})`);
    const tmpPath = path.join(imagesDir, `${rank}_${safeName}.tmp`);
    const finalPath = path.join(imagesDir, `${rank}_${safeName}.png`);
    if (await downloadDirectImage(staticUrl, tmpPath)) {
      try {
        await sharp(tmpPath).png().toFile(finalPath);
        fs.unlinkSync(tmpPath);
        return true;
      } catch (e) {
        console.error(`PNG re-encode failed: ${e.message}`);
        fs.unlinkSync(tmpPath);
      }
    }
  }

  // HTML-specific fallback: extract og:image / apple-touch-icon from the page
  if (mediaType === 'html' && mediaUrl) {
    console.log(`HTML media, attempting og:image extraction...`);
    const pngUrl = await extractPngFromMediaUrl(mediaUrl);
    if (pngUrl) {
      const filepath = path.join(imagesDir, `${rank}_${safeName}.png`);
      if (await downloadDirectImage(pngUrl, filepath)) return true;
    }
  }

  // Last resort: the original media url straight off the IPFS gateways.
  const urlPath = new URL(imageUrl).pathname;
  let ext = path.extname(urlPath) || '.png';
  if (ext.length > 5) ext = '.png';
  return await downloadImage(imageUrl, path.join(imagesDir, `${rank}_${safeName}${ext}`));
}

// NOTE: the Typefully draft is created AFTER the video renders, by
// scripts/post-draft.js, so the rendered video can be attached to it. Here we
// just persist the tweet text (tweet.txt) for that step to consume.

// Update README with current week info
function updateReadme(weekRange) {
  const readme = `# Stargaze NFT Weekly Ranking

Automated weekly top volume NFT collections on Stargaze (Cosmos Hub).

## Images

The \`images/\` folder contains NFT images from the top collections each week.

**Current Week:** ${weekRange.display}

---

*Updated automatically via GitHub Actions*
`;
  fs.writeFileSync('README.md', readme);
}

// Main function
async function main() {
  console.log('Fetching rankings from Metabase...');
  const rankings = await fetchRankings();
  console.log(`Found ${rankings.length} collections`);

  const weekRange = getWeekRange();
  console.log(`Week: ${weekRange.display}`);

  // Keep ONLY the current week. Previous runs left a dated subfolder per week,
  // so images/ accumulated every week and anyone pulling the repo had to download
  // them all. Wipe everything (except .gitkeep) before regenerating this week's set.
  const imagesRoot = 'images';
  if (fs.existsSync(imagesRoot)) {
    for (const entry of fs.readdirSync(imagesRoot)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(imagesRoot, entry), { recursive: true, force: true });
      console.log(`Removed previous week: ${entry}`);
    }
  }

  // Create images folder for this week
  const imagesDir = path.join('images', weekRange.folderName);
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log(`Created directory: ${imagesDir}`);

  // Build tweet and download images
  const medals = ['🥇', '🥈', '🥉'];
  let tweetLines = ['Stargaze on Cosmos Hub — Weekly Top Volume 💫', '', 'Congratulations:', ''];

  // rank -> exact collection name (with original punctuation), consumed by the
  // video build (video/scripts/build-props.js) so title overrides match the real
  // names rather than the punctuation-mangled image filenames.
  const ranking = {};

  // Ranks we failed to get a cover for — reported loudly at the end so a short
  // week is never mistaken for a clean run.
  const missing = [];

  // Count twitter handles so shared ones (e.g. two collections both @DeFiGeeksNFT)
  // can be disambiguated in the tweet with the collection name.
  const handleCounts = {};
  for (const c of rankings) {
    if (c.creator) continue; // its line already carries the collection name
    if (c.twitter_acct) {
      const h = c.twitter_acct.replace('@', '').toLowerCase();
      handleCounts[h] = (handleCounts[h] || 0) + 1;
    }
  }

  for (let i = 0; i < rankings.length; i++) {
    const collection = rankings[i];
    const name = collection.name;
    ranking[i + 1] = name;
    const twitter = collection.twitter_acct;
    const creator = collection.creator;
    const collectionAddr = collection.collection_addr;

    console.log(`\nProcessing ${i + 1}. ${name} (${collectionAddr})`);

    // Tweet line — when a handle is shared by multiple ranked collections,
    // append the collection name so each line is unambiguous.
    const prefix = i < 3 ? `${medals[i]} ` : '✦ ';
    let handle;
    if (creator) {
      // The handle is a person/studio, not the collection's own account, so lead
      // with the collection and credit the creator after it.
      handle = `${creator.display || name} ( @${creator.handle} )`;
    } else if (twitter) {
      const at = `@${twitter.replace('@', '')}`;
      const shared = handleCounts[twitter.replace('@', '').toLowerCase()] > 1;
      handle = shared ? `${at} (${name})` : at;
    } else {
      handle = name;
    }
    tweetLines.push(`${prefix}${handle}`);

    // Download the cover. One dud token used to lose the whole collection: its
    // slot vanished and every lower-ranked card slid up into the wrong position,
    // so try several random tokens before writing the collection off.
    const tokens = await fetchTokens(collectionAddr);
    const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
    let success = false;

    if (tokens.length === 0) {
      console.log(`No tokens found for ${name}`);
    }
    for (const token of shuffled(tokens).slice(0, MAX_TOKEN_ATTEMPTS)) {
      const candidate = mediaFromToken(token);
      if (!candidate) continue;
      console.log(`Token ${candidate.tokenId}: ${candidate.imageUrl} (media type: ${candidate.mediaType || 'standard'})`);
      success = await downloadCover(candidate, imagesDir, i + 1, safeName);
      if (success) break;
      console.log(`Token ${candidate.tokenId} failed — trying another token`);
    }

    if (success) {
      const base = `${i + 1}_${safeName}`;
      const saved = fs.readdirSync(imagesDir).find(f => f.startsWith(base));
      console.log(`Saved: ${saved}`);
    } else {
      missing.push(`${i + 1}. ${name}`);
      console.error(`NO COVER for ${i + 1}. ${name}`);
    }
  }

  // Persist the rank -> real-name manifest alongside this week's images.
  fs.writeFileSync(path.join(imagesDir, 'ranking.json'), JSON.stringify(ranking, null, 2));

  tweetLines.push('', 'Trade them all on the Cosmos Hub: stargaze.zone');
  const tweet = tweetLines.join('\n');

  console.log('\n--- Tweet ---');
  console.log(tweet);
  console.log('-------------\n');

  // Persist the tweet for the post-render draft step (scripts/post-draft.js),
  // which uploads the rendered video and creates the Typefully draft with it.
  fs.writeFileSync(path.join(imagesDir, 'tweet.txt'), tweet);
  console.log(`Wrote ${path.join(imagesDir, 'tweet.txt')}`);

  // Update README
  updateReadme(weekRange);

  if (missing.length) {
    console.error(`\n⚠ MISSING ${missing.length} of ${rankings.length} covers:`);
    for (const m of missing) console.error(`   - ${m}`);
    console.error('The video build refuses to render a partial grid, so the draft');
    console.error('falls back to text-only and the run is marked failed.\n');
  }

  console.log('Done!');
}

main().catch(console.error);
