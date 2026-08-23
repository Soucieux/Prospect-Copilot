import { describe, expect, it } from "vitest";
import { runGraphWorkerPool } from "@/lib/graph-worker-pool";

describe("runGraphWorkerPool", () => {
  it("limits active graph workers and restores input order", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await runGraphWorkerPool(
      [1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return value * 10;
      },
    );

    expect(maximumActive).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("stops worker dispatch after cancellation", async () => {
    const controller = new AbortController();
    let started = 0;
    await expect(
      runGraphWorkerPool(
        [1, 2, 3, 4],
        1,
        async (value) => {
          started += 1;
          if (value === 1) controller.abort();
          return value;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(1);
  });
});
