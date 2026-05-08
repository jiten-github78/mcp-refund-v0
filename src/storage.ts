/**
 * Append-only audit log backed by logs.json.
 *
 * Why a flat file: V0 must be deployable in 30 seconds with zero
 * infrastructure. A database is explicitly out of scope.
 *
 * Crash-safety: writes go to logs.json.tmp and are renamed into place.
 * fs.rename is atomic on the same filesystem on Linux/macOS, and
 * effectively atomic on Windows for our use, so a crash mid-write
 * cannot leave a half-written audit log.
 */

import * as fs from "fs/promises";
import * as path from "path";

export const LOGS_PATH = path.resolve(process.cwd(), "logs.json");
export const DEMO_LOGS_PATH = path.resolve(process.cwd(), "demo-logs.json");

export type LogStatus = "success" | "failed" | "duplicate_blocked";

export interface LogEntry {
  timestamp: string;
  request_id: string;
  payment_id: string;
  amount_paise: number;
  razorpay_refund_id: string | null;
  status: LogStatus;
  reasoning_input?: string;
  razorpay_response: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface StorageError {
  type: "storage_error";
  code: string;
  message: string;
  cause?: unknown;
}

/**
 * Returns true if the given value is a Node fs error with the given code.
 */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * Reads logs.json from disk and parses it. If the file is missing, treats
 * the log as empty. If the file is corrupt, throws a StorageError rather
 * than silently truncating the audit trail.
 */
export async function readLogs(logsPath: string = LOGS_PATH): Promise<LogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logsPath, "utf8");
  } catch (err: unknown) {
    if (isErrnoException(err, "ENOENT")) {
      return [];
    }
    const storageErr: StorageError = {
      type: "storage_error",
      code: "read_failed",
      message: `Failed to read ${path.basename(logsPath)}`,
      cause: err,
    };
    throw storageErr;
  }

  if (raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const storageErr: StorageError = {
        type: "storage_error",
        code: "corrupt_log",
        message: `${path.basename(logsPath)} is not a JSON array`,
      };
      throw storageErr;
    }
    return parsed as LogEntry[];
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { type?: unknown }).type === "storage_error"
    ) {
      throw err;
    }
    const storageErr: StorageError = {
      type: "storage_error",
      code: "corrupt_log",
      message: `${path.basename(logsPath)} contains invalid JSON`,
      cause: err,
    };
    throw storageErr;
  }
}

/**
 * Looks up a previous log entry by request_id. Used for idempotency:
 * if a request_id has been seen before, we refuse to re-execute and
 * return the original outcome instead.
 */
export async function findByRequestId(
  requestId: string,
  logsPath: string = LOGS_PATH,
): Promise<LogEntry | null> {
  const logs = await readLogs(logsPath);
  return logs.find((entry) => entry.request_id === requestId) ?? null;
}

/**
 * Appends a single log entry. Reads the existing file, appends in memory,
 * writes the new array to <path>.tmp, and renames it over <path>.
 * The rename is the atomic commit point.
 */
export async function appendLog(
  entry: LogEntry,
  logsPath: string = LOGS_PATH,
): Promise<void> {
  const existing = await readLogs(logsPath);
  const next = [...existing, entry];
  const serialized = JSON.stringify(next, null, 2);
  const tmpPath = `${logsPath}.tmp`;

  try {
    await fs.writeFile(tmpPath, serialized, { encoding: "utf8" });
    await fs.rename(tmpPath, logsPath);
  } catch (err: unknown) {
    const storageErr: StorageError = {
      type: "storage_error",
      code: "write_failed",
      message: `Failed to write ${path.basename(logsPath)} atomically`,
      cause: err,
    };
    throw storageErr;
  }
}
