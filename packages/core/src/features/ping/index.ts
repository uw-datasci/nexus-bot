import { ApplicationCommandType, ephemeral, snowflakeTime } from "@nexus-bot/discord";
import type { FeatureModule } from "../../types";

/** `/ping`: proves the whole path (Discord → transport → registry → gate → handler) works. */
export const ping: FeatureModule = {
  name: "ping",
  guilds: ["exec"],
  commands: [
    {
      definition: {
        name: "ping",
        description: "Check that the bot is up",
        type: ApplicationCommandType.ChatInput,
      },
      capability: "ping",
      handle: (interaction, ctx) => {
        const ms = Math.max(0, ctx.now() - snowflakeTime(interaction.id));
        return { response: ephemeral(`Pong! ${ms} ms from Discord to the bot.`) };
      },
    },
  ],
};
