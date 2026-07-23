import { expect } from "bun:test";

export const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual: unknown, expected: unknown, message?: string) {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    expect(actual, message).toEqual(expected);
  },
  match(actual: string, expected: string | RegExp, message?: string) {
    expect(actual, message).toMatch(expected);
  },
  doesNotMatch(actual: string, expected: string | RegExp, message?: string) {
    expect(actual, message).not.toMatch(expected);
  },
  ok(actual: unknown, message?: string) {
    expect(actual, message).toBeTruthy();
  },
  throws(callback: () => unknown, expected?: unknown, message?: string) {
    expect(callback, message).toThrow(expected);
  }
};
