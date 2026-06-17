/*
 * build-props.js
 * Turns the weekly ranking output (../images/<week>/N_Name.ext) into render props
 * for the Remotion "TopVolume" composition.
 *
 *  - copies the 9 ranked cover images into video/public/cards/1..9.<ext>
 *  - resolves on-brand display names via names.json overrides
 *  - stamps the on-screen date (the Tuesday it publishes = today, en-US)
 *  - writes video/src/_data.json (used as defaultProps in Studio AND via --props on render)
 */
const fs = require("fs");
const path = require("path");

const VIDEO_DIR = path.join(__dirname, "..");
const REPO_ROOT = path.join(VIDEO_DIR, "..");
const IMAGES_ROOT = path.join(REPO_ROOT, "images");
const NAMES_FILE = path.join(VIDEO_DIR, "names.json");
const PUBLIC_CARDS = path.join(VIDEO_DIR, "public", "cards");
const DATA_OUT = path.join(VIDEO_DIR, "src", "_data.json");

const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function prettify(raw) {
  // De-underscored filename already passed in; just tidy whitespace.
  return raw.replace(/\s+/g, " ").trim();
}

function loadOverrides() {
  if (!fs.existsSync(NAMES_FILE)) return new Map();
  const raw = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue; // skip _comment etc.
    map.set(k.toLowerCase(), v);
  }
  return map;
}

function findWeekDir() {
  if (!fs.existsSync(IMAGES_ROOT)) throw new Error(`No images/ folder at ${IMAGES_ROOT}`);
  const dirs = fs
    .readdirSync(IMAGES_ROOT)
    .filter((f) => f !== ".gitkeep")
    .map((f) => path.join(IMAGES_ROOT, f))
    .filter((p) => fs.statSync(p).isDirectory());
  if (dirs.length === 0) throw new Error("No week folder found under images/");
  // The pipeline keeps only the current week, but if several exist pick the newest by name.
  dirs.sort();
  return dirs[dirs.length - 1];
}

function main() {
  const overrides = loadOverrides();
  const weekDir = findWeekDir();

  const files = fs
    .readdirSync(weekDir)
    .filter((f) => IMG_RE.test(f))
    .sort((a, b) => (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99));

  if (files.length < 9) {
    console.warn(`Warning: only ${files.length} cover images found (expected 9).`);
  }

  // rank -> real collection name (written by fetch-ranking.js). When present we use
  // these instead of the punctuation-mangled filenames so overrides match.
  const manifestPath = path.join(weekDir, "ranking.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  if (!manifest) console.warn("No ranking.json manifest — falling back to filename-derived names.");

  // Reset public/cards
  fs.rmSync(PUBLIC_CARDS, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_CARDS, { recursive: true });

  const cards = files.slice(0, 9).map((f, i) => {
    const rank = parseInt(f, 10) || i + 1; // rank from the filename prefix (robust to gaps)
    const ext = path.extname(f).toLowerCase();
    fs.copyFileSync(path.join(weekDir, f), path.join(PUBLIC_CARDS, `${rank}${ext}`));

    const realName = manifest && manifest[String(rank)];
    const rawName = realName || prettify(f.replace(/^\d+_/, "").replace(IMG_RE, "").replace(/_/g, " "));
    const name = overrides.get(rawName.toLowerCase()) || rawName;
    // Titles must ALWAYS fit one line. ~18 chars is the practical limit at the card
    // width/font; flag anything longer so a short override can be added to names.json.
    if (name.length > 18) {
      console.warn(`  ⚠ Title "${name}" (${name.length} chars) may overflow one line — add a shorter override in names.json`);
    }
    return { name, image: `cards/${rank}${ext}` };
  });

  const d = new Date();
  const data = {
    title: "WEEKLY TOP VOLUME",
    date: {
      month: d.toLocaleString("en-US", { month: "long" }),
      day: d.getDate(),
      ordinal: ordinal(d.getDate()),
      year: d.getFullYear(),
    },
    cards,
  };

  fs.writeFileSync(DATA_OUT, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${DATA_OUT}`);
  console.log(`Week: ${path.basename(weekDir)}  |  ${data.date.month} ${data.date.day}${data.date.ordinal}, ${data.date.year}`);
  cards.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  <- ${c.image}`));
}

main();
