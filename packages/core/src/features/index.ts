import { createRegistry } from "../registry";
import type { FeatureModule } from "../types";
import { eventCreate } from "./event-create";
import { feedback } from "./feedback";
import { ping } from "./ping";

/**
 * Every feature the bot has. Adding a module here is the only wiring a feature needs: the
 * register script and the dispatcher both read `registry`.
 */
export const modules: readonly FeatureModule[] = [ping, eventCreate, feedback];

export const registry = createRegistry(modules);
