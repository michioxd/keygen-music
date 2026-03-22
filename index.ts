import { readdir, open, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type KeygenMusicIndex from "./types";

const CURRENT = Date.now();

type MetadataResult = {
  title?: string;
  artist?: string;
  tracker?: string;
};

type OptionalParseFile = (
  path: string,
  options?: Record<string, unknown>,
) => Promise<{
  common?: {
    title?: string;
    artist?: string;
    artists?: string[];
  };
  format?: {
    container?: string;
    codec?: string;
    tool?: string;
  };
}>;

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = resolve(ROOT_DIR, process.argv[2] ?? "music");
const OUTPUT_PRETTY = resolve(ROOT_DIR, "index.json");
const OUTPUT_MIN = resolve(ROOT_DIR, "index.min.json");
const OUTPUT_HTML = resolve(ROOT_DIR, "index.html");

const AUDIO_EXTENSIONS = new Set([
  ".669",
  ".ahx",
  ".amf",
  ".bp",
  ".d00",
  ".fc13",
  ".fc14",
  ".flac",
  ".hsc",
  ".it",
  ".midi",
  ".mid",
  ".mod",
  ".mo3",
  ".mp3",
  ".mtm",
  ".nsf",
  ".ogg",
  ".okt",
  ".rad",
  ".s3m",
  ".sc68",
  ".sid",
  ".spc",
  ".stm",
  ".ult",
  ".v2m",
  ".wav",
  ".xm",
  ".ym",
]);

const TRACKER_TITLE_READERS: Record<
  string,
  (filePath: string) => Promise<string | undefined>
> = {
  ".it": async (filePath) =>
    readFixedTitle(
      filePath,
      4,
      26,
      (buffer) => buffer.subarray(0, 4).toString("latin1") === "IMPM",
    ),
  ".mod": async (filePath) => readFixedTitle(filePath, 0, 20),
  ".s3m": async (filePath) =>
    readFixedTitle(
      filePath,
      0,
      28,
      (buffer) => buffer.subarray(44, 48).toString("latin1") === "SCRM",
    ),
  ".xm": async (filePath) =>
    readFixedTitle(
      filePath,
      17,
      20,
      (buffer) =>
        buffer.subarray(0, 17).toString("latin1") === "Extended Module: ",
    ),
};

const LIBRARY_METADATA_EXTENSIONS = new Set([
  ".flac",
  ".it",
  ".midi",
  ".mid",
  ".mod",
  ".mp3",
  ".ogg",
  ".s3m",
  ".wav",
  ".xm",
]);

const TITLE_CLEANUP_PATTERNS = [
  /\s+\+\d+\s+(?:trn|trainer)$/i,
  /(?:[\s._-]+(?:crk|kg\d*|intro|installer|trn|trainer|nfo|autorun|launcher|patch(?:er)?|loader|selector|changer|fix|unlocke?r|unblacklister))(?:[\s._-]*\d+)?$/i,
];

const TRACKER_FALLBACKS: Record<string, string> = {
  ".669": "Composer 669",
  ".ahx": "AHX",
  ".amf": "Advanced Module Format",
  ".bp": "SoundMon",
  ".d00": "EdLib Tracker",
  ".fc13": "Future Composer 1.3",
  ".fc14": "Future Composer 1.4",
  ".flac": "FLAC",
  ".hsc": "HSC AdLib Composer",
  ".it": "Impulse Tracker",
  ".midi": "MIDI",
  ".mid": "MIDI",
  ".mod": "ProTracker",
  ".mo3": "MO3",
  ".mp3": "MP3",
  ".mtm": "MultiTracker",
  ".nsf": "Nintendo Sound Format",
  ".ogg": "Ogg Vorbis",
  ".okt": "Oktalyzer",
  ".rad": "Reality Adlib Tracker",
  ".s3m": "Scream Tracker 3",
  ".sc68": "SC68",
  ".sid": "SID",
  ".spc": "SPC",
  ".stm": "Scream Tracker",
  ".ult": "Ultra Tracker",
  ".v2m": "Farbrausch V2",
  ".wav": "WAV",
  ".xm": "FastTracker 2",
  ".ym": "Atari YM",
};

let parseFileWithLibrary: OptionalParseFile | undefined;

async function main() {
  await ensureDirectoryExists(MUSIC_DIR);

  parseFileWithLibrary = await loadOptionalParser();
  const allFiles = await collectFiles(MUSIC_DIR);
  const musicFiles = allFiles.filter((filePath) =>
    AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase()),
  );
  const sortedFiles = musicFiles.toSorted((left, right) =>
    left.localeCompare(right),
  );
  const tracks = await mapWithConcurrency(sortedFiles, 24, createTrackIndex);
  const sortedTracks = tracks.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );

  await writeFile(
    OUTPUT_PRETTY,
    `${JSON.stringify(sortedTracks, null, 2)}\n`,
    "utf8",
  );
  await writeFile(OUTPUT_MIN, `${JSON.stringify(sortedTracks)}\n`, "utf8");
  await writeFile(OUTPUT_HTML, generateHtmlIndex(sortedTracks), "utf8");

  console.log(`Took ${(Date.now() - CURRENT) / 1000}s to index music files.`);
  console.log(`Indexed ${sortedTracks.length} tracks.`);
  console.log(`Pretty output: ${relative(ROOT_DIR, OUTPUT_PRETTY)}`);
  console.log(`Minified output: ${relative(ROOT_DIR, OUTPUT_MIN)}`);
  console.log(`HTML output: ${relative(ROOT_DIR, OUTPUT_HTML)}`);
}

