import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  buildWorkoutArchive,
  MAX_ARCHIVE_FILENAME_BYTES,
  type WorkoutContentGenerator,
} from "../../src/viewer/lib/export/archive.js";
import type { TrainingPlan, Workout } from "../../src/schema/training-plan.js";
import type { Settings } from "../../src/viewer/stores/settings.js";

const settings = {} as Settings;
const generator: WorkoutContentGenerator = async (workout) => `content:${workout.id}`;

function workout(id: string, name: string): Workout {
  return {
    id,
    sport: "bike",
    type: "endurance",
    name,
    description: id,
    durationMinutes: 30,
    completed: false,
  };
}

function plan(workouts: Workout[]): TrainingPlan {
  return {
    meta: { id: "filesystem-test", event: "Filesystem Test" },
    weeks: [
      {
        days: [
          {
            date: "2025-01-06",
            dayOfWeek: "Monday",
            workouts,
          },
        ],
      },
    ],
  } as unknown as TrainingPlan;
}

describe("bulk workout archive filesystem compatibility", () => {
  it("writes every serialized entry to a real extraction directory", async () => {
    const emojiPrefix = "A".repeat(99);
    const longName = "界".repeat(100) + "\u0000\u0007";
    const source = plan([
      workout("face", emojiPrefix + "😀"),
      workout("brain", emojiPrefix + "🧠"),
      ...Array.from({ length: 12 }, (_, index) => workout(`long-${index}`, longName)),
    ]);
    const result = await buildWorkoutArchive(source, "mrc", settings, generator);
    const zip = await JSZip.loadAsync(result.content!);
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    const extractionDirectory = mkdtempSync(join(tmpdir(), "claude-coach-archive-"));

    try {
      expect(files).toHaveLength(source.weeks[0].days[0].workouts.length);
      for (const entry of files) {
        const bytes = await entry.async("uint8array");
        const target = join(extractionDirectory, entry.name);

        expect(new TextEncoder().encode(entry.name).length).toBeLessThanOrEqual(
          MAX_ARCHIVE_FILENAME_BYTES
        );
        expect(entry.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        writeFileSync(target, bytes);
        expect(readFileSync(target)).toEqual(Buffer.from(bytes));
      }
    } finally {
      rmSync(extractionDirectory, { recursive: true, force: true });
    }
  });
});
