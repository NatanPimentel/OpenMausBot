import { describe, expect, it } from "vitest";

import { roomMemberAvailability, roomMemberBusy, roomMemberParallelEnabled } from "./room-member-busy.ts";
import { RoomMemberLock } from "./room-member-lock.ts";

const ROOM = "room-thread";
const OTHER_ROOM = "other-room-thread";

const input = (overrides: Partial<Parameters<typeof roomMemberAvailability>[0]> = {}) => ({
  botId: "mrbeast",
  threadId: ROOM,
  botBusy: false,
  speakers: new Map<string, { botId: string }>(),
  busyThreads: 0,
  maxThreads: 4,
  parallel: true,
  lock: new RoomMemberLock(),
  ...overrides,
});

describe("room member availability (local mod room-member-parallel)", () => {
  it("answers the room now when busy only in a 1:1 with a free thread slot", () => {
    expect(roomMemberAvailability(input({ botBusy: true, busyThreads: 1 }))).toBe("ready");
    expect(roomMemberAvailability(input({ botBusy: true, busyThreads: 3 }))).toBe("ready");
  });

  it("waits when its own threads already fill threads.maxConcurrentPerBot", () => {
    expect(roomMemberAvailability(input({ botBusy: true, busyThreads: 4 }))).toBe("busy");
    expect(roomMemberAvailability(input({ botBusy: true, busyThreads: 1, maxThreads: 1 }))).toBe("busy");
  });

  it("waits while it speaks in another room thread", () => {
    const speakers = new Map([[OTHER_ROOM, { botId: "mrbeast" }]]);
    expect(roomMemberAvailability(input({ botBusy: true, speakers }))).toBe("busy");
  });

  it("waits while another room thread holds its claim, but not for its own claim", () => {
    const lock = new RoomMemberLock();
    lock.claim("mrbeast", OTHER_ROOM);
    expect(roomMemberAvailability(input({ lock }))).toBe("busy");
    const own = new RoomMemberLock();
    own.claim("mrbeast", ROOM);
    expect(roomMemberAvailability(input({ lock: own }))).toBe("ready");
  });

  it("ignores other members speaking", () => {
    const speakers = new Map([[OTHER_ROOM, { botId: "ogilvy" }]]);
    expect(roomMemberAvailability(input({ botBusy: true, busyThreads: 1, speakers }))).toBe("ready");
  });

  it("keeps upstream's rule without the flag: any running turn is busy", () => {
    expect(roomMemberAvailability(input({ parallel: false, botBusy: true, busyThreads: 1 }))).toBe("busy");
    expect(roomMemberAvailability(input({ parallel: false }))).toBe("ready");
    expect(roomMemberBusy(input({ parallel: false, botBusy: true }))).toBe(true);
    // The dispatch guards never read the claim: the thread that claimed the member is the one starting the turn.
    expect(roomMemberBusy(input({ parallel: false, botBusy: false }))).toBe(false);
  });

  it("reads the flag from OMB_ROOM_MEMBER_PARALLEL", () => {
    expect(roomMemberParallelEnabled({ OMB_ROOM_MEMBER_PARALLEL: "1" })).toBe(true);
    expect(roomMemberParallelEnabled({ OMB_ROOM_MEMBER_PARALLEL: " true " })).toBe(true);
    expect(roomMemberParallelEnabled({ OMB_ROOM_MEMBER_PARALLEL: "0" })).toBe(false);
    expect(roomMemberParallelEnabled({})).toBe(false);
  });
});
