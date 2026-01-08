const fs = require('fs');
const path = require('path');

const METABASE_URL = 'https://metabase.stargaze-apis.com/public/question/9d4643d8-1cdc-430c-9865-8978a202862c.json';
const STARGAZE_GRAPHQL = 'https://graphql.mainnet.stargaze-apis.com/graphql';
const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;

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

// Fetch rankings from Metabase
async function fetchRankings() {
  const response = await fetch(METABASE_URL);
  const data = await response.json();
  return data.slice(0, 9); // Top 9
}

// Fetch random NFT image from a collection
async function fetchNFTImage(collectionAddr) {
  const query = `
    query {
      tokens(collectionAddr: "${collectionAddr}", limit: 50) {
        tokens {
          tokenId
          media { url }
          image { url }
        }
      }
    }
  `;

  try {
    const response = await fetch(STARGAZE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const data = await response.json();
    const tokens = data?.data?.tokens?.tokens || [];

    if (tokens.length === 0) return null;

    // Pick a random token
    const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
    const imageUrl = randomToken?.media?.url || randomToken?.image?.url;

    // Convert IPFS URL to HTTP if needed
    if (imageUrl?.startsWith('ipfs://')) {
      return imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    return imageUrl;
  } catch (error) {
    console.error(`Error fetching NFT for ${collectionAddr}:`, error.message);
    return null;
  }
}

// Download image and save to disk
async function downloadImage(url, filepath) {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(buffer));
    return true;
  } catch (error) {
    console.error(`Error downloading ${url}:`, error.message);
    return false;
  }
}

// Create Typefully draft
async function createTypefullyDraft(tweet) {
  if (!TYPEFULLY_API_KEY) {
    console.log('No Typefully API key, skipping draft creation');
    console.log('Tweet content:\n', tweet);
    return;
  }

  const response = await fetch('https://api.typefully.com/v1/drafts/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': TYPEFULLY_API_KEY
    },
    body: JSON.stringify({
      content: tweet,
      threadify: false
    })
  });

  if (response.ok) {
    console.log('Typefully draft created successfully');
  } else {
    console.error('Failed to create Typefully draft:', await response.text());
  }
}

// Update README with current week info
function updateReadme(weekRange) {
  const readme = `# Stargaze NFT Weekly Ranking

Automated weekly top volume NFT collections on Stargaze.

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

  const weekRange = getWeekRange();
  console.log(`Week: ${weekRange.display}`);

  // Create images folder for this week
  const imagesDir = path.join('images', weekRange.folderName);
  fs.mkdirSync(imagesDir, { recursive: true });

  // Build tweet and download images
  const medals = ['🥇', '🥈', '🥉'];
  let tweetLines = ['Stargaze Weekly Top Volume 💫', '', 'Congratulations:', ''];

  for (let i = 0; i < rankings.length; i++) {
    const collection = rankings[i];
    const name = collection.name;
    const twitter = collection.twitter_acct;
    const collectionAddr = collection.collection_addr;

    // Tweet line
    const prefix = i < 3 ? `${medals[i]} ` : '';
    const handle = twitter ? `@${twitter.replace('@', '')}` : name;
    tweetLines.push(`${prefix}${handle}`);

    // Download NFT image
    console.log(`Fetching image for ${name}...`);
    const imageUrl = await fetchNFTImage(collectionAddr);

    if (imageUrl) {
      const ext = imageUrl.split('.').pop()?.split('?')[0] || 'png';
      const filename = `${i + 1}_${name.replace(/[^a-zA-Z0-9]/g, '_')}.${ext}`;
      const filepath = path.join(imagesDir, filename);
      await downloadImage(imageUrl, filepath);
      console.log(`Saved: ${filename}`);
    }
  }

  tweetLines.push('', 'Trade them all at stargaze.zone');
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
