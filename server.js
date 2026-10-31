
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const axios = require("axios");
const fs = require("fs");
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    EmbedBuilder,
} = require("discord.js");
const path = require("path");
const pool = require("./db");

const app = express();

const PORT = process.env.PORT || 16627;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CLIENT_REDIRECT_URI = process.env.CLIENT_REDIRECT_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

const GUILD_ID = "1537098808767414303";
const ADMIN_ROLE_ID = "1565213262545555538";

const COMMANDS_PATH = path.join(__dirname, "commands");

const APPLICATION_COOLDOWN_DAYS = 30;

app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// -------------------- DATABASE INITIALIZATION --------------------

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS staff_applications (
            id BIGSERIAL PRIMARY KEY,
            discord_id VARCHAR(30) NOT NULL UNIQUE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            application_date VARCHAR(50),
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            reviewed_at TIMESTAMPTZ,
            reviewed_by VARCHAR(30),
            dm_sent BOOLEAN,
            dm_sent_at TIMESTAMPTZ,
            dm_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS media_applications (
            id BIGSERIAL PRIMARY KEY,
            discord_id VARCHAR(30) NOT NULL UNIQUE,
            username VARCHAR(100),
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            application_date VARCHAR(50),
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            reviewed_at TIMESTAMPTZ,
            reviewed_by VARCHAR(30),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS application_settings (
            setting_key VARCHAR(100) PRIMARY KEY,
            setting_value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS application_blacklist (
            discord_id VARCHAR(30) PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE staff_applications
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE media_applications
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_staff_applications_status
        ON staff_applications(status)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_media_applications_status
        ON media_applications(status)
    `);

    await pool.query(`
        INSERT INTO application_settings (setting_key, setting_value)
        VALUES
            ('staff_applications_open', 'true'::jsonb),
            ('media_applications_open', 'true'::jsonb)
        ON CONFLICT (setting_key) DO NOTHING
    `);

    console.log("PostgreSQL tables initialized successfully.");
}

// -------------------- DATABASE HELPERS --------------------

async function getSetting(key, fallback = true) {
    const result = await pool.query(
        `SELECT setting_value
         FROM application_settings
         WHERE setting_key = $1`,
        [key]
    );

    if (!result.rows.length) return fallback;

    return result.rows[0].setting_value;
}

async function setSetting(key, value) {
    await pool.query(
        `INSERT INTO application_settings
            (setting_key, setting_value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (setting_key)
         DO UPDATE SET
            setting_value = EXCLUDED.setting_value,
            updated_at = NOW()`,
        [key, JSON.stringify(value)]
    );
}

async function getStaffApplication(userId) {
    const result = await pool.query(
        `SELECT *
         FROM staff_applications
         WHERE discord_id = $1`,
        [userId]
    );

    return result.rows[0] || null;
}

async function getMediaApplication(userId) {
    const result = await pool.query(
        `SELECT *
         FROM media_applications
         WHERE discord_id = $1`,
        [userId]
    );

    return result.rows[0] || null;
}

async function getApplicationCooldown(type, userId) {
    const tables = {
        staff: "staff_applications",
        media: "media_applications",
    };

    const table = tables[type];

    if (!table) {
        throw new Error("Invalid application type.");
    }

    const result = await pool.query(
        `SELECT
            status,
            reviewed_at,
            CASE
                WHEN status IN ('accepted', 'rejected')
                     AND reviewed_at IS NOT NULL
                     AND reviewed_at > NOW() - INTERVAL '30 days'
                THEN reviewed_at + INTERVAL '30 days'
                ELSE NULL
            END AS cooldown_until
         FROM ${table}
         WHERE discord_id = $1`,
        [userId]
    );

    if (!result.rows.length || !result.rows[0].cooldown_until) {
        return {
            active: false,
            until: null,
            remainingMs: 0,
        };
    }

    const cooldownUntil = new Date(result.rows[0].cooldown_until);
    const remainingMs = cooldownUntil.getTime() - Date.now();

    if (remainingMs <= 0) {
        return {
            active: false,
            until: null,
            remainingMs: 0,
        };
    }

    return {
        active: true,
        until: cooldownUntil,
        remainingMs,
    };
}

async function getAllStaffApplications() {
    const result = await pool.query(
        `SELECT *
         FROM staff_applications
         ORDER BY
            CASE status
                WHEN 'pending' THEN 0
                WHEN 'accepted' THEN 1
                WHEN 'rejected' THEN 2
                ELSE 3
            END,
            created_at DESC`
    );

    return result.rows;
}

async function getAllMediaApplications() {
    const result = await pool.query(
        `SELECT *
         FROM media_applications
         ORDER BY
            CASE status
                WHEN 'pending' THEN 0
                WHEN 'accepted' THEN 1
                WHEN 'rejected' THEN 2
                ELSE 3
            END,
            created_at DESC`
    );

    return result.rows;
}

async function isUserBlacklisted(userId) {
    const result = await pool.query(
        `SELECT 1
         FROM application_blacklist
         WHERE discord_id = $1`,
        [userId]
    );

    return result.rowCount > 0;
}

async function addToBlacklist(userId) {
    await pool.query(
        `INSERT INTO application_blacklist (discord_id)
         VALUES ($1)
         ON CONFLICT (discord_id) DO NOTHING`,
        [userId]
    );
}

async function removeFromBlacklist(userId) {
    await pool.query(
        `DELETE FROM application_blacklist
         WHERE discord_id = $1`,
        [userId]
    );
}

async function getBlacklist() {
    const result = await pool.query(
        `SELECT discord_id
         FROM application_blacklist
         ORDER BY created_at DESC`
    );

    return result.rows.map((row) => row.discord_id);
}

// -------------------- COOLDOWN HELPERS --------------------

function formatCooldown(remainingMs) {
    const totalSeconds = Math.max(
        0,
        Math.ceil(remainingMs / 1000)
    );

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    return {
        days,
        hours,
        minutes,
        text: `${days}d ${hours}h ${minutes}m`,
    };
}

function getCooldownError(type) {
    return type === "staff"
        ? "staff-cooldown"
        : "media-cooldown";
}

// -------------------- SESSION STORAGE --------------------

if (!SESSION_SECRET || SESSION_SECRET === "CHANGE_THIS_SESSION_SECRET") {
    throw new Error("Please configure a secure SESSION_SECRET environment variable.");
}

app.use(
    session({
        store: new pgSession({
            pool,
            tableName: "user_sessions",
            createTableIfMissing: true,
            pruneSessionInterval: 15 * 60,
        }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            maxAge: 7 * 24 * 60 * 60 * 1000,
        },
    })
);

// -------------------- APPLICATION STATUS --------------------

let isApplicationsOpen = true;
let isMediaApplicationsOpen = true;

async function loadApplicationSettings() {
    isApplicationsOpen = await getSetting(
        "staff_applications_open",
        true
    );

    isMediaApplicationsOpen = await getSetting(
        "media_applications_open",
        true
    );
}

async function updateApplicationStatus(type, state) {
    if (!["open", "closed"].includes(state)) {
        throw new Error("Invalid application state.");
    }

    if (type === "staff") {
        isApplicationsOpen = state === "open";

        await setSetting(
            "staff_applications_open",
            isApplicationsOpen
        );

        return isApplicationsOpen;
    }

    if (type === "media") {
        isMediaApplicationsOpen = state === "open";

        await setSetting(
            "media_applications_open",
            isMediaApplicationsOpen
        );

        return isMediaApplicationsOpen;
    }

    throw new Error("Unknown application type.");
}

// -------------------- DISCORD BOT --------------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
    ],
});

let botReady = false;

const commands = new Map();

client.once("ready", async () => {
    botReady = true;

    console.log(`Discord bot logged in as ${client.user.tag}`);

    try {
        await registerSlashCommands();
    } catch (error) {
        console.error("Slash command registration failed:", error);
    }
});

client.on("error", (error) => {
    console.error("Discord client error:", error);
});

// -------------------- APPLICATION REVIEW DM MESSAGES --------------------

async function sendApplicationDecisionDM(userId, status) {
    if (!botReady) {
        throw new Error("Discord bot is not ready.");
    }

    const user = await client.users.fetch(userId);

    let embed;

    if (status === "accepted") {
        embed = new EmbedBuilder()
            .setColor("#57F287")
            .setTitle("✅ Application Accepted")
            .setDescription(
                [
                    "## Congratulations! 🎉",
                    "",
                    "We’re pleased to inform you that your staff application has been **accepted**! Your effort, answers, and interest in joining the RavixMC team stood out to our staff management.",
                    "",
                    "### What's next?",
                    "",
                    "Please open a **General Support** ticket in the RavixMC Discord server to receive your next steps and complete the onboarding process.",
                    "",
                    "Welcome to the team! We look forward to working with you.",
                    "",
                    "— **RavixMC Management**",
                ].join("\n")
            )
            .setFooter({ text: "RavixMC Management" })
            .setTimestamp();
    } else if (status === "rejected") {
        embed = new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("❌ Application Declined")
            .setDescription(
                [
                    "## Thank You for Applying",
                    "",
                    "After careful consideration, we’ve decided not to move forward with your staff application at this time.",
                    "",
                    "We appreciate the time and effort you invested in applying to join the RavixMC team. This decision doesn’t mean you can’t become part of our team in the future.",
                    "",
                    "We encourage you to stay active, continue contributing to the community, and apply again when applications reopen.",
                    "",
                    "Thank you for your understanding, and we wish you the best on RavixMC!",
                    "",
                    "— **RavixMC Management**",
                ].join("\n")
            )
            .setFooter({ text: "RavixMC Management" })
            .setTimestamp();
    } else {
        throw new Error("Invalid application decision.");
    }

    await user.send({ embeds: [embed] });

    console.log(
        `Application ${status} DM successfully sent to ${user.tag} (${userId}).`
    );
}
// -------------------- MEDIA APPLICATION DECISION DM --------------------

async function sendMediaApplicationDecisionDM(userId, status) {
    if (!botReady) {
        throw new Error("Discord bot is not ready.");
    }

    const user = await client.users.fetch(userId);

    let embed;

    if (status === "accepted") {
        embed = new EmbedBuilder()
            .setColor("#57F287")
            .setTitle("✅ Media Application Accepted")
            .setDescription(
                [
                    "## Congratulations! 🎉",
                    "",
                    "Your application to join the **RavixMC Media Team** has been accepted!",
                    "",
                    "We're excited to welcome you to our Media Team.",
                    "",
                    "### What's next?",
                    "",
                    "Please open a **General Support** ticket in the RavixMC Discord server to receive your next steps.",
                    "",
                    "Welcome to the team!",
                    "",
                    "— **RavixMC Management**",
                ].join("\n")
            )
            .setFooter({ text: "RavixMC Media Team" })
            .setTimestamp();

    } else if (status === "rejected") {
        embed = new EmbedBuilder()
            .setColor("#ED4245")
            .setTitle("❌ Media Application Declined")
            .setDescription(
                [
                    "## Thank You for Applying",
                    "",
                    "After reviewing your application, we've decided not to move forward with your Media Team application at this time.",
                    "",
                    "We appreciate your interest and the effort you put into applying.",
                    "",
                    "You can continue creating content, stay active in the community, and apply again when applications reopen.",
                    "",
                    "Thank you for your understanding!",
                    "",
                    "— **RavixMC Management**",
                ].join("\n")
            )
            .setFooter({ text: "RavixMC Media Team" })
            .setTimestamp();

    } else {
        throw new Error("Invalid media application decision.");
    }

    await user.send({ embeds: [embed] });

    console.log(
        `Media application ${status} DM successfully sent to ${user.tag} (${userId}).`
    );
}

// -------------------- DYNAMIC COMMAND HANDLER --------------------

function loadCommands() {
    commands.clear();

    if (!fs.existsSync(COMMANDS_PATH)) {
        fs.mkdirSync(COMMANDS_PATH, { recursive: true });
        console.log("[COMMANDS] Created commands folder.");
    }

    const commandFiles = fs.readdirSync(COMMANDS_PATH)
        .filter((file) => file.endsWith(".js"));

    for (const file of commandFiles) {
        const filePath = path.join(COMMANDS_PATH, file);

        try {
            delete require.cache[require.resolve(filePath)];

            const command = require(filePath);

            if (!command.data || typeof command.execute !== "function") {
                console.warn(
                    `[COMMANDS] Skipped ${file}: command must export data and execute.`
                );
                continue;
            }

            const commandName = command.data.name;

            if (!commandName) {
                console.warn(
                    `[COMMANDS] Skipped ${file}: command name is missing.`
                );
                continue;
            }

            if (commands.has(commandName)) {
                console.warn(
                    `[COMMANDS] Duplicate command name "${commandName}" in ${file}.`
                );
                continue;
            }

            commands.set(commandName, command);

            console.log(`[COMMANDS] Loaded /${commandName}`);
        } catch (error) {
            console.error(
                `[COMMANDS] Failed to load ${file}:`,
                error
            );
        }
    }

    return [...commands.values()];
}

async function registerSlashCommands() {
    if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
        throw new Error("BOT_TOKEN, CLIENT_ID, or GUILD_ID is missing.");
    }

    const loadedCommands = loadCommands();

    const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

    await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        {
            body: loadedCommands.map((command) => command.data.toJSON()),
        }
    );

    console.log(
        `[COMMANDS] Successfully registered ${loadedCommands.length} guild commands.`
    );
}

// -------------------- DISCORD MEMBER ACCESS --------------------

async function getGuildMember(userId) {
    if (!botReady) {
        throw new Error("Discord bot is not ready.");
    }

    const guild = await client.guilds.fetch(GUILD_ID);

    return guild.members.fetch(userId);
}

async function memberHasAdminRole(userId) {
    try {
        const member = await getGuildMember(userId);

        return member.roles.cache.has(ADMIN_ROLE_ID);
    } catch (error) {
        console.error(
            `Could not verify roles for ${userId}:`,
            error.message
        );

        return false;
    }
}

async function hasApplicationAccess(interaction) {
    const allowed = await memberHasAdminRole(interaction.user.id);

    if (!allowed) {
        await interaction.reply({
            content: "You do not have the Application Access role.",
            ephemeral: true,
        });

        return false;
    }

    return true;
}

// -------------------- STAFF APPLICATION REVIEW --------------------

async function setApplicationStatus(userId, status, moderatorId) {
    if (!["accepted", "rejected"].includes(status)) {
        throw new Error("Invalid application status.");
    }

    const result = await pool.query(
        `UPDATE staff_applications
         SET
            status = $2,
            reviewed_at = NOW(),
            reviewed_by = $3,
            updated_at = NOW()
         WHERE discord_id = $1
           AND status = 'pending'
         RETURNING *`,
        [userId, status, moderatorId]
    );

    if (!result.rows.length) {
        const existing = await getStaffApplication(userId);

        if (!existing) {
            throw new Error("Application not found.");
        }

        throw new Error("This application has already been reviewed.");
    }

    let application = result.rows[0];

    try {
        await sendApplicationDecisionDM(userId, status);

        const dmResult = await pool.query(
            `UPDATE staff_applications
             SET
                dm_sent = TRUE,
                dm_sent_at = NOW(),
                dm_error = NULL,
                updated_at = NOW()
             WHERE discord_id = $1
             RETURNING *`,
            [userId]
        );

        application = dmResult.rows[0];
    } catch (error) {
        console.error(
            `Could not send ${status} DM to ${userId}:`,
            error.message
        );

        const dmResult = await pool.query(
            `UPDATE staff_applications
             SET
                dm_sent = FALSE,
                dm_error = $2,
                updated_at = NOW()
             WHERE discord_id = $1
             RETURNING *`,
            [userId, error.message]
        );

        application = dmResult.rows[0];
    }

    return application;
}

// -------------------- DYNAMIC INTERACTION HANDLER --------------------

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);

    if (!command) {
        return interaction.reply({
            content: "This command could not be found. Please contact an administrator.",
            ephemeral: true,
        }).catch(() => {});
    }

    try {
        await command.execute(interaction, {
            client,
            pool,

            getSetting,
            setSetting,

            getStaffApplication,
            getMediaApplication,
            getAllStaffApplications,
            getAllMediaApplications,

            isUserBlacklisted,
            addToBlacklist,
            removeFromBlacklist,
            getBlacklist,

            memberHasAdminRole,
            hasApplicationAccess,

            sendApplicationDecisionDM,
            setApplicationStatus,

            updateApplicationStatus,

            isApplicationsOpen: () => isApplicationsOpen,
            isMediaApplicationsOpen: () => isMediaApplicationsOpen,
        });
    } catch (error) {
        console.error(
            `[COMMAND ERROR] /${interaction.commandName}:`,
            error
        );

        const response = {
            content: "An unexpected error occurred while executing this command.",
            ephemeral: true,
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// -------------------- AUTHENTICATION MIDDLEWARE --------------------

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/");
    }

    next();
}

async function requireAdminAccess(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/");
    }

    const allowed = await memberHasAdminRole(req.session.user.id);

    if (!allowed) {
        return res.status(403).send(`
            <!doctype html>
            <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Access Denied</title>
                <style>
                    body {
                        background: #09070f;
                        color: white;
                        font-family: Arial, sans-serif;
                        display: grid;
                        place-items: center;
                        min-height: 100vh;
                        margin: 0;
                        text-align: center;
                    }
                    a { color: #c084fc; }
                </style>
            </head>
            <body>
                <div>
                    <h1>403 — Access Denied</h1>
                    <p>You need the Application Access role to view this page.</p>
                    <a href="/dashboard">Return to dashboard</a>
                </div>
            </body>
            </html>
        `);
    }

    next();
}

// -------------------- APPLICATION DETAILS PAGE HELPERS --------------------

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderApplicationDetailsPage({
    title,
    username,
    userId,
    date,
    status,
    answers,
    questions,
    reviewUrl,
    backUrl = "/admin",
    extraInfo = "",
}) {
    const safeTitle = escapeHtml(title);
    const safeUsername = escapeHtml(username || "Unknown User");
    const safeUserId = escapeHtml(userId);
    const safeDate = escapeHtml(date || "Not provided");
    const safeStatus = escapeHtml(status || "pending");

    const statusColors = {
        pending: "#fbbf24",
        accepted: "#4ade80",
        rejected: "#f87171",
    };

    const statusColor = statusColors[status] || "#c084fc";

    const answerCards = questions.map(([key, label]) => {
        const answer = answers?.[key];

        return `
            <article class="answer-card">
                <div class="question">${escapeHtml(label)}</div>
                <div class="answer">${answer
                    ? escapeHtml(answer).replace(/\n/g, "<br>")
                    : '<span class="empty">No answer provided</span>'}
                </div>
            </article>
        `;
    }).join("");

    const actions = status === "pending"
        ? `
            <div class="actions">
                <form method="POST" action="${reviewUrl}/accept"
                    onsubmit="return confirm('Are you sure you want to accept this application?')">
                    <button class="action-button accept" type="submit">
                        ✓ Accept Application
                    </button>
                </form>

                <form method="POST" action="${reviewUrl}/reject"
                    onsubmit="return confirm('Are you sure you want to deny this application?')">
                    <button class="action-button deny" type="submit">
                        ✕ Deny Application
                    </button>
                </form>
            </div>
        `
        : `
            <div class="reviewed-notice">
                This application has already been ${safeStatus}.
            </div>
        `;

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${safeTitle} · RavixMC</title>

            <style>
                * {
                    box-sizing: border-box;
                }

                body {
                    margin: 0;
                    min-height: 100vh;
                    padding: 40px 20px;
                    background:
                        radial-gradient(ellipse at top, rgba(109, 40, 217, .17), transparent 50%),
                        #09070f;
                    color: #f5f3ff;
                    font-family: Inter, Arial, sans-serif;
                }

                .container {
                    width: 100%;
                    max-width: 950px;
                    margin: auto;
                }

                .back {
                    display: inline-flex;
                    align-items: center;
                    gap: 9px;
                    color: #c4b5fd;
                    text-decoration: none;
                    font-size: 14px;
                    font-weight: 700;
                    margin-bottom: 25px;
                }

                .back:hover {
                    color: white;
                }

                .header {
                    padding: 30px;
                    border: 1px solid rgba(167, 139, 250, .18);
                    border-radius: 22px;
                    background: rgba(24, 17, 39, .85);
                    margin-bottom: 22px;
                }

                .eyebrow {
                    color: #a78bfa;
                    font-size: 11px;
                    font-weight: 800;
                    letter-spacing: 2px;
                    text-transform: uppercase;
                }

                h1 {
                    margin: 12px 0 20px;
                    font-size: clamp(25px, 5vw, 36px);
                    letter-spacing: -1px;
                }

                .meta {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    color: #a8a0b9;
                    font-size: 13px;
                }

                .meta span {
                    padding: 9px 12px;
                    border-radius: 9px;
                    background: rgba(255, 255, 255, .04);
                }

                .status {
                    color: ${statusColor};
                    font-weight: 800;
                    text-transform: capitalize;
                }

                .section-title {
                    margin: 28px 0 15px;
                    font-size: 18px;
                    font-weight: 800;
                }

                .answers {
                    display: grid;
                    grid-template-columns: 1fr;
                    gap: 12px;
                }

                .answer-card {
                    padding: 20px;
                    border-radius: 15px;
                    border: 1px solid rgba(167, 139, 250, .12);
                    background: rgba(20, 15, 31, .9);
                }

                .question {
                    color: #c4b5fd;
                    font-size: 13px;
                    font-weight: 800;
                    margin-bottom: 11px;
                }

                .answer {
                    color: #eeeaf7;
                    font-size: 14px;
                    line-height: 1.8;
                    overflow-wrap: anywhere;
                }

                .empty {
                    color: #777084;
                    font-style: italic;
                }

                .actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    margin-top: 25px;
                }

                .actions form {
                    flex: 1;
                    min-width: 180px;
                }

                .action-button {
                    width: 100%;
                    border: 0;
                    border-radius: 12px;
                    padding: 15px 20px;
                    color: white;
                    font-size: 14px;
                    font-weight: 800;
                    cursor: pointer;
                    transition: .2s ease;
                }

                .action-button:hover {
                    transform: translateY(-2px);
                    filter: brightness(1.12);
                }

                .accept {
                    background: #15803d;
                }

                .deny {
                    background: #b91c1c;
                }

                .reviewed-notice {
                    margin-top: 25px;
                    padding: 17px;
                    border: 1px solid rgba(167, 139, 250, .2);
                    border-radius: 12px;
                    background: rgba(109, 40, 217, .1);
                    color: #ddd6fe;
                    font-weight: 700;
                }

                @media (min-width: 700px) {
                    .answers {
                        grid-template-columns: 1fr 1fr;
                    }

                    .answer-card:last-child:nth-child(odd) {
                        grid-column: 1 / -1;
                    }
                }
            </style>
        </head>

        <body>
            <main class="container">
                <a class="back" href="${backUrl}">
                    ← Back to Applications
                </a>

                <header class="header">
                    <div class="eyebrow">RavixMC · Application Management</div>
                    <h1>${safeTitle}</h1>

                    <div class="meta">
                        <span>Discord: ${safeUsername}</span>
                        <span>ID: ${safeUserId}</span>
                        <span>Submitted: ${safeDate}</span>
                        <span>Status: <strong class="status">${safeStatus}</strong></span>
                    </div>

                    ${extraInfo}
                </header>

                <h2 class="section-title">Application Answers</h2>

                <section class="answers">
                    ${answerCards}
                </section>

                ${actions}
            </main>
        </body>
        </html>
    `;
}

// -------------------- WEBSITE ROUTES --------------------

app.get("/", (req, res) => {
    if (req.session.user) {
        return res.redirect("/dashboard");
    }

    res.render("index");
});

// -------------------- DISCORD OAUTH --------------------

app.get("/login", (req, res) => {
    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: CLIENT_REDIRECT_URI,
        response_type: "code",
        scope: "identify",
    });

    res.redirect(
        `https://discord.com/oauth2/authorize?${params.toString()}`
    );
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.redirect("/");
    }

    try {
        const tokenResponse = await axios.post(
            "https://discord.com/api/oauth2/token",
            new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: "authorization_code",
                code,
                redirect_uri: CLIENT_REDIRECT_URI,
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );

        const accessToken = tokenResponse.data.access_token;

        const userResponse = await axios.get(
            "https://discord.com/api/users/@me",
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        req.session.user = {
            id: userResponse.data.id,
            username: userResponse.data.username,
            avatar: userResponse.data.avatar,
        };

        req.session.save((error) => {
            if (error) {
                console.error("Session save error:", error);

                return res.status(500).send(
                    "Could not create your session."
                );
            }

            res.redirect("/dashboard");
        });
    } catch (error) {
        console.error(
            "Discord OAuth error:",
            error.response?.data || error.message
        );

        res.status(500).send(
            "Discord login failed. Please try again."
        );
    }
});

// -------------------- USER DASHBOARD --------------------

app.get("/dashboard", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;

        const [
            application,
            mediaApplication,
            canAccessAdmin,
            staffCooldown,
            mediaCooldown,
        ] = await Promise.all([
            getStaffApplication(userId),
            getMediaApplication(userId),
            memberHasAdminRole(userId),
            getApplicationCooldown("staff", userId),
            getApplicationCooldown("media", userId),
        ]);

        res.render("dashboard", {
            user: req.session.user,

            application: application
                ? {
                    ...application,
                    date: application.application_date,
                    reviewedAt: application.reviewed_at,
                    reviewedBy: application.reviewed_by,
                }
                : null,

            mediaApplication: mediaApplication
                ? {
                    ...mediaApplication,
                    date: mediaApplication.application_date,
                    reviewedAt: mediaApplication.reviewed_at,
                    reviewedBy: mediaApplication.reviewed_by,
                }
                : null,

            staffCooldown,
            mediaCooldown,

            customError: req.query.error || null,
            isAppOpen: isApplicationsOpen,
            isMediaAppOpen: isMediaApplicationsOpen,
            canAccessAdmin,
        });
    } catch (error) {
        console.error("Dashboard error:", error);

        res.status(500).send(
            "Could not load your dashboard."
        );
    }
});

// -------------------- ADMIN DASHBOARD --------------------

app.get("/admin", requireAdminAccess, async (req, res) => {
    try {
        const [staffRows, mediaRows] = await Promise.all([
            getAllStaffApplications(),
            getAllMediaApplications(),
        ]);

        const applications = await Promise.all(
            staffRows.map(async (application) => {
                let username = "Unknown applicant";

                if (botReady && application.discord_id) {
                    try {
                        const discordUser = await client.users.fetch(
                            application.discord_id
                        );

                        username = discordUser.username;
                    } catch (error) {
                        console.error(
                            `Could not fetch Discord username for ${application.discord_id}:`,
                            error.message
                        );
                    }
                }

                return {
                    ...application,
                    userId: application.discord_id,
                    username,
                    date: application.application_date,
                    reviewedAt: application.reviewed_at,
                    reviewedBy: application.reviewed_by,
                    dmSent: application.dm_sent,
                    dmSentAt: application.dm_sent_at,
                    dmError: application.dm_error,
                };
            })
        );

        const mediaApplications = mediaRows.map((application) => ({
            userId: application.discord_id,
            ...application,
            date: application.application_date,
            reviewedAt: application.reviewed_at,
            reviewedBy: application.reviewed_by,
        }));

        res.render("admin", {
            user: req.session.user,
            applications,
            mediaApplications,
            isAppOpen: isApplicationsOpen,
            isMediaAppOpen: isMediaApplicationsOpen,
        });
    } catch (error) {
        console.error("Admin dashboard error:", error);

        res.status(500).send(
            "Could not load the admin dashboard."
        );
    }
});

// -------------------- STAFF APPLICATION DETAILS --------------------

app.get(
    "/admin/applications/:userId",
    requireAdminAccess,
    async (req, res) => {
        try {
            const application = await getStaffApplication(req.params.userId);

            if (!application) {
                return res.status(404).send("Application not found.");
            }

            const questions = [
                ["q1", "Question 1"],
                ["q2", "Question 2"],
                ["q3", "Question 3"],
                ["q4", "Question 4"],
                ["q5", "Question 5"],
                ["q6", "Question 6"],
                ["q7", "Question 7"],
                ["q8", "Question 8"],
                ["q9", "Question 9"],
                ["q10", "Question 10"],
                ["q11", "Question 11"],
                ["q12", "Question 12"],
                ["q13", "Question 13"],
                ["q14", "Question 14"],
                ["q15", "Question 15"],
                ["q16", "Question 16"],
                ["q17", "Question 17"],
                ["q18", "Question 18"],
            ];

            let username = application.discord_id;
            let avatarUrl = null;

            if (botReady) {
                try {
                    const discordUser = await client.users.fetch(
                        application.discord_id
                    );

                    username = discordUser.username;
                    avatarUrl = discordUser.displayAvatarURL({
                        size: 256,
                        extension: "png",
                    });
                } catch (error) {
                    console.error(
                        "Could not fetch staff applicant Discord profile:",
                        error.message
                    );
                }
            }

            return res.send(renderApplicationDetailsPage({
                title: "Staff Application",
                username,
                userId: application.discord_id,
                avatarUrl,
                date: application.application_date,
                status: application.status,
                answers: application.answers,
                questions,
                reviewUrl: `/admin/applications/${encodeURIComponent(application.discord_id)}`,
            }));
        } catch (error) {
            console.error("Staff application details error:", error);

            return res.status(500).send(
                "Could not load application details."
            );
        }
    }
);

// -------------------- MEDIA APPLICATION DETAILS --------------------

app.get(
    "/admin/media-applications/:userId",
    requireAdminAccess,
    async (req, res) => {
        try {
            const application = await getMediaApplication(req.params.userId);

            if (!application) {
                return res.status(404).send("Media application not found.");
            }

            const questions = [
                ["creatorName", "Creator / Channel Name"],
                ["discordUsername", "Discord Username"],
                ["age", "Age"],
                ["platforms", "Platforms"],
                ["channelLink", "Channel Link"],
                ["audience", "Audience Size"],
                ["contentType", "Content Type"],
                ["portfolio", "Recent Content / Portfolio"],
                ["frequency", "Posting Frequency"],
                ["whyRavix", "Why RavixMC"],
                ["extra", "Additional Information"],
            ];

            return res.send(renderApplicationDetailsPage({
                title: "Media Application",
                username: application.username || application.discord_id,
                userId: application.discord_id,
                date: application.application_date,
                status: application.status,
                answers: application.answers,
                questions,
                reviewUrl: `/admin/media-applications/${encodeURIComponent(application.discord_id)}`,
            }));
        } catch (error) {
            console.error("Media application details error:", error);

            return res.status(500).send(
                "Could not load media application details."
            );
        }
    }
);

// -------------------- STAFF APPLICATION REVIEW ROUTE --------------------

app.post(
    "/admin/applications/:userId/:decision",
    requireAdminAccess,
    async (req, res) => {
        const { userId, decision } = req.params;

        if (!["accept", "reject"].includes(decision)) {
            return res.status(400).send("Invalid decision.");
        }

        try {
            await setApplicationStatus(
                userId,
                decision === "accept" ? "accepted" : "rejected",
                req.session.user.id
            );

            return res.redirect("/admin");
        } catch (error) {
            return res.status(400).send(error.message);
        }
    }
);

// -------------------- MEDIA APPLICATION REVIEW ROUTE --------------------

app.post(
    "/admin/media-applications/:userId/:decision",
    requireAdminAccess,
    async (req, res) => {
        const { userId, decision } = req.params;

        if (!["accept", "reject"].includes(decision)) {
            return res.status(400).send("Invalid decision.");
        }

        try {
            const status = decision === "accept"
                ? "accepted"
                : "rejected";

            const result = await pool.query(
                `UPDATE media_applications
                 SET
                    status = $2,
                    reviewed_at = NOW(),
                    reviewed_by = $3,
                    updated_at = NOW()
                 WHERE discord_id = $1
                   AND status = 'pending'
                 RETURNING id`,
                [userId, status, req.session.user.id]
            );

            if (!result.rows.length) {
                const existing = await getMediaApplication(userId);

                if (!existing) {
                    return res.status(404).send(
                        "Media application not found."
                    );
                }

                return res.status(400).send(
                    "This media application has already been reviewed."
                );
            }

            // Send Media Application Decision DM
            try {
                await sendMediaApplicationDecisionDM(userId, status);
            } catch (dmError) {
                console.error(
                    `Could not send media application ${status} DM to ${userId}:`,
                    dmError.message
                );
            }

            return res.redirect("/admin");

        } catch (error) {
            console.error("Media application review error:", error);

            return res.status(500).send(
                "Could not update media application."
            );
        }
    }
);

// -------------------- STAFF APPLICATION FORM --------------------

app.get("/apply", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;

        if (await isUserBlacklisted(userId)) {
            return res.redirect("/dashboard?error=blacklisted");
        }

        if (!isApplicationsOpen) {
            return res.redirect("/dashboard?error=closed");
        }

        const cooldown = await getApplicationCooldown("staff", userId);

        if (cooldown.active) {
            return res.redirect(
                `/dashboard?error=${getCooldownError("staff")}`
            );
        }

        const application = await getStaffApplication(userId);

        if (application?.status === "pending") {
            return res.redirect("/dashboard");
        }

        res.render("apply");
    } catch (error) {
        console.error("Staff application page error:", error);

        res.status(500).send(
            "Could not load the application form."
        );
    }
});

