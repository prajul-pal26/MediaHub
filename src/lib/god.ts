/**
 * "God mode" — a streamlined, single-user dashboard for personal/self use.
 *
 * When the signed-in account is a god user, the UI hides all the multi-tenant /
 * agency chrome (Brands, the org/brand switcher, and the Users / Organization /
 * LLM-Access settings tabs) so the app feels like a personal studio. This is a
 * UI-only convenience — nothing in the multi-tenant backend or RBAC is changed
 * or removed, so full team/org features remain intact for any other account.
 */
export const GOD_EMAILS = ["admin@mediahub.local", "agent@cotgen.in"];

export function isGodUser(
  profile: { email?: string | null } | null | undefined,
): boolean {
  return !!profile?.email && GOD_EMAILS.includes(profile.email);
}
