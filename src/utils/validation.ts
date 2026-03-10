/**
 * Shared validation helpers for route handlers.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type-guard: validates that `id` is a non-empty string matching UUID v4 format */
export function isValidUUID(id: string | string[] | undefined): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

/** Parse an integer query parameter with bounds. Returns `defaultVal` on NaN or out-of-range. */
export function safeParseInt(value: string | undefined, defaultVal: number, min = 1, max = 1000): number {
  if (!value) return defaultVal;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) return defaultVal;
  return n;
}

/** Parse a float query parameter. Returns null on NaN. */
export function safeParseFloat(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

/** Validate latitude/longitude ranges. Returns true if valid. */
export function isValidCoordinates(lat: number, lng: number): boolean {
  return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Escape ILIKE special characters (%, _, \) to prevent wildcard injection */
export function escapeILIKE(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/** Safe file deletion — resolves the path and verifies it's inside the upload directory */
export function safeUnlinkUpload(mediaUrl: string): void {
  const path = require('path');
  const fs = require('fs');
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const filePath = path.resolve(uploadDir, mediaUrl.replace(/^\/uploads\//, ''));
  // Prevent path traversal: ensure resolved path stays within uploadDir
  if (!filePath.startsWith(uploadDir + path.sep) && filePath !== uploadDir) {
    console.error('Path traversal attempt blocked:', mediaUrl);
    return;
  }
  fs.unlink(filePath, () => {});
}
