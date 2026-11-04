/**
 * Training Plan Export
 *
 * Unified export interface for generating workout files client-side.
 * Supports:
 * - ZWO (Zwift workouts) - bike/run only
 * - FIT (Garmin workouts) - all sports
 * - MRC (ERG/MRC) - bike only, for indoor trainers
 * - ICS (iCalendar) - full plan calendar events
 */

import type { Workout, TrainingPlan, TrainingDay, Sport } from "../../../schema/training-plan.js";
import type { Settings } from "../../stores/settings.js";
import { generateZwo, isZwoSupported } from "./zwo.js";
import { generateFit, isFitSupported } from "./fit.js";
import { generateMrc, isErgSupported } from "./erg.js";
import { generateIcs } from "./ics.js";
import { sanitizeFilename } from "./filename.js";
import { buildWorkoutArchive, type WorkoutExportFormat } from "./archive.js";

export type ExportFormat = "zwo" | "fit" | "mrc" | "ics";

export interface ExportResult {
  success: boolean;
  filename: string;
  error?: string;
}

/**
 * Trigger a file download in the browser
 */
export function downloadFile(
  content: string | Uint8Array,
  filename: string,
  mimeType: string
): void {
  const blob =
    content instanceof Uint8Array
      ? new Blob([new Uint8Array(content)], { type: mimeType })
      : new Blob([content], { type: mimeType });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Get available export formats for a workout based on its sport
 */
export function getAvailableFormats(sport: Sport): ExportFormat[] {
  const formats: ExportFormat[] = [];

  if (isZwoSupported(sport)) {
    formats.push("zwo");
  }

  if (isFitSupported(sport)) {
    formats.push("fit");
  }

  if (isErgSupported(sport)) {
    formats.push("mrc");
  }

  return formats;
}

/**
 * Export a single workout to the specified format
 */
export async function exportWorkout(
  workout: Workout,
  format: ExportFormat,
  settings: Settings
): Promise<ExportResult> {
  const safeName = sanitizeFilename(workout.name);

  try {
    switch (format) {
      case "zwo": {
        if (!isZwoSupported(workout.sport)) {
          return {
            success: false,
            filename: "",
            error: `Zwift export only supports bike and run workouts`,
          };
        }
        const zwoContent = generateZwo(workout, settings);
        const filename = `${safeName}.zwo`;
        downloadFile(zwoContent, filename, "application/xml");
        return { success: true, filename };
      }

      case "fit": {
        if (!isFitSupported(workout.sport)) {
          return {
            success: false,
            filename: "",
            error: `FIT export not supported for ${workout.sport} workouts`,
          };
        }
        const fitContent = await generateFit(workout, settings);
        const filename = `${safeName}.fit`;
        downloadFile(fitContent, filename, "application/vnd.ant.fit");
        return { success: true, filename };
      }

      case "mrc": {
        if (!isErgSupported(workout.sport)) {
          return {
            success: false,
            filename: "",
            error: `MRC export only supports bike workouts`,
          };
        }
        const mrcContent = generateMrc(workout, settings);
        const filename = `${safeName}.mrc`;
        downloadFile(mrcContent, filename, "text/plain");
        return { success: true, filename };
      }

      default:
        return {
          success: false,
          filename: "",
          error: `Unknown format: ${format}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      filename: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Export the full training plan to iCalendar format
 */
export function exportPlanToCalendar(plan: TrainingPlan): ExportResult {
  try {
    const icsContent = generateIcs(plan);
    const safeName = sanitizeFilename(plan.meta.event);
    const filename = `${safeName}_training_plan.ics`;
    downloadFile(icsContent, filename, "text/calendar");
    return { success: true, filename };
  } catch (error) {
    return {
      success: false,
      filename: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Export supported workouts as a lossless ZIP. The archive builder distinguishes
 * unsupported workouts from conversion failures and allocates unique filenames.
 */
export async function exportAllWorkouts(
  plan: TrainingPlan,
  format: WorkoutExportFormat,
  settings: Settings
): Promise<{ exported: number; skipped: number; errors: string[] }> {
  try {
    const result = await buildWorkoutArchive(plan, format, settings);
    if (result.content) {
      const planName = sanitizeFilename(plan.meta.event) || "Training_Plan";
      downloadFile(result.content, planName + "_workouts_" + format + ".zip", "application/zip");
    }
    return { exported: result.exported, skipped: result.skipped, errors: result.errors };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exported: 0, skipped: 0, errors: ["Could not create workout ZIP: " + reason] };
  }
}

// Re-export format-specific helpers
export { isZwoSupported } from "./zwo.js";
export { isFitSupported, isFitSdkAvailable } from "./fit.js";
export { isErgSupported } from "./erg.js";
export { sanitizeFilename } from "./filename.js";
