// imobiturbo-mod-room-member-parallel (local mod, 01/11/2026). Upstream counts a room member busy while any of its turns runs, so a
// member working hours in a 1:1 left the room waiting up to the goal wait cap. With OMB_ROOM_MEMBER_PARALLEL set, a member is busy
// for a room only while it speaks in a room thread, or while its own threads (1:1, teammate, routine) fill threads.maxConcurrentPerBot.
// The per-member claim (RoomMemberLock) still holds it for the room thread that claimed it first.

export const ROOM_MEMBER_PARALLEL_ENV = "OMB_ROOM_MEMBER_PARALLEL";

export function roomMemberParallelEnabled(vars: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test(vars[ROOM_MEMBER_PARALLEL_ENV]?.trim() ?? "");
}

/** Read once at start, like OMB_ENGINE_MAX_ACTIVE: the systemd drop-in sets it for the PC app. */
export const ROOM_MEMBER_PARALLEL = roomMemberParallelEnabled();

export type RoomMemberBusyInput = {
  botId: string;
  /** The stored bot.busy: true while any of the member's turns runs (1:1, teammate, routine or room). */
  botBusy: boolean;
  /** Room threads with a member turn running, keyed by thread id. */
  speakers: Iterable<readonly [string, { botId: string }]>;
  /** The member's own threads working now (1:1, teammate, routine), reservations included. */
  busyThreads: number;
  maxThreads: number;
  parallel: boolean;
};

/** Busy for a room turn, before the per-member claim. Without the flag this is upstream's bot.busy. */
export function roomMemberBusy(input: RoomMemberBusyInput): boolean {
  if (!input.parallel) return input.botBusy;
  for (const [, speaker] of input.speakers) if (speaker.botId === input.botId) return true;
  return input.busyThreads >= input.maxThreads;
}

export type RoomMemberAvailabilityInput = RoomMemberBusyInput & {
  /** The room thread that wants the member. */
  threadId: string;
  lock: { heldElsewhere(botId: string, threadId: string): boolean };
};

export function roomMemberAvailability(input: RoomMemberAvailabilityInput): "ready" | "busy" {
  return roomMemberBusy(input) || input.lock.heldElsewhere(input.botId, input.threadId) ? "busy" : "ready";
}
