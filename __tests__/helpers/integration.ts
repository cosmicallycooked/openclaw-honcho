import { describe } from "vitest";

export const API_KEY = process.env.HONCHO_API_KEY;
export const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? "openclaw-test";
export const BASE_URL = process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev";

export const maybe = !API_KEY ? describe.skip : describe;
export const maybeDream =
  !API_KEY || process.env.HONCHO_SKIP_DREAM_TESTS === "1" ? describe.skip : describe;
