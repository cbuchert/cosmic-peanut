// @ts-check
import { expect, it } from "vitest";
import * as template from "../../../template/src/flash.js";
import * as builtin from "./flash.js";

// Repos can't import from each other, so the template carries its own copy of the limiter.
it("the template's flash limiter is the same code as the tested built-in one", () => {
  expect(Object.keys(template)).toEqual(Object.keys(builtin));
  expect(String(template.createFlashLimiter)).toBe(String(builtin.createFlashLimiter));
});
