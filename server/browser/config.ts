// `browserEngine` in config.json.
import { z } from "zod";

import { browserEgressConfigSchema, type BrowserEgressConfig } from "./egress/policy.ts";

const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;

/** agent-browser's `--cdp` takes a bare port or an http(s)/ws(s) DevTools URL. */
export function isValidCdpTarget(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CDP_PORT.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  return CDP_URL.test(value);
}

export type BrowserEngineKind = "agent-browser" | "chrome";

/** Where a My Chrome profile's bots work: a background tab of the person's Chrome, or a browser of the bot's own on the agents' screen. */
export type MyChromeTarget = "background-tab" | "own-browser";

const X_DISPLAY = /^:[0-9]{1,3}$/;
export const DEFAULT_AGENT_DISPLAY = ":98";

/** `attachCdpUrl`: a running Chrome that My Chrome profiles attach to. Config only, never env: the ambient environment must not redirect a bot's browser. */
export const browserEngineConfigSchema = z.object({
  attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value),
    { message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL" }).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(60).optional(), // an unused browser closes after this; 10 when unset, 3 on MausBot Cloud
  egress: browserEgressConfigSchema.optional(),
  /** "chrome" runs the bots' browsers on OpenMausBot's own Chrome driver, an early test; agent-browser is the default. */
  engine: z.enum(["agent-browser", "chrome"]).optional(),
  /** What My Chrome profiles use: "background-tab" (default) opens the bot's tabs behind the person's window and never brings them forward; "own-browser" gives the bot a browser of its own on `agentDisplay`. */
  myChromeTarget: z.enum(["background-tab", "own-browser"]).optional(),
  /** The X display bots use for anything with a window, never the person's own: ":98" when unset. */
  agentDisplay: z.string().trim().regex(X_DISPLAY, { message: "browserEngine.agentDisplay must be an X display such as :98" }).optional(),
});

export interface BrowserEngineConfig {
  attachCdpUrl?: string;
  idleTimeoutMinutes?: number;
  egress?: BrowserEgressConfig;
  engine?: BrowserEngineKind;
  myChromeTarget?: MyChromeTarget;
  agentDisplay?: string;
}

export function browserEngineKind(cfg: { browserEngine?: BrowserEngineConfig }): BrowserEngineKind {
  return cfg.browserEngine?.engine === "chrome" ? "chrome" : "agent-browser";
}

export function myChromeTarget(cfg: { browserEngine?: BrowserEngineConfig }): MyChromeTarget {
  return cfg.browserEngine?.myChromeTarget === "own-browser" ? "own-browser" : "background-tab";
}

export function agentDisplay(cfg: { browserEngine?: BrowserEngineConfig }): string {
  const display = cfg.browserEngine?.agentDisplay;
  return display !== undefined && X_DISPLAY.test(display) ? display : DEFAULT_AGENT_DISPLAY;
}
