import { expect, test } from "vitest";
import { delta24h, isLowest30d, weekDelta } from "../src/signals";

const now = new Date("2026-07-13T20:00:00Z");
const h = 3600_000;
const pt = (hoursAgo: number, priceLow: number) => ({
  pollBucket: new Date(now.getTime() - hoursAgo * h), priceLow,
});

test("weekDelta: needs >=7 days of data", () => {
  expect(weekDelta([pt(24, 100), pt(1, 90)], now)).toBeNull();
});

test("weekDelta: (latest - low_7d_ago) / low_7d_ago", () => {
  const points = [pt(24 * 8, 100), pt(24 * 7, 100), pt(24 * 3, 95), pt(1, 88)];
  expect(weekDelta(points, now)).toBeCloseTo((88 - 100) / 100);
});

test("isLowest30d: null under 14 days of history", () => {
  expect(isLowest30d([pt(24 * 10, 100), pt(1, 80)], now)).toBeNull();
});

test("isLowest30d: true only when latest <= min of window", () => {
  const base = [pt(24 * 20, 100), pt(24 * 10, 85)];
  expect(isLowest30d([...base, pt(1, 80)], now)).toBe(true);
  expect(isLowest30d([...base, pt(1, 90)], now)).toBe(false);
});

test("delta24h: null without 2 buckets >=20h apart in window", () => {
  expect(delta24h([pt(3, 100), pt(1, 90)], now)).toBeNull();
});

test("delta24h: (latest - oldest_in_window) / oldest", () => {
  expect(delta24h([pt(23, 100), pt(1, 88)], now)).toBeCloseTo(-0.12);
});
