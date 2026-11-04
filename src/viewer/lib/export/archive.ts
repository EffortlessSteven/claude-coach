/**
 * Lossless bulk workout archive construction.
 *
 * This module does not interact with the DOM. Browser downloads are handled by
 * export/index.ts, allowing callers and tests to inspect the actual archive.
 */
import type { Workout, TrainingPlan } from "../../../schema/training-plan.js";
import type { Settings } from "../../stores/settings.js";
import JSZip from "jszip";
import { sanitizeFilename, truncateUtf8, utf8ByteLength } from "./filename.js";
import { generateZwo, isZwoSupported } from "./zwo.js";
import { generateFit, isFitSupported } from "./fit.js";
import { generateMrc, isErgSupported } from "./erg.js";

export type WorkoutExportFormat = "zwo" | "fit" | "mrc";
type WorkoutContent = string | Uint8Array;

export const MAX_ARCHIVE_FILENAME_BYTES = 255;
const MAX_ARCHIVE_DATE_BYTES = 32;

export type WorkoutContentGenerator = (
  workout: Workout,
  format: WorkoutExportFormat,
  settings: Settings
) => Promise<WorkoutContent>;

export interface ArchiveEntry {
  workoutId: string;
  date: string;
  filename: string;
}

export interface WorkoutArchive {
  content: Uint8Array | null;
  exported: number;
  skipped: number;
  errors: string[];
  entries: ArchiveEntry[];
}

/** Determine whether the selected encoder supports a workout's sport. */
function supportsFormat(workout: Workout, format: WorkoutExportFormat): boolean {
  switch (format) {
    case "zwo":
      return isZwoSupported(workout.sport);
    case "fit":
      return isFitSupported(workout.sport);
    case "mrc":
      return isErgSupported(workout.sport);
  }
}

/** Dispatch one supported workout to its real format encoder. */
async function generateContent(
  workout: Workout,
  format: WorkoutExportFormat,
  settings: Settings
): Promise<WorkoutContent> {
  switch (format) {
    case "zwo":
      return generateZwo(workout, settings);
    case "fit":
      return generateFit(workout, settings);
    case "mrc":
      return generateMrc(workout, settings);
  }
}

/** Produce a normalized, non-empty filename component. */
function archiveStem(value: string, fallback: string): string {
  return (
    sanitizeFilename(value)
      .normalize("NFC")
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, "") || fallback
  );
}

/** Match names as they would collide on a case-insensitive extracted filesystem. */
function collisionKey(filename: string): string {
  return filename.normalize("NFC").toLowerCase();
}

/** Build one byte-bounded filename candidate for a specific collision ordinal. */
function archiveFilenameCandidate(
  dateStem: string,
  workoutStem: string,
  extension: string,
  ordinal: number
): string {
  const suffix = ordinal === 1 ? "" : `_${ordinal}`;
  const fixedBytes = utf8ByteLength(`${dateStem}_${suffix}${extension}`);
  const workoutBudget = MAX_ARCHIVE_FILENAME_BYTES - fixedBytes;
  const boundedWorkoutStem =
    truncateUtf8(workoutStem, workoutBudget) || truncateUtf8("Workout", workoutBudget);

  return `${dateStem}_${boundedWorkoutStem}${suffix}${extension}`;
}

/**
 * Allocate a unique archive entry that remains valid after UTF-8 serialization
 * and within the 255-byte filename-component limit used by common filesystems.
 */
function uniqueArchiveFilename(
  date: string,
  workoutName: string,
  format: WorkoutExportFormat,
  used: Set<string>,
  nextOrdinalByBase: Map<string, number>
): string {
  const dateStem =
    truncateUtf8(archiveStem(date, "undated"), MAX_ARCHIVE_DATE_BYTES) || "undated";
  const requestedWorkoutStem = archiveStem(workoutName, "Workout");
  const extension = `.${format}`;
  const baseKey = collisionKey(
    archiveFilenameCandidate(dateStem, requestedWorkoutStem, extension, 1)
  );
  let ordinal = nextOrdinalByBase.get(baseKey) ?? 1;

  while (true) {
    const filename = archiveFilenameCandidate(
      dateStem,
      requestedWorkoutStem,
      extension,
      ordinal
    );
    const key = collisionKey(filename);

    if (!used.has(key)) {
      used.add(key);
      nextOrdinalByBase.set(baseKey, ordinal + 1);
      return filename;
    }
    ordinal++;
  }
}

/**
 * Build a bulk archive without downloading it.
 *
 * The generator can be supplied by tests to force a conversion failure or
 * distinguish otherwise identical workouts. Production uses the real format
 * encoders. Skips count unsupported combinations; errors count failed
 * generation or ZIP insertion; exported counts only unique archive entries.
 */
export async function buildWorkoutArchive(
  plan: TrainingPlan,
  format: WorkoutExportFormat,
  settings: Settings,
  generator: WorkoutContentGenerator = generateContent
): Promise<WorkoutArchive> {
  const zip = new JSZip();
  const entries: ArchiveEntry[] = [];
  const errors: string[] = [];
  const used = new Set<string>();
  const nextOrdinalByBase = new Map<string, number>();
  let skipped = 0;

  for (const week of plan.weeks ?? []) {
    for (const day of week.days ?? []) {
      for (const workout of day.workouts ?? []) {
        if (workout.sport === "rest" || !supportsFormat(workout, format)) {
          skipped++;
          continue;
        }

        try {
          const content = await generator(workout, format, settings);
          if (typeof content !== "string" && !(content instanceof Uint8Array)) {
            throw new Error("Workout generator returned no file content");
          }

          const filename = uniqueArchiveFilename(
            day.date,
            workout.name,
            format,
            used,
            nextOrdinalByBase
          );
          zip.file(filename, content);
          entries.push({ workoutId: workout.id, date: day.date, filename });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          errors.push(day.date + " " + workout.name + " (" + workout.id + "): " + reason);
        }
      }
    }
  }

  const content = entries.length > 0 ? await zip.generateAsync({ type: "uint8array" }) : null;

  return { content, exported: entries.length, skipped, errors, entries };
}
