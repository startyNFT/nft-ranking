// Rebuilds handles.json from two sources:
//   1. Stargaze Metabase — collections → Stargaze Names → name_records('twitter')
//   2. Google Sheet — team-maintained fallback of collection → @handle
// Metabase entries win on conflict (they come from on-chain self-attested records).
//
// Usage: METABASE_PASSWORD=xxx node scripts/snapshot-handles.js
// (METABASE_USER defaults to carolineyama@gmail.com)

const fs = require('fs');
const path = require('path');

const METABASE_URL = 'https://metabase.stargaze-apis.com';
const METABASE_USER = process.env.METABASE_USER || 'carolineyama@gmail.com';
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;
const MAINNET_DB_ID = 3;

const FALLBACK_SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1hM8VEI5gmp4SUcXrZ3NzA71EzMgeesNSrRqqHtFK69g/export?format=csv';

const HANDLES_PATH = path.join(__dirname, '..', 'handles.json');

const SQL = `
  SELECT c.name AS collection_name, nr.record_value AS twitter_acct
  FROM collections c
  JOIN names n ON n.associated_addr = c.sg721_addr
  JOIN name_records nr ON nr.name = n.name AND nr.record_name = 'twitter'
  WHERE c.name IS NOT NULL
    AND nr.record_value IS NOT NULL
    AND nr.record_value <> ''
  ORDER BY c.name
`;

async function metabaseLogin() {
  if (!METABASE_PASSWORD) throw new Error('METABASE_PASSWORD env var required');
  const r = await fetch(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: METABASE_USER, password: METABASE_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Metabase login failed: ${r.status}`);
  return (await r.json()).id;
}

async function fetchMetabaseHandles(session) {
  const r = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': session },
    body: JSON.stringify({
      database: MAINNET_DB_ID,
      type: 'native',
      native: { query: SQL },
    }),
  });
  if (!r.ok) throw new Error(`Metabase query failed: ${r.status}`);
  const d = await r.json();
  const rows = d?.data?.rows || [];
  const map = {};
  for (const [name, handle] of rows) {
    if (!name || !handle) continue;
    const clean = String(handle).trim().replace(/^@/, '');
    if (clean) map[name] = clean;
  }
  return map;
}

function parseCsv(text) {
  // Minimal CSV parser for the handles sheet (no quoted commas observed).
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 2) continue;
    const name = cols[0].trim();
    const handle = cols.slice(1).join(',').trim();
    if (name && handle) rows.push([name, handle.replace(/^@/, '')]);
  }
  return rows;
}

async function fetchSheetHandles() {
  const r = await fetch(FALLBACK_SHEET_CSV);
  if (!r.ok) throw new Error(`Sheet fetch failed: ${r.status}`);
  return parseCsv(await r.text());
}

async function main() {
  console.log('Authenticating with Metabase...');
  const session = await metabaseLogin();

  console.log('Fetching Metabase handles (Stargaze Names twitter records)...');
  const metabase = await fetchMetabaseHandles(session);
  console.log(`  ${Object.keys(metabase).length} entries`);

  console.log('Fetching Google Sheet fallback...');
  const sheetRows = await fetchSheetHandles();
  console.log(`  ${sheetRows.length} entries`);

  const merged = { ...metabase };
  const metaKeys = new Set(Object.keys(metabase).map((k) => k.toLowerCase()));
  let sheetAdded = 0;
  for (const [name, handle] of sheetRows) {
    if (metaKeys.has(name.toLowerCase())) continue;
    if (merged[name] && merged[name] !== handle) continue;
    merged[name] = handle;
    sheetAdded++;
  }

  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
  );
  fs.writeFileSync(HANDLES_PATH, JSON.stringify(sorted, null, 2));
  console.log(`Wrote ${Object.keys(sorted).length} handles to ${HANDLES_PATH}`);
  console.log(`  ${Object.keys(metabase).length} from Metabase, +${sheetAdded} filled from Sheet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
