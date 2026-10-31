
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("reset-all-applications")
        .setDescription("Reset all applications of a selected type")
        .addStringOption((option) =>
            option
                .setName("type")
                .setDescription("Choose the application type")
                .setRequired(true)
                .addChoices(
                    { name: "Staff", value: "staff" },
                    { name: "Media", value: "media" }
                )
        ),

    async execute(interaction, context) {
        const { hasApplicationAccess, pool } = context;

        // Check administrator permissions
        if (!(await hasApplicationAccess(interaction))) {
            return;
        }

        const type = interaction.options.getString("type");

        const tables = {
            staff: "staff_applications",
            media: "media_applications",
        };

        const table = tables[type];

        if (!table) {
            return interaction.reply({
                content: "❌ Invalid application type.",
                ephemeral: true,
            });
        }

        try {
            const result = await pool.query(
                `DELETE FROM ${table}`
            );

            const applicationName =
                type === "staff" ? "Staff" : "Media";

            return interaction.reply({
                content:
                    `✅ Successfully deleted **${result.rowCount}** ` +
                    `${applicationName} application(s).`,
                ephemeral: true,
            });

        } catch (error) {
            console.error(
                "[RESET ALL APPLICATIONS COMMAND]",
                error
            );

            return interaction.reply({
                content: "❌ Failed to reset the selected applications.",
                ephemeral: true,
            });
        }
    },
};
