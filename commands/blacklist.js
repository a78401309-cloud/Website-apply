
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("blacklist")
        .setDescription("Manage the application blacklist")

        .addSubcommand((subcommand) =>
            subcommand
                .setName("add")
                .setDescription("Add a user to the blacklist")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("User to blacklist")
                        .setRequired(true)
                )
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("remove")
                .setDescription("Remove a user from the blacklist")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("User to remove")
                        .setRequired(true)
                )
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("check")
                .setDescription("Check if a user is blacklisted")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("User to check")
                        .setRequired(true)
                )
        )

        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("Show all blacklisted users")
        ),

    async execute(interaction, context) {
        const {
            hasApplicationAccess,
            addToBlacklist,
            removeFromBlacklist,
            isUserBlacklisted,
            getBlacklist,
        } = context;

        if (!(await hasApplicationAccess(interaction))) {
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === "add") {
                const user = interaction.options.getUser("user");

                const alreadyBlacklisted = await isUserBlacklisted(user.id);

                if (alreadyBlacklisted) {
                    return interaction.reply({
                        content: `⚠️ ${user} is already blacklisted.`,
                        ephemeral: true,
                    });
                }

                await addToBlacklist(user.id);

                return interaction.reply({
                    content: `🔴 **${user.tag}** has been added to the application blacklist.`,
                    ephemeral: true,
                });
            }

            if (subcommand === "remove") {
                const user = interaction.options.getUser("user");

                const isBlacklisted = await isUserBlacklisted(user.id);

                if (!isBlacklisted) {
                    return interaction.reply({
                        content: `⚠️ ${user} is not blacklisted.`,
                        ephemeral: true,
                    });
                }

                await removeFromBlacklist(user.id);

                return interaction.reply({
                    content: `🟢 **${user.tag}** has been removed from the application blacklist.`,
                    ephemeral: true,
                });
            }

            if (subcommand === "check") {
                const user = interaction.options.getUser("user");

                const isBlacklisted = await isUserBlacklisted(user.id);

                return interaction.reply({
                    content: isBlacklisted
                        ? `🔴 **${user.tag}** is blacklisted.`
                        : `🟢 **${user.tag}** is not blacklisted.`,
                    ephemeral: true,
                });
            }

            if (subcommand === "list") {
                const blacklist = await getBlacklist();

                if (!blacklist || blacklist.length === 0) {
                    return interaction.reply({
                        content: "📋 The application blacklist is empty.",
                        ephemeral: true,
                    });
                }

                const description = blacklist
                    .map((userId, index) => `**${index + 1}.** <@${userId}> \`(${userId})\``)
                    .join("\n");

                const embed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle("🔴 Application Blacklist")
                    .setDescription(description.slice(0, 4000))
                    .setFooter({
                        text: `Total blacklisted users: ${blacklist.length}`,
                    })
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    ephemeral: true,
                });
            }
        } catch (error) {
            console.error("[BLACKLIST COMMAND]", error);

            const response = {
                content: "❌ An error occurred while managing the blacklist.",
                ephemeral: true,
            };

            if (interaction.replied || interaction.deferred) {
                return interaction.followUp(response);
            }

            return interaction.reply(response);
        }
    },
};
