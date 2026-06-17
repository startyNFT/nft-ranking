/*
 * post-draft.js
 * Creates the weekly Typefully DRAFT (never publishes/schedules), with the
 * rendered video attached. Runs AFTER fetch-ranking.js (which writes tweet.txt)
 * and the Remotion render (which writes video/out/weekly-top-volume.mp4).
 *
 * If the video is missing (e.g. the render step failed), it still creates a
 * text-only draft so there is always a draft to review.
 *
 * Env: TYPEFULLY_API_KEY (required to actually create the draft).
 */
const fs = require("fs");
const path = require("path");

const KEY = process.env.TYPEFULLY_API_KEY;
const SOCIAL_SET_ID = "75309"; // StargazeZone
const BASE = "https://api.typefully.com";

const REPO_ROOT = path.join(__dirname, "..");
const IMAGES_ROOT = path.join(REPO_ROOT, "images");
const VIDEO = path.join(REPO_ROOT, "video", "out", "weekly-top-volume.mp4");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newestWeekDir() {
  const dirs = fs
    .readdirSync(IMAGES_ROOT)
    .filter((f) => f !== ".gitkeep")
    .map((f) => path.join(IMAGES_ROOT, f))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort();
  return dirs[dirs.length - 1];
}

async function uploadVideo(auth) {
  const up = await fetch(`${BASE}/v2/social-sets/${SOCIAL_SET_ID}/media/upload`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ file_name: "weekly-top-volume.mp4" }),
  });
  if (!up.ok) throw new Error(`media/upload ${up.status}: ${await up.text()}`);
  const { media_id, upload_url } = await up.json();
  const put = await fetch(upload_url, { method: "PUT", body: fs.readFileSync(VIDEO) });
  if (!put.ok) throw new Error(`PUT upload ${put.status}: ${await put.text()}`);
  console.log(`Uploaded video, media_id ${media_id}`);
  return media_id;
}

async function createDraft(auth, tweet, mediaIds) {
  const post = { text: tweet };
  if (mediaIds && mediaIds.length) post.media_ids = mediaIds;
  const body = JSON.stringify({
    // No publish_at / scheduled_date -> stays an unpublished DRAFT.
    platforms: { x: { enabled: true, posts: [post], settings: {} } },
    draft_title: "Weekly Top Volume",
  });

  // Media may still be processing right after upload; retry the draft create.
  for (let i = 0; i < 24; i++) {
    const r = await fetch(`${BASE}/v2/social-sets/${SOCIAL_SET_ID}/drafts`, { method: "POST", headers: auth, body });
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (text.includes("processing")) {
      console.log(`Media still processing, waiting (${i + 1})...`);
      await sleep(5000);
      continue;
    }
    throw new Error(`drafts ${r.status}: ${text}`);
  }
  throw new Error("Timed out waiting for media processing");
}

async function main() {
  const weekDir = newestWeekDir();
  const tweetPath = path.join(weekDir, "tweet.txt");
  if (!fs.existsSync(tweetPath)) throw new Error(`No tweet.txt in ${weekDir}`);
  const tweet = fs.readFileSync(tweetPath, "utf8");

  if (!KEY) {
    console.log("No TYPEFULLY_API_KEY — skipping draft creation. Tweet would be:\n" + tweet);
    return;
  }
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

  let mediaIds = [];
  if (fs.existsSync(VIDEO)) {
    try {
      mediaIds = [await uploadVideo(auth)];
    } catch (e) {
      console.error(`Video upload failed (${e.message}) — falling back to a text-only draft.`);
    }
  } else {
    console.warn(`No rendered video at ${VIDEO} — creating a text-only draft.`);
  }

  const draft = await createDraft(auth, tweet, mediaIds);
  console.log(`Typefully draft created${mediaIds.length ? " WITH video" : " (text only)"}: ${draft.private_url}`);
}

main().catch((e) => {
  console.error("post-draft failed:", e.message);
  process.exit(1);
});
