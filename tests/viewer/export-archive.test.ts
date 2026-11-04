import { Decoder, Profile, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import JSZip from "jszip";
import {
  buildWorkoutArchive,
  MAX_ARCHIVE_FILENAME_BYTES,
  type WorkoutContentGenerator,
} from "../../src/viewer/lib/export/archive.js";
import { generateMrc } from "../../src/viewer/lib/export/erg.js";
import type { TrainingPlan, Workout } from "../../src/schema/training-plan.js";
import type { Settings } from "../../src/viewer/stores/settings.js";

const settings = {} as Settings;

function workout(id: string, name: string, sport: Workout["sport"] = "run"): Workout {
  return {
    id,
    sport,
    type: sport === "rest" ? "rest" : "endurance",
    name,
    description: id,
    durationMinutes: 30,
    completed: false,
  };
}

function plan(days: Array<{ date: string; workouts: Workout[] }>): TrainingPlan {
  return {
    meta: { id: "archive-test", event: "Test Event" },
    weeks: [
      {
        days: days.map((day) => ({
          ...day,
          dayOfWeek: "Monday",
        })),
      },
    ],
  } as unknown as TrainingPlan;
}

const identifiableGenerator: WorkoutContentGenerator = async (w) => "content:" + w.id;

async function readArchive(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const files: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async("string");
  }
  return files;
}

async function readOnlyArchiveEntry(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  expect(files).toHaveLength(1);
  return files[0];
}

