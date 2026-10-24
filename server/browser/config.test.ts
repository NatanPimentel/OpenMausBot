import { describe, expect, it } from "vitest";

import { agentDisplay, browserEngineConfigSchema, myChromeTarget } from "./config.ts";

describe("where My Chrome profiles work", () => {
  it("defaults to a background tab of the person's Chrome and the :98 agents' screen", () => {
    expect(myChromeTarget({})).toBe("background-tab");
    expect(agentDisplay({})).toBe(":98");
  });

  it("takes the bot's own browser and another display from config", () => {
    const browserEngine = browserEngineConfigSchema.parse({ myChromeTarget: "own-browser", agentDisplay: ":99" });
    expect(myChromeTarget({ browserEngine })).toBe("own-browser");
    expect(agentDisplay({ browserEngine })).toBe(":99");
  });

  it("refuses a target or display it does not know", () => {
    expect(browserEngineConfigSchema.safeParse({ myChromeTarget: "front" }).success).toBe(false);
    expect(browserEngineConfigSchema.safeParse({ agentDisplay: "localhost:0" }).success).toBe(false);
  });
});
