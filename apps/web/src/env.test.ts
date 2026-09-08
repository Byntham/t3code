import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("translucent sidebar availability", () => {
  it.each([
    { name: "server rendering", clientWindow: undefined, expected: false },
    { name: "browser", clientWindow: {}, expected: false },
    { name: "older desktop client", clientWindow: { desktopBridge: {} }, expected: false },
    {
      name: "unsupported system",
      clientWindow: { desktopBridge: { getWindowMaterial: () => null } },
      expected: false,
    },
    {
      name: "Windows Mica",
      clientWindow: { desktopBridge: { getWindowMaterial: () => "mica" } },
      expected: true,
    },
    {
      name: "macOS vibrancy",
      clientWindow: { desktopBridge: { getWindowMaterial: () => "vibrancy" } },
      expected: true,
    },
  ])("handles $name", async ({ clientWindow, expected }) => {
    vi.stubGlobal("window", clientWindow);
    const { supportsTranslucentSidebar } = await import("./env");
    expect(supportsTranslucentSidebar).toBe(expected);
  });
});
