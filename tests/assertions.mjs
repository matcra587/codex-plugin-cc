import { expect } from "bun:test";

export const assert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  notEqual(actual, expected, message) {
    expect(actual, message).not.toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toEqual(expected);
  },
  match(actual, expected, message) {
    expect(actual, message).toMatch(expected);
  },
  doesNotMatch(actual, expected, message) {
    expect(actual, message).not.toMatch(expected);
  },
  ok(actual, message) {
    expect(actual, message).toBeTruthy();
  },
  throws(callback, expected, message) {
    expect(callback, message).toThrow(expected);
  }
};
