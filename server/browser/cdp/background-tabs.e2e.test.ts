// A bot opens a tab in a running, headed Chrome, reads it and takes its picture while the window in front and the tab in
// front stay as they were. Runs when OMB_BACKGROUND_E2E_DISPLAY names an X display that is not the person's own (":98"
// is the agents' screen) and a Chrome is installed; it starts a Chrome of its own on a throwaway profile there.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { ConnectedBackend, type OpenedBrowser } from "../backends.ts";
import { devToolsWebSocket } from "./transport.ts";

const DISPLAY = process.env.OMB_BACKGROUND_E2E_DISPLAY;
const CHROME = process.env.OMB_CDP_CHROME ?? ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"].find((path) => existsSync(path));
const suite = DISPLAY && CHROME ? describe : describe.skip;

/** What X says has the focus on `display`; read only. */
function focusedWindow(display: string): string {
  for (const verb of ["getactivewindow", "getwindowfocus"]) {
    try {
      return execFileSync("xdotool", [verb], { env: { PATH: process.env.PATH, DISPLAY: display }, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
  }
  return "unknown";
}

async function visibility(port: number, targetId: string): Promise<string> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const answer = new Promise<string>((resolve) => {
    socket.onmessage = (event) => resolve(String(JSON.parse(String(event.data)).result?.result?.value));
  });
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.visibilityState" } }));
  try { return await answer; } finally { socket.close(); }
}

suite("a bot working in a Chrome that is in use", () => {
  let dir = "";
  let chrome: ChildProcess;
  let site: Server;
  let port = 0;
  let sitePort = 0;
  let opened: OpenedBrowser;
  let firstTab = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-background-e2e-"));
    site = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<title>${request.url}</title><h1>olá do bot ${request.url}</h1><button onclick="this.textContent='clicado'">botão</button>`);
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    sitePort = (site.address() as AddressInfo).port;
    const env = { ...process.env };
    delete env.WAYLAND_DISPLAY;
    chrome = spawn(CHROME!, ["--no-first-run", "--no-default-browser-check", "--password-store=basic", "--use-mock-keychain", "--remote-debugging-port=0", "--ozone-platform=x11",
      ...(process.env.OMB_CDP_SANDBOX === "off" ? ["--no-sandbox"] : []), `--user-data-dir=${dir}`, "about:blank"], { env: { ...env, DISPLAY }, stdio: "ignore" });
    const active = join(dir, "DevToolsActivePort");
    for (let wait = 0; wait < 100 && !existsSync(active); wait++) await new Promise((resolve) => setTimeout(resolve, 100));
    port = Number(readFileSync(active, "utf8").split("\n")[0]);
    const listed = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ id: string; type: string }>;
    firstTab = listed.find((target) => target.type === "page")!.id;
    opened = await new ConnectedBackend("my-chrome", () => devToolsWebSocket(String(port))).open({ key: "mychrome:bot", mode: "headless", fresh: false, viewport: { width: 1280, height: 720 }, downloadDir: dir });
  }, 60_000);

  afterAll(async () => {
    await opened?.close();
    chrome?.kill("SIGKILL");
    await new Promise((resolve) => site?.close(resolve));
    await removeTempDir(dir);
  });

  it("opens a tab, reads its text and takes its picture without the window or the tab in front changing", async () => {
    const windowBefore = focusedWindow(DISPLAY!);
    expect(await visibility(port, firstTab)).toBe("visible");

    const page = await opened.browser.newPage(`http://127.0.0.1:${sitePort}/um`);
    expect(await page.visibleText()).toContain("olá do bot /um");
    await page.click({ selector: "button" });
    expect(await page.visibleText()).toContain("clicado");
    const picture = await page.screenshot();
    expect(picture.data.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(picture.width).toBeGreaterThan(0);

    expect(await visibility(port, firstTab)).toBe("visible");
    expect(focusedWindow(DISPLAY!)).toBe(windowBefore);
  }, 60_000);

  it("gives each bot its own tab, all working at once", async () => {
    const second = await new ConnectedBackend("my-chrome", () => devToolsWebSocket(String(port))).open({ key: "mychrome:other", mode: "headless", fresh: false, viewport: { width: 1280, height: 720 }, downloadDir: dir });
    try {
      const [mine, theirs] = await Promise.all([
        opened.browser.newPage(`http://127.0.0.1:${sitePort}/meu`),
        second.browser.newPage(`http://127.0.0.1:${sitePort}/dele`),
      ]);
      expect(mine.targetId).not.toBe(theirs.targetId);
      expect(await mine.visibleText()).toContain("/meu");
      expect(await theirs.visibleText()).toContain("/dele");
      expect(await visibility(port, firstTab)).toBe("visible");
    } finally {
      await second.close();
    }
  }, 60_000);
});
