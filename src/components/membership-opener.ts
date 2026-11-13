export type MembershipReason = "themes" | "connections" | "membership";
let opener: ((reason: MembershipReason) => void) | null = null;
export function setMembershipOpener(fn: typeof opener) {
  opener = fn;
}
export function openMembership(reason: MembershipReason = "membership") {
  opener?.(reason);
}
