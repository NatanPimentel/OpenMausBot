import { describe, expect, it } from "vitest";

import { FakeChrome } from "../testing/fake-chrome.ts";
import { CdpBrowser } from "./browser.ts";
import { devToolsWebSocket } from "./transport.ts";

const ACTIVATING = ["Page.bringToFront", "Target.activateTarget", "Browser.setWindowBounds"];

async function connect(background: boolean) {
  const chrome = new FakeChrome();
  const browser = await CdpBrowser.connect(chrome, { identity: null, headless: false, permissions: false, downloadDir: null, viewport: null, ownTabsOnly: true, background });
  return { chrome, browser };
}

describe("a browser that works in the background", () => {
  it("opens tabs behind the window and never brings one forward", async () => {
    const { chrome, browser } = await connect(true);
    const first = await browser.newPage();
    const second = await browser.newPage();
    await first.bringToFront();
    await second.bringToFront();
    await first.reload({ readiness: "none" }).catch(() => undefined);
    const created = chrome.sent.filter((sent) => sent.method === "Target.createTarget");
    expect(created).toHaveLength(2);
    for (const sent of created) {
      expect(sent.params).toMatchObject({ background: true });
      expect(sent.params).not.toHaveProperty("newWindow");
    }
    expect(chrome.sent.filter((sent) => ACTIVATING.includes(sent.method))).toEqual([]);
    expect(chrome.sent.some((sent) => sent.method === "Emulation.setFocusEmulationEnabled")).toBe(true);
  });

  it("brings a tab forward only when it is not asked to stay behind", async () => {
    const { chrome, browser } = await connect(false);
    const first = await browser.newPage();
    await browser.newPage();
    await first.bringToFront();
    expect(chrome.sent.find((sent) => sent.method === "Target.createTarget")?.params).not.toHaveProperty("background");
    expect(chrome.sent.some((sent) => sent.method === "Page.bringToFront")).toBe(true);
  });
});

describe("devToolsWebSocket", () => {
  const answering = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it("takes a WebSocket address as it is", async () => {
    await expect(devToolsWebSocket("ws://127.0.0.1:9222/devtools/browser/x")).resolves.toBe("ws://127.0.0.1:9222/devtools/browser/x");
  });

  it("asks the port for its browser WebSocket", async () => {
    const asked: string[] = [];
    const fetchJson = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })); }) as unknown as typeof fetch;
    await expect(devToolsWebSocket("9222", { fetchJson })).resolves.toBe("ws://127.0.0.1:9222/devtools/browser/abc");
    expect(asked).toEqual(["http://127.0.0.1:9222/json/version"]);
  });

  it("refuses an address that is no Chrome", async () => {
    await expect(devToolsWebSocket("http://127.0.0.1:9222", { fetchJson: answering({}) })).rejects.toThrow(/No Chrome/);
  });
});
