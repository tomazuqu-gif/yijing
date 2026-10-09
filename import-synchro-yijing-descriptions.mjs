#!/usr/bin/env node

/**
 * Export publicly accessible video descriptions from YouTube using the official
 * YouTube Data API v3.
 *
 * Requirements: Node.js 18+ and a YouTube Data API v3 key.
 * Usage: YOUTUBE_API_KEY="your-key" node import-synchro-yijing-descriptions.mjs
 *
 * Optional environment variables:
 *   YOUTUBE_CHANNEL_HANDLE="@synchro-yijing"
 *   OUTPUT_FILE="src/data/synchro-yijing-descriptions.json"
 *
 * Keep the API key local/server-side. Do not commit it or expose it to frontend code.
 * Confirm permission/licensing before republishing full descriptions publicly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE ?? "@synchro-yijing";
const OUTPUT_FILE = process.env.OUTPUT_FILE ?? "src/data/synchro-yijing-descriptions.json";

if (!API_KEY) {
  console.error(
    "Missing YOUTUBE_API_KEY. Enable YouTube Data API v3 in Google Cloud, " +
      "create an API key, then set it as an environment variable."
  );
  process.exit(1);
}

async function youtubeGet(resource, params = {}) {
  const url = new URL(`${API_BASE}/${resource}`);
  url.searchParams.set("key", API_KEY);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not reach YouTube Data API (${resource}). Check your internet connection, ` +
        `DNS/firewall settings, then try again. Details: ${detail}`
    );
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = body?.error?.message ?? response.statusText;
    throw new Error(
      `YouTube API ${resource} failed (${response.status}): ${apiMessage}`
    );
  }
  return body;
}

async function getChannel() {
  const response = await youtubeGet("channels", {
    part: "snippet,contentDetails",
    forHandle: CHANNEL_HANDLE,
  });
  const channel = response.items?.[0];

  if (!channel) {
    throw new Error(
      `No public channel found for handle ${CHANNEL_HANDLE}. ` +
        "Check the handle, API key, and YouTube Data API access."
    );
  }

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new Error("The channel response did not include its uploads playlist.");
  }
  return { channel, uploadsPlaylistId };
}

async function getAllUploadItems(playlistId) {
  const items = [];
  let pageToken;

  do {
    const response = await youtubeGet("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of response.items ?? []) {
      const videoId =
        item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
      if (videoId) {
        items.push({
          videoId,
          playlistPosition: item.snippet?.position ?? items.length,
          playlistTitle: item.snippet?.title ?? "",
          playlistDescription: item.snippet?.description ?? "",
          playlistPublishedAt: item.contentDetails?.videoPublishedAt ?? null,
        });
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  const seen = new Set();
  return items.filter(({ videoId }) => {
    if (seen.has(videoId)) return false;
    seen.add(videoId);
    return true;
  });
}

async function getVideoDetailsInBatches(videoIds) {
  const byId = new Map();
  for (let start = 0; start < videoIds.length; start += 50) {
    const batch = videoIds.slice(start, start + 50);
    // videos.list supports an id filter with up to 50 comma-separated IDs.
    // Do not pass maxResults when using the id parameter.
    const response = await youtubeGet("videos", {
      part: "snippet,status",
      id: batch.join(","),
    });
    for (const video of response.items ?? []) byId.set(video.id, video);
  }
  return byId;
}

async function main() {
  console.log(`Resolving YouTube channel ${CHANNEL_HANDLE}...`);
  const { channel, uploadsPlaylistId } = await getChannel();

  console.log(`Reading upload list for ${channel.snippet?.title ?? channel.id}...`);
  const uploadItems = await getAllUploadItems(uploadsPlaylistId);
  console.log(`Found ${uploadItems.length} video IDs in the uploads playlist.`);

  const videosById = await getVideoDetailsInBatches(uploadItems.map((item) => item.videoId));
  const videos = [];
  const unavailableVideos = [];

  for (const item of uploadItems) {
    const video = videosById.get(item.videoId);
    if (!video) {
      unavailableVideos.push({
        videoId: item.videoId,
        title: item.playlistTitle,
        playlistItemDescription: item.playlistDescription || null,
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
        note: "Video details were not available from videos.list; fallback description may be stale.",
      });
      continue;
    }

    const snippet = video.snippet ?? {};
    videos.push({
      videoId: video.id,
      title: snippet.title ?? item.playlistTitle,
      publishedAt: snippet.publishedAt ?? item.playlistPublishedAt,
      description: snippet.description ?? "",
      url: `https://www.youtube.com/watch?v=${video.id}`,
      channelId: snippet.channelId ?? channel.id,
      channelTitle: snippet.channelTitle ?? channel.snippet?.title ?? "",
      defaultLanguage: snippet.defaultLanguage ?? null,
      defaultAudioLanguage: snippet.defaultAudioLanguage ?? null,
      playlistPosition: item.playlistPosition,
      playlistDescriptionFallback: item.playlistDescription || null,
    });
  }

  const output = {
    schemaVersion: 1,
    source: {
      handle: CHANNEL_HANDLE,
      channelId: channel.id,
      channelTitle: channel.snippet?.title ?? "",
      channelUrl: `https://www.youtube.com/channel/${channel.id}`,
      uploadsPlaylistId,
      api: "YouTube Data API v3",
    },
    retrievedAt: new Date().toISOString(),
    videoCount: videos.length,
    unavailableVideos,
    videos,
  };

  const destination = path.resolve(process.cwd(), OUTPUT_FILE);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Exported ${videos.length} video descriptions to ${destination}`);
  if (unavailableVideos.length) {
    console.warn(
      `${unavailableVideos.length} videos were listed in the uploads playlist ` +
        "but their video resources were unavailable. Fallback metadata is recorded in the JSON."
    );
  }
  console.log(
    "Descriptions are preserved as returned by the API. Review licensing/permission " +
      "before redistributing them in a public app."
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