describe("bulk workout archive", () => {
  it("preserves repeated workout names on different dates and on the same date", async () => {
    const source = plan([
      { date: "2025-01-06", workouts: [workout("a", "Easy Run")] },
      { date: "2025-01-08", workouts: [workout("b", "Easy Run"), workout("c", "Easy Run")] },
    ]);
    const result = await buildWorkoutArchive(source, "zwo", settings, identifiableGenerator);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.exported).toBe(3);
    expect(result.content).not.toBeNull();

    const contents = await readArchive(result.content!);
    expect(contents).toEqual({
      "2025-01-06_Easy_Run.zwo": "content:a",
      "2025-01-08_Easy_Run.zwo": "content:b",
      "2025-01-08_Easy_Run_2.zwo": "content:c",
    });
    expect(Object.keys(contents)).toHaveLength(result.exported);
    expect(result.entries.map((entry) => entry.workoutId)).toEqual(["a", "b", "c"]);
  });

  it("preserves names that previously collapsed during ZIP UTF-8 encoding", async () => {
    const prefix = "A".repeat(99);
    const source = plan([
      {
        date: "2025-01-06",
        workouts: [
          workout("face", prefix + "😀"),
          workout("brain", prefix + "🧠"),
        ],
      },
    ]);

    const result = await buildWorkoutArchive(source, "zwo", settings, identifiableGenerator);
    const contents = await readArchive(result.content!);

    expect(result.exported).toBe(2);
    expect(Object.keys(contents)).toHaveLength(2);
    expect(Object.values(contents).sort()).toEqual(["content:brain", "content:face"]);
    expect(Object.keys(contents).some((name) => name.includes("�"))).toBe(false);
  });

  it("keeps extracted names unique, control-safe, and within 255 UTF-8 bytes", async () => {
    const longName = "界".repeat(100) + "\u0000\u0007";
    const source = plan([
      {
        date: "2025-01-06",
        workouts: Array.from({ length: 12 }, (_, index) =>
          workout(`long-${index}`, longName, "bike")
        ),
      },
    ]);

    const result = await buildWorkoutArchive(source, "mrc", settings, identifiableGenerator);
    const contents = await readArchive(result.content!);
    const names = Object.keys(contents);

    expect(names).toHaveLength(12);
    expect(new Set(names.map((name) => name.normalize("NFC").toLowerCase())).size).toBe(12);
    for (const name of names) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(
        MAX_ARCHIVE_FILENAME_BYTES
      );
      expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it("disambiguates case, sanitization, and truncation collisions", async () => {
    const long = "A".repeat(110);
    const source = plan([
      {
        date: "2025-01-06",
        workouts: [
          workout("a", "Easy/Run"),
          workout("b", "EasyRun"),
          workout("c", "easyrun"),
          workout("d", long + "1"),
          workout("e", long + "2"),
          workout("f", "<>:/"),
          workout("g", "???"),
        ],
      },
    ]);
    const result = await buildWorkoutArchive(source, "mrc", settings, identifiableGenerator);
    expect(result.exported).toBe(0);
    expect(result.skipped).toBe(7);

    const bikeSource = plan([
      {
        date: "2025-01-06",
        workouts: source.weeks[0].days[0].workouts.map((item) => ({
          ...item,
          sport: "bike" as const,
        })),
      },
    ]);
    const bikeResult = await buildWorkoutArchive(
      bikeSource,
      "mrc",
      settings,
      identifiableGenerator
    );
    const contents = await readArchive(bikeResult.content!);
    expect(bikeResult.exported).toBe(7);
    expect(Object.keys(contents)).toHaveLength(7);
    const collisionKeys = Object.keys(contents).map((name) =>
      name.normalize("NFC").toLowerCase()
    );
    expect(new Set(collisionKeys).size).toBe(7);
    expect(Object.values(contents).sort()).toEqual(
      ["a", "b", "c", "d", "e", "f", "g"].map((id) => "content:" + id)
    );
    expect(Object.keys(contents).filter((name) => name.includes("Workout"))).toHaveLength(2);
  });

  it("reports unsupported workouts as skipped and generator failures as errors", async () => {
    const source = plan([
      {
        date: "2025-01-06",
        workouts: [
          workout("rest", "Rest Day", "rest"),
          workout("strength", "Strength", "strength"),
          workout("broken", "Broken Run"),
          workout("ok", "Easy Run"),
        ],
      },
    ]);
    const generator: WorkoutContentGenerator = async (item) => {
      if (item.id === "broken") throw new Error("encoder failed");
      return "content:" + item.id;
    };

    const result = await buildWorkoutArchive(source, "zwo", settings, generator);
    expect(result.exported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken");
    expect(result.errors[0]).toContain("encoder failed");
    const contents = await readArchive(result.content!);
    expect(contents).toEqual({ "2025-01-06_Easy_Run.zwo": "content:ok" });
  });

  it("produces no ZIP when every workout is unsupported", async () => {
    const result = await buildWorkoutArchive(
      plan([{ date: "2025-01-06", workouts: [workout("rest", "Rest", "rest")] }]),
      "fit",
      settings
    );
    expect(result).toMatchObject({
      content: null,
      exported: 0,
      skipped: 1,
      errors: [],
      entries: [],
    });
  });

  it("archives the real MRC encoder output unchanged", async () => {
    const bike = { ...workout("bike", "Tempo Ride", "bike"), type: "tempo" as const };
    const result = await buildWorkoutArchive(
      plan([{ date: "2025-01-06", workouts: [bike] }]),
      "mrc",
      settings
    );
    const entry = await readOnlyArchiveEntry(result.content!);

    expect(entry.name).toBe("2025-01-06_Tempo_Ride.mrc");
    expect(await entry.async("string")).toBe(generateMrc(bike, settings));
  });

  it("archives a valid, decodable FIT workout with the expected messages", async () => {
    const bike = workout("bike", "Tempo Ride", "bike");
    const result = await buildWorkoutArchive(
      plan([{ date: "2025-01-06", workouts: [bike] }]),
      "fit",
      settings
    );
    const entry = await readOnlyArchiveEntry(result.content!);
    const bytes = await entry.async("uint8array");

    expect(entry.name).toBe("2025-01-06_Tempo_Ride.fit");
    expect(Decoder.isFIT(Stream.fromByteArray(Array.from(bytes)))).toBe(true);
    expect(new Decoder(Stream.fromByteArray(Array.from(bytes))).checkIntegrity()).toBe(true);

    const decoded: Array<{ messageNumber: number; message: Record<string, unknown> }> = [];
    const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
    const { errors } = decoder.read({
      mesgListener: (messageNumber, message) => decoded.push({ messageNumber, message }),
    });
    const workoutMessage = decoded.find(
      ({ messageNumber }) => messageNumber === Profile.MesgNum.WORKOUT
    )?.message;
    const workoutSteps = decoded.filter(
      ({ messageNumber }) => messageNumber === Profile.MesgNum.WORKOUT_STEP
    );

    expect(errors).toEqual([]);
    expect(workoutMessage).toMatchObject({ sport: "cycling", numValidSteps: 3 });
    expect(workoutSteps).toHaveLength(3);
  });

  it("keeps every eligible workout in the bundled beginner 5K plan", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL("../../docs/demos/5k-beginner-plan.json", import.meta.url),
        "utf-8"
      )
    ) as TrainingPlan;
    const eligibleIds = source.weeks.flatMap((week) =>
      week.days.flatMap((day) =>
        day.workouts
          .filter((item) => item.sport === "bike" || item.sport === "run")
          .map((item) => item.id)
      )
    );
    const result = await buildWorkoutArchive(source, "zwo", settings);
    expect(result.errors).toEqual([]);
    expect(result.exported).toBe(eligibleIds.length);
    expect(result.entries.map((entry) => entry.workoutId)).toEqual(eligibleIds);

    const zip = await JSZip.loadAsync(result.content!);
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    expect(files).toHaveLength(eligibleIds.length);
    expect(files.map((file) => file.name)).toEqual(
      result.entries.map((entry) => entry.filename)
    );
    for (const file of files) {
      const xml = await file.async("string");
      expect(xml).toContain("<workout_file>");
      expect(xml).toContain("</workout_file>");
    }
  });
});
