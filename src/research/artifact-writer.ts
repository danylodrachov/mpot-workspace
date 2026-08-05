import fs from "node:fs";
import path from "node:path";

interface WriteOptions {
  immutable?: boolean;
}

/**
 * Writes JSON atomically using same-directory temp file and rename.
 * Prevents partial writes and can enforce immutability.
 */
export async function writeAtomicJSON(
  filePath: string,
  data: unknown,
  options?: WriteOptions
): Promise<void> {
  // Check if file already exists and is immutable
  if (options?.immutable && fs.existsSync(filePath)) {
    throw new Error(`Cannot overwrite immutable file: ${filePath}`);
  }

  // Create directory if needed
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temporary file in same directory
  const tempFile = `${filePath}.tmp`;

  try {
    // Write to temp file
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempFile, content, "utf-8");

    // Atomic rename
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Appends a single object as a line to a JSONL file.
 * Maintains valid JSONL format: one JSON object per line.
 */
export async function writeAppendOnlyJSONL(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Append as new line
  const line = JSON.stringify(data);
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";

  let newContent: string;
  if (content) {
    newContent = content + "\n" + line;
  } else {
    newContent = line;
  }

  // Write atomically
  const tempFile = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempFile, newContent, "utf-8");
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore
      }
    }
    throw error;
  }
}