// -------------------- SUBMIT STAFF APPLICATION --------------------

app.post("/submit-application", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;

        if (await isUserBlacklisted(userId)) {
            return res.redirect("/dashboard?error=blacklisted");
        }

        if (!isApplicationsOpen) {
            return res.redirect("/dashboard?error=closed");
        }

        const cooldown = await getApplicationCooldown("staff", userId);

        if (cooldown.active) {
            return res.redirect(
                `/dashboard?error=${getCooldownError("staff")}`
            );
        }

        const existing = await getStaffApplication(userId);

        if (existing?.status === "pending") {
            return res.redirect("/dashboard");
        }

        const answers = {};

        for (let i = 1; i <= 18; i++) {
            const key = `q${i}`;
            const answer = String(req.body[key] || "").trim();

            if (!answer) {
                return res.status(400).send(
                    `Missing answer: ${key}`
                );
            }

            answers[key] = answer.slice(0, 1000);
        }

        const applicationDate = new Date().toLocaleDateString("en-US");

        const result = await pool.query(
            `INSERT INTO staff_applications
                (discord_id, status, application_date, answers)
             VALUES ($1, 'pending', $2, $3::jsonb)
             ON CONFLICT (discord_id)
             DO UPDATE SET
                status = 'pending',
                application_date = EXCLUDED.application_date,
                answers = EXCLUDED.answers,
                reviewed_at = NULL,
                reviewed_by = NULL,
                dm_sent = NULL,
                dm_sent_at = NULL,
                dm_error = NULL,
                updated_at = NOW()
             WHERE
                staff_applications.status IN ('accepted', 'rejected')
                AND (
                    staff_applications.reviewed_at IS NULL
                    OR staff_applications.reviewed_at
                        <= NOW() - INTERVAL '30 days'
                )
             RETURNING id`,
            [
                userId,
                applicationDate,
                JSON.stringify(answers),
            ]
        );

        if (!result.rows.length) {
            return res.redirect("/dashboard");
        }

        console.log(
            `New website application saved for user ${userId}`
        );

        return res.redirect("/dashboard");
    } catch (error) {
        console.error("Application storage error:", error);

        return res.status(500).send(
            "Could not save your application. Please try again."
        );
    }
});

