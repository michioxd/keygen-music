/**
 * @property {string} path - The file path to the music track.
 * @property {string} title - The title of the music track. Should be the name of keygen software.
 * @property {string} trackTitle - The title of the track. Fetched from the music file's metadata. If not available, it should be the same as the title property.
 * @property {string} [artist] - The artist of the track. From file name or folder name. Optional, as it may not always be available.
 * @property {string} tracker - The music tracker used to create the track.
 * @property {number} size - The file size of the music track in bytes.
 * @property {string} fileExtension - The file extension of the music track (e.g., "mod", "xm", "s3m").
 */
export default interface KeygenMusicIndex {
  path: string;
  title: string;
  trackTitle: string;
  artist?: string;
  tracker: string;
  size: number;
  fileExtension: string;
}
