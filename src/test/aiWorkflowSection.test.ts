import { describe, it, expect } from "vitest";
import { linesToArray, arrayToLines } from "../components/AiWorkflowSection";

describe("linesToArray", () => {
  it("逐行 trim、移除空行、保留順序", () => {
    expect(linesToArray("  a  \n\n b\nc \n  ")).toEqual(["a", "b", "c"]);
  });

  it("空字串回傳空陣列", () => {
    expect(linesToArray("")).toEqual([]);
    expect(linesToArray("   \n  \n")).toEqual([]);
  });
});

describe("arrayToLines", () => {
  it("以換行串接", () => {
    expect(arrayToLines(["a", "b"])).toBe("a\nb");
  });

  it("undefined 回傳空字串", () => {
    expect(arrayToLines()).toBe("");
    expect(arrayToLines([])).toBe("");
  });

  it("與 linesToArray 互為往返", () => {
    const items = ["src/App.tsx", "src/App.css"];
    expect(linesToArray(arrayToLines(items))).toEqual(items);
  });
});
