const fs = require('fs');
const path = require('path');

const HUB_INDEXER = 'https://marketplace-api.cosmos.stargaze-apis.com';
// Optional local file mapping collection name (case-insensitive) -> twitter handle.
// Format: { "Bad Kids": "badkidsnft", ... }. Missing file is fine — tweets will
// fall back to the collection name.
const HANDLES_FILE = path.join(__dirname, '..', 'handles.json');
const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; StargazeBot/1.0)'
};

// Get date range for the week (Tuesday to Monday)
function getWeekRange() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - 1); // Yesterday was Monday

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

  return collections.map((c) => ({
    name: c.name,
    collection_addr: c.contractAddress,
    twitter_acct: handleMap.get(c.name?.toLowerCase()) || null,
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

// Fetch a random NFT image from a Cosmos Hub collection via the indexer.
async function fetchNFTImage(collectionAddr) {
  try {
    const url = `${HUB_INDEXER}/api/v1/tokens/${collectionAddr}?limit=50&offset=0&includeAll=true`;
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      console.log(`Hub indexer tokens error for ${collectionAddr}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const tokens = data?.tokens || [];

    if (tokens.length === 0) {
      console.log(`No tokens found for ${collectionAddr}`);
      return null;
    }

    const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
    const media = randomToken?.media || {};
    // Prefer the original IPFS URL for best quality; keep fallback/proxied URL
    // handy because some HTML-based tokens expose their PNG via the proxy.
    const imageUrl = media.url || media.fallbackUrl;
    const mediaType = media.type;
    const mediaUrl = media.url;

    if (!imageUrl) {
      console.log(`Token ${randomToken?.tokenId} has no usable media url`);
      return null;
    }

    console.log(`Found image for token ${randomToken?.tokenId}: ${imageUrl} (media type: ${mediaType || 'standard'})`);
    return { imageUrl, mediaType, mediaUrl };
  } catch (error) {
    console.error(`Error fetching NFT for ${collectionAddr}:`, error.message);
    return null;
  }
}

// Try IPFS gateways for a given URL. Cosmos Hub indexer media lives on
// ipfs.rscdn.art; legacy Stargaze links may still point at ipfs-gw.stargaze-apis.com.
function getGatewayUrls(url) {
  const candidates = [url];
  const legacyHosts = ['ipfs.rscdn.art', 'ipfs-gw.stargaze-apis.com'];
  const fallbacks = ['cloudflare-ipfs.com', 'ipfs.io', 'gateway.pinata.cloud'];
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
          timeout: 10000
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

        // If response is SVG, save it but also try to get a PNG version
        if (contentType.includes('svg')) {
          console.log(`SVG response detected, saving as SVG`);
          const buffer = await response.arrayBuffer();
          const svgFilepath = filepath.replace(/\.\w+$/, '.svg');
          fs.writeFileSync(svgFilepath, Buffer.from(buffer));
          console.log(`Downloaded SVG from ${gatewayUrl}`);
          return true;
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
        timeout: 10000
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

// Create Typefully draft (v2 API)
const TYPEFULLY_SOCIAL_SET_ID = '75309'; // StargazeZone

async function createTypefullyDraft(tweet) {
  if (!TYPEFULLY_API_KEY) {
    console.log('No Typefully API key, skipping draft creation');
    console.log('Tweet content:\n', tweet);
    return;
  }

  const response = await fetch(`https://api.typefully.com/v2/social-sets/${TYPEFULLY_SOCIAL_SET_ID}/drafts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TYPEFULLY_API_KEY}`,
      ...HEADERS
    },
    body: JSON.stringify({
      platforms: {
        x: {
          enabled: true,
          posts: [{ text: tweet }]
        }
      }
    })
  });

  if (response.ok) {
    const data = await response.json();
    console.log('Typefully draft created successfully');
    console.log(`Draft URL: ${data.private_url}`);
  } else {
    console.error('Failed to create Typefully draft:', await response.text());
  }
}

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

  // Create images folder for this week
  const imagesDir = path.join('images', weekRange.folderName);
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log(`Created directory: ${imagesDir}`);

  // Build tweet and download images
  const medals = ['🥇', '🥈', '🥉'];
  let tweetLines = ['Stargaze on Cosmos Hub — Weekly Top Volume 💫', '', 'Congratulations:', ''];

  for (let i = 0; i < rankings.length; i++) {
    const collection = rankings[i];
    const name = collection.name;
    const twitter = collection.twitter_acct;
    const collectionAddr = collection.collection_addr;

    console.log(`\nProcessing ${i + 1}. ${name} (${collectionAddr})`);

    // Tweet line
    const prefix = i < 3 ? `${medals[i]} ` : '';
    const handle = twitter ? `@${twitter.replace('@', '')}` : name;
    tweetLines.push(`${prefix}${handle}`);

    // Download NFT image
    const result = await fetchNFTImage(collectionAddr);

    if (result) {
      const { imageUrl, mediaType, mediaUrl } = result;
      const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
      let success = false;

      // For HTML-based NFTs (e.g. Pixel Wizards), fetch the HTML to extract a PNG
      if (mediaType === 'html' && mediaUrl) {
        console.log(`HTML media detected, fetching for PNG extraction...`);
        const pngUrl = await extractPngFromMediaUrl(mediaUrl);
        if (pngUrl) {
          const filepath = path.join(imagesDir, `${i + 1}_${safeName}.png`);
          success = await downloadDirectImage(pngUrl, filepath);
        }
      }

      // Fallback: download the imageUrl directly
      if (!success) {
        const urlPath = new URL(imageUrl).pathname;
        let ext = path.extname(urlPath) || '.png';
        if (ext.length > 5) ext = '.png';
        const filename = `${i + 1}_${safeName}${ext}`;
        const filepath = path.join(imagesDir, filename);
        success = await downloadImage(imageUrl, filepath);
      }

      if (success) {
        const base = `${i + 1}_${safeName}`;
        const saved = fs.readdirSync(imagesDir).find(f => f.startsWith(base));
        console.log(`Saved: ${saved}`);
      }
    } else {
      console.log(`No image found for ${name}`);
    }
  }

  tweetLines.push('', 'Trade them all on Cosmos Hub: stargaze.zone');
  const tweet = tweetLines.join('\n');

  console.log('\n--- Tweet ---');
  console.log(tweet);
  console.log('-------------\n');

  // Create Typefully draft
  await createTypefullyDraft(tweet);

  // Update README
  updateReadme(weekRange);

  console.log('Done!');
}

main().catch(console.error);
