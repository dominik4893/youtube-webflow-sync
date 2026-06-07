const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
const WEBFLOW_COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

if (!YOUTUBE_API_KEY || !WEBFLOW_TOKEN || !WEBFLOW_COLLECTION_ID) {
  throw new Error("Missing required environment variables.");
}

const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

async function webflowRequest(path, options = {}) {
  const response = await fetch(`${WEBFLOW_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WEBFLOW_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Webflow API error ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function youtubeRequest(videoIds) {
  const params = new URLSearchParams({
    key: YOUTUBE_API_KEY,
    part: "statistics",
    id: videoIds.join(","),
  });

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`YouTube API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data.items || [];
}

async function getAllWebflowItems() {
  let offset = 0;
  const limit = 100;
  const allItems = [];

  while (true) {
    const data = await webflowRequest(
      `/collections/${WEBFLOW_COLLECTION_ID}/items?limit=${limit}&offset=${offset}`
    );

    const items = data.items || [];
    allItems.push(...items);

    if (items.length < limit) break;
    offset += limit;
  }

  return allItems;
}

function getField(item, fieldSlug) {
  return item.fieldData?.[fieldSlug];
}

function getItemId(item) {
  return item.id || item._id;
}

async function updateWebflowItem(item, stats) {
  const itemId = getItemId(item);

  if (!itemId) {
    console.warn("Skipping item without ID:", item);
    return null;
  }

  const fieldData = {
    ...item.fieldData,

    /*
      DÔLEŽITÉ:
      tieto názvy musia sedieť s tvojimi Webflow field slugs.
      Skontroluj vo Webflow CMS, či máš slugs:
      likes, comments, views, last-synced
    */
    likes: Number(stats.likeCount || 0),
    comments: Number(stats.commentCount || 0),
    views: Number(stats.viewCount || 0),
    "last-synced": new Date().toISOString(),
  };

  await webflowRequest(`/collections/${WEBFLOW_COLLECTION_ID}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify({
      fieldData,
    }),
  });

  return itemId;
}

async function publishWebflowItems(itemIds) {
  if (!itemIds.length) return;

  await webflowRequest(`/collections/${WEBFLOW_COLLECTION_ID}/items/publish`, {
    method: "POST",
    body: JSON.stringify({
      itemIds,
    }),
  });
}

async function main() {
  const webflowItems = await getAllWebflowItems();

  const itemsWithVideoIds = webflowItems
    .map((item) => ({
      item,
      videoId: getField(item, "youtube-video-id"),
    }))
    .filter((entry) => entry.videoId);

  if (!itemsWithVideoIds.length) {
    console.log("No CMS items with YouTube Video ID found.");
    return;
  }

  const videoIds = itemsWithVideoIds.map((entry) => entry.videoId);

  const youtubeItems = await youtubeRequest(videoIds);

  const statsByVideoId = new Map();

  youtubeItems.forEach((video) => {
    statsByVideoId.set(video.id, video.statistics || {});
  });

  const updatedItemIds = [];

  for (const entry of itemsWithVideoIds) {
    const stats = statsByVideoId.get(entry.videoId);

    if (!stats) {
      console.warn(`No YouTube stats found for video ID: ${entry.videoId}`);
      continue;
    }

    const updatedItemId = await updateWebflowItem(entry.item, stats);

    if (updatedItemId) {
      updatedItemIds.push(updatedItemId);
      console.log(`Updated ${entry.videoId}:`, stats);
    }
  }

  await publishWebflowItems(updatedItemIds);

  console.log(`Done. Updated and published ${updatedItemIds.length} items.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
