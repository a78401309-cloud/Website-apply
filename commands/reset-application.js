
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("reset-application")
        .setDescription("Reset a user's applications from all panels")
        .addUserOption((option) =>
            option
                .setName("user")
                .setDescription("The user whose applications you want to reset")
                .setRequired(true)
        ),

    async execute(interaction, context) {
        const { hasApplicationAccess, pool } = context;

        if (!(await hasApplicationAccess(interaction))) {
            return;
        }

        const user = interaction.options.getUser("user");
        const db = await pool.connect();

        try {
            await db.query("BEGIN");

            const staffResult = await db.query(
                "DELETE FROM staff_applications WHERE discord_id = $1",
                [user.id]
            );

            const mediaResult = await db.query(
                "DELETE FROM media_applications WHERE discord_id = $1",
                [user.id]
            );

            await db.query("COMMIT");

            const staffDeleted = staffResult.rowCount || 0;
            const mediaDeleted = mediaResult.rowCount || 0;
            const totalDeleted = staffDeleted + mediaDeleted;

            if (totalDeleted === 0) {
                return interaction.reply({
                    content: `⚠️ No applications were found for **${user.tag}** in any panel.`,
                    ephemeral: true,
                });
            }

            return interaction.reply({
                content:
                    `✅ Successfully reset **${user.tag}**'s applications.\n\n` +
                    `📝 Staff applications deleted: **${staffDeleted}**\n` +
                    `🎬 Media applications deleted: **${mediaDeleted}**\n` +
                    `📋 Total deleted: **${totalDeleted}**`,
                ephemeral: true,
            });

        } catch (error) {
            await db.query("ROLLBACK").catch(() => {});

            console.error("[RESET APPLICATION COMMAND]", error);

            return interaction.reply({
                content: "❌ Failed to reset the user's applications.",
                ephemeral: true,
            });

        } finally {
            db.release();
        }
    },
};
