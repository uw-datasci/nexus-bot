import type { FeedbackApp, GuildSettings } from "../../settings";

/**
 * Who may send feedback for which app: any one of the app's role sets, with every role in that
 * set (CxC: `cxc-team`, or `VP` and `Design` together), in one of its channels if it has any.
 * A thread counts as being in its parent channel.
 */
export function appsFor(
  memberRoles: readonly string[],
  channel: { id: string; parent_id?: string | null } | undefined,
  settings: Pick<GuildSettings, "feedbackApps">
): FeedbackApp[] {
  const roles = new Set(memberRoles);
  return Object.values(settings.feedbackApps).filter((app) => {
    const hasRoles = app.roleSets.some((set) => set.every((role) => roles.has(role)));
    if (!hasRoles) return false;
    if (app.channels.length === 0) return true;
    return Boolean(
      channel &&
      (app.channels.includes(channel.id) ||
        (channel.parent_id && app.channels.includes(channel.parent_id)))
    );
  });
}
