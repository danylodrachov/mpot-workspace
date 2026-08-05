import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves a run directory from casino ID, geo, and run_id.
 * Rejects traversal outside the intended directory.
 */
export function resolvePath(
  baseDir: string,
  casinoId: string,
  geo: string,
  runId: string
): string {
  // Validate inputs to prevent directory traversal
  if (!casinoId || casinoId.includes("..") || casinoId.includes("/") || casinoId.includes("\\")) {
    throw new Error(`Invalid casinoId: ${casinoId}`);
  }
  if (!geo || geo.includes("..") || geo.includes("/") || geo.includes("\\")) {
    throw new Error(`Invalid geo: ${geo}`);
  }
  if (!runId || runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new Error(`Invalid runId: ${runId}`);
  }

  // Resolve the full path
  const resolvedPath = path.resolve(baseDir, casinoId, geo, runId);

  // Ensure the resolved path is within baseDir
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${resolvedPath} is outside ${resolvedBase}`);
  }

  return resolvedPath;
}

/**
 * Get the directory name for a run
 */
export function getRunDir(baseDir: string, casinoId: string, geo: string, runId: string): string {
  return resolvePath(baseDir, casinoId, geo, runId);
}