async function loadOptionalParser() {
  try {
    const module = (await import("music-metadata")) as {
      parseFile?: OptionalParseFile;
    };
    return module.parseFile;
  } catch {
    console.warn(
      "No optional parser available. Please install the 'music-metadata' package.",
    );
    return undefined;
  }
}

async function ensureDirectoryExists(path: string) {
  const info = await stat(path);

  if (!info.isDirectory()) {
    throw new Error(`Expected a directory: ${path}`);
  }
}

async function collectFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function createTrackIndex(filePath: string): Promise<KeygenMusicIndex> {
  const relativePath = normalizePath(relative(ROOT_DIR, filePath));
  const fileStats = await stat(filePath);
  const extension = extname(filePath).toLowerCase();
  const folderName = basename(dirname(filePath));
  const fileName = basename(filePath, extension);
  const parsedName = parseFileName(fileName, folderName);
  const metadata = await extractMetadata(filePath);
  const title = cleanupTitle(parsedName.title);
  const trackTitle = cleanupTitle(metadata.title ?? title) || title;
  const artist = cleanupArtist(metadata.artist ?? parsedName.artist);
  const tracker = metadata.tracker ?? TRACKER_FALLBACKS[extension] ?? "Unknown";

  return {
    path: relativePath,
    title,
    trackTitle,
    ...(artist ? { artist } : {}),
    tracker,
    size: fileStats.size,
    fileExtension: extension.slice(1),
  };
}

function parseFileName(fileName: string, folderName: string) {
  const prefixed = /^(?<artist>.+?)\s*-\s*(?<title>.+)$/u.exec(fileName);
  const parsedArtist = cleanupArtist(prefixed?.groups?.artist);
  const parsedTitle = cleanupTitle(prefixed?.groups?.title ?? fileName);
  const fallbackArtist =
    folderName !== "!Others" ? cleanupArtist(folderName) : undefined;

  return {
    artist: parsedArtist ?? fallbackArtist,
    title: parsedTitle,
  };
}

async function extractMetadata(filePath: string): Promise<MetadataResult> {
  const extension = extname(filePath).toLowerCase();
  const trackerTitle = await TRACKER_TITLE_READERS[extension]?.(filePath);
  const result: MetadataResult = {
    title: cleanupTitle(trackerTitle),
    tracker: TRACKER_FALLBACKS[extension],
  };

  if (!parseFileWithLibrary || !LIBRARY_METADATA_EXTENSIONS.has(extension)) {
    return result;
  }

  try {
    const metadata = await parseFileWithLibrary(filePath, {
      duration: false,
      skipCovers: true,
    });
    const artist = metadata.common?.artist ?? metadata.common?.artists?.[0];
    const tracker = normalizeTrackerName(
      metadata.format?.tool ??
        metadata.format?.container ??
        metadata.format?.codec,
      extension,
    );

    return {
      title: cleanupTitle(metadata.common?.title ?? result.title),
      artist: cleanupArtist(artist),
      tracker,
    };
  } catch {
    return result;
  }
}

async function readFixedTitle(
  filePath: string,
  offset: number,
  length: number,
  validator?: (buffer: Buffer) => boolean,
) {
  const buffer = await readHeader(filePath, Math.max(offset + length, 64));

  if (validator && !validator(buffer)) {
    return undefined;
  }

  const raw = buffer.subarray(offset, offset + length).toString("latin1");
  return cleanupTitle(raw.replace(/\0/g, " "));
}

async function readHeader(filePath: string, length: number) {
  const fileHandle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function cleanupTitle(value: string | undefined) {
  if (!value) {
    return "Unknown";
  }

  let title = value
    .replace(/\.[^.]+$/u, "")
    .replace(/[_]+/g, " ")
    .trim();

  for (const pattern of TITLE_CLEANUP_PATTERNS) {
    title = title.replace(pattern, "").trim();
  }

  title = title
    .replace(/\s{2,}/g, " ")
    .replace(/[\s.-]+$/u, "")
    .trim();
  return title || "Unknown";
}

function cleanupArtist(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const artist = value
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return artist || undefined;
}

function normalizeTrackerName(value: string | undefined, extension: string) {
  if (!value) {
    return TRACKER_FALLBACKS[extension];
  }

  const tracker = value
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return tracker || TRACKER_FALLBACKS[extension];
}

function normalizePath(path: string) {
  return path.split(sep).join("/");
}

function generateHtmlIndex(tracks: KeygenMusicIndex[]) {
  const rows = tracks
    .map(
      (track) => `    <tr>
      <td><a href="${escapeHtml(track.path)}">${escapeHtml(track.title)}</a></td>
      <td>${escapeHtml(track.trackTitle)}</td>
      <td>${escapeHtml(track.artist ?? "-")}</td>
      <td>${escapeHtml(track.tracker)}</td>
      <td>${escapeHtml(track.fileExtension)}</td>
      <td>${track.size}</td>
    </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>keygen-music index</title>
  </head>
  <body style="font-family: system-ui, sans-serif; line-height: 1.5;">
    <h1><a href="https://github.com/michioxd/keygen-music">keygen-music index</a></h1>
    <p>Total tracks: ${tracks.length}</p>
    <table border="1" cellspacing="0" cellpadding="4">
      <thead>
        <tr>
          <th>Title</th>
          <th>Track title</th>
          <th>Artist</th>
          <th>Tracker</th>
          <th>Ext</th>
          <th>Size</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </body>
</html>
`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
) {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

await main();
