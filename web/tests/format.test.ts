import { expect, test } from "vitest";
import { formatDuration } from "../src/format";

test("durations read in minutes, then hours and minutes, then hours to the nearest", () => {
    expect(formatDuration(20)).toBe("under a minute");
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe("3 h 20 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    // Past ten hours, the minutes are left out: 10 h 50 min is nearer 11 h than 10.
    expect(formatDuration(10 * 3600 + 50 * 60)).toBe("11 h");
    expect(formatDuration(12 * 3600 + 10 * 60)).toBe("12 h");
    expect(formatDuration(9 * 3600 + 59 * 60 + 40)).toBe("10 h");
});