// -------------------- MEDIA APPLICATION FORM --------------------

app.get("/media-apply", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;

        if (await isUserBlacklisted(userId)) {
            return res.redirect("/dashboard?error=blacklisted");
        }

        if (!isMediaApplicationsOpen) {
            return res.redirect("/dashboard?error=media-closed");
        }

        const cooldown = await getApplicationCooldown("media", userId);

        if (cooldown.active) {
            return res.redirect(
                `/dashboard?error=${getCooldownError("media")}`
            );
        }

        const application = await getMediaApplication(userId);

        if (application?.status === "pending") {
            return res.redirect("/dashboard");
        }

        res.render("media-apply", {
            user: req.session.user,
        });
    } catch (error) {
        console.error("Media application page error:", error);

        res.status(500).send(
            "Could not load the media application form."
        );
    }
});

// -------------------- SUBMIT MEDIA APPLICATION --------------------

app.post("/submit-media-application", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;

        if (await isUserBlacklisted(userId)) {
            return res.redirect("/dashboard?error=blacklisted");
        }

        if (!isMediaApplicationsOpen) {
            return res.redirect("/dashboard?error=media-closed");
        }

        const cooldown = await getApplicationCooldown("media", userId);

        if (cooldown.active) {
            return res.redirect(
                `/dashboard?error=${getCooldownError("media")}`
            );
        }

        const existing = await getMediaApplication(userId);

        if (existing?.status === "pending") {
            return res.redirect("/dashboard");
        }

        const fields = [
            ["creatorName", "Creator / channel name", 100],
            ["discordUsername", "Discord username", 100],
            ["age", "Age", 3],
            ["platforms", "Platforms", 200],
            ["channelLink", "Channel link", 500],
            ["audience", "Audience size", 100],
            ["contentType", "Content type", 300],
            ["portfolio", "Recent content / portfolio", 1000],
            ["frequency", "Posting frequency", 300],
            ["whyRavix", "Why RavixMC", 1000],
            ["extra", "Additional information", 1000],
        ];

        const answers = {};

        for (const [key, label, max] of fields) {
            const value = String(req.body[key] || "").trim();

            if (key !== "extra" && !value) {
                return res.status(400).send(
                    `Missing required field: ${label}`
                );
            }

            answers[key] = value.slice(0, max);
        }

        if (!/^\d{1,3}$/.test(answers.age)) {
            return res.status(400).send(
                "Please enter a valid age."
            );
        }

        if (!/^https?:\/\//i.test(answers.channelLink)) {
            return res.status(400).send(
                "Channel link must start with http:// or https://."
            );
        }

        const applicationDate = new Date().toLocaleDateString("en-US");

        const result = await pool.query(
            `INSERT INTO media_applications
                (discord_id, username, status, application_date, answers)
             VALUES ($1, $2, 'pending', $3, $4::jsonb)
             ON CONFLICT (discord_id)
             DO UPDATE SET
                username = EXCLUDED.username,
                status = 'pending',
                application_date = EXCLUDED.application_date,
                answers = EXCLUDED.answers,
                reviewed_at = NULL,
                reviewed_by = NULL,
                updated_at = NOW()
             WHERE
                media_applications.status IN ('accepted', 'rejected')
                AND (
                    media_applications.reviewed_at IS NULL
                    OR media_applications.reviewed_at
                        <= NOW() - INTERVAL '30 days'
                )
             RETURNING id`,
            [
                userId,
                req.session.user.username,
                applicationDate,
                JSON.stringify(answers),
            ]
        );

        if (!result.rows.length) {
            return res.redirect("/dashboard");
        }

        console.log(
            `New media application saved for user ${userId}`
        );

        return res.redirect("/dashboard");
    } catch (error) {
        console.error("Media application storage error:", error);

        return res.status(500).send(
            "Could not save your media application. Please try again."
        );
    }
});

// -------------------- LOGOUT --------------------

app.get("/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            console.error("Logout session error:", error);

            return res.status(500).send(
                "Could not log out."
            );
        }

        res.clearCookie("connect.sid");
        res.redirect("/");
    });
});

// -------------------- START SERVER --------------------

async function startServer() {
    try {
        await initializeDatabase();
        await loadApplicationSettings();

        if (!fs.existsSync(COMMANDS_PATH)) {
            fs.mkdirSync(COMMANDS_PATH, { recursive: true });
            console.log("[COMMANDS] Commands directory created.");
        }

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`Website listening on port ${PORT}`);
        });

        if (!BOT_TOKEN) {
            console.error(
                "BOT_TOKEN is missing. Discord bot will not start."
            );
            return;
        }

        await client.login(BOT_TOKEN);
    } catch (error) {
        console.error("Application startup failed:", error);
        process.exit(1);
    }
}

startServer();
