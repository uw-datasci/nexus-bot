/**
 * Component and modal IDs are `<feature>:<action>:<id>`, e.g. `evt:review:42`. The dispatcher
 * routes on the feature prefix, then the action; the id is whatever the feature needs (it may
 * itself contain colons). Discord caps custom_id at 100 characters.
 */

export const CUSTOM_ID_MAX_LENGTH = 100;
const PART = /^[a-z0-9_-]+$/i;

export interface CustomId {
  feature: string;
  action: string;
  id: string;
}

export function formatCustomId(feature: string, action: string, id = ""): string {
  if (!PART.test(feature)) throw new Error(`Invalid custom_id feature "${feature}"`);
  if (!PART.test(action)) throw new Error(`Invalid custom_id action "${action}"`);
  const customId = `${feature}:${action}:${id}`;
  if (customId.length > CUSTOM_ID_MAX_LENGTH) {
    throw new Error(
      `custom_id is ${customId.length} characters; Discord allows ${CUSTOM_ID_MAX_LENGTH}`
    );
  }
  return customId;
}

export function parseCustomId(customId: string): CustomId | null {
  const first = customId.indexOf(":");
  const second = first < 0 ? -1 : customId.indexOf(":", first + 1);
  if (second < 0) return null;
  const feature = customId.slice(0, first);
  const action = customId.slice(first + 1, second);
  if (!PART.test(feature) || !PART.test(action)) return null;
  return { feature, action, id: customId.slice(second + 1) };
}
