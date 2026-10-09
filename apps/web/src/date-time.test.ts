import { expect, it } from 'vitest';
import { formatDate, formatTime } from './date-time';

it.each([
  [2026, 0, 2, '2026-01-02'],
  [2024, 1, 29, '2024-02-29'],
  [2026, 11, 31, '2026-12-31'],
] as const)('formats local dates with zero padding: %s-%s-%s', (year, month, day, expected) => {
  const date = new Date(year, month, day, 0, 5, 9);
  expect(formatDate(date.getTime())).toBe(expected);
  expect(formatDate(date.toISOString())).toBe(expected);
});

it.each([
  [0, 0, 0, '00:00:00'],
  [9, 5, 2, '09:05:02'],
  [23, 59, 59, '23:59:59'],
] as const)('formats 24-hour local time: %s:%s:%s', (hour, minute, second, expected) => {
  expect(formatTime(new Date(2026, 9, 9, hour, minute, second).getTime())).toBe(expected);
});
