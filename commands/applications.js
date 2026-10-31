
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("applications")
        .setDescription("Manage Staff and Media applications")
        .addStringOption((option) =>
            option
                .setName("id")
                .setDescription("Choose the application type")
                .setRequired(true)
                .addChoices(
                    { name: "Staff", value: "staff" },
                    { name: "Media", value: "media" }
                )
        )
        .addStringOption((option) =>
            option
                .setName("state")
                .setDescription("Open or close applications")
                .setRequired(true)
                .addChoices(
                    { name: "Open", value: "open" },
                    { name: "Closed", value: "closed" }
                )
        ),

    async execute(interaction, context) {
        const {
            hasApplicationAccess,
            updateApplicationStatus,
        } = context;

        // Check administrator permissions
        if (!(await hasApplicationAccess(interaction))) {
            return;
        }

        const type = interaction.options.getString("id");
        const state = interaction.options.getString("state");

        try {
            await updateApplicationStatus(type, state);

            const typeName = type === "staff" ? "Staff" : "Media";
            const statusName = state === "open" ? "OPEN" : "CLOSED";
            const emoji = state === "open" ? "🟢" : "🔴";

            return interaction.reply({
                content: `${emoji} **${typeName} applications are now ${statusName}.**`,
                ephemeral: true,
            });
        } catch (error) {
            console.error("[APPLICATIONS COMMAND]", error);

            return interaction.reply({
                content: "❌ Could not update the application status.",
                ephemeral: true,
            });
        }
    },
};
