import { createRegistry } from "../registry";
import type { FeatureModule } from "../types";
import { ping } from "./ping";

/**
 * Every feature the bot has. Adding a module here is the only wiring a feature needs: the
 * register script and the dispatcher both read `registry`.
 */
export const modules: readonly FeatureModule[] = [ping];

export const registry = createRegistry(modules);
