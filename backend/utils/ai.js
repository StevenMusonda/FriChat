/**
 * Optional AI features: catch-up summaries and per-message translation.
 *
 * Every request starts from one user's own action, and every path goes through checkAccess, on the
 * server: an API key is configured, the user is a member, agreed once to sending messages to the
 * provider, and hasn't turned the feature off, for their account or for this chat. Only plain text
 * goes out: never media, messages deleted for everyone or for this user, or disappearing messages
 * (their push notifications carry no text either). See aiPrompts.js for how the text is handled, and
 * aiUsage.js for the caps.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const {
    DEFAULT_LANGUAGE,
    SUMMARY_MIN_UNREAD,
    SUMMARY_MAX_MESSAGES,
    SUMMARY_MAX_OUTPUT_TOKENS,
    TRANSLATION_MAX_OUTPUT_TOKENS,
    CATCHUP_WINDOW_SECONDS,
    CHARS_PER_TOKEN_ESTIMATE,
    TRANSLATION_LANGUAGES,
    aiEnabled,
    aiModel,
    aiLimits
} = require('../config/ai');
const { secondsUntilSql } = require('./timeSql');
const { toBool } = require('./messageQueries');
const { decodeEntities } = require('./push');
const prompts = require('./aiPrompts');
const client = require('./aiClient');
const usage = require('./aiUsage');

const DISABLED_ERROR = { status: 503, code: 'AI_DISABLED', message: 'AI features aren\'t available on this server.' };
const CONSENT_ERROR = { status: 403, code: 'AI_CONSENT_REQUIRED', message: 'Please agree to sending messages to the AI provider first.' };
const TURNED_OFF_ERROR = { status: 403, code: 'AI_TURNED_OFF', message: 'AI features are turned off in your Privacy settings.' };
const CHAT_OFF_ERROR = { status: 403, code: 'AI_CHAT_TURNED_OFF', message: 'You turned AI features off for this chat.' };
const NOT_MEMBER_ERROR = { status: 403, code: 'NOT_A_MEMBER', message: 'Access denied to this chat' };
const NOT_ENOUGH_UNREAD_ERROR = { status: 400, code: 'AI_NOT_ENOUGH_UNREAD', message: `Summaries are for chats with more than ${SUMMARY_MIN_UNREAD} unread messages.` };
const NOTHING_TO_SUMMARIZE_ERROR = { status: 400, code: 'AI_NOTHING_TO_SUMMARIZE', message: 'None of the unread messages can be summarized: only ordinary text messages are sent.' };
const NOT_TRANSLATABLE_ERROR = { status: 400, code: 'AI_NOT_TRANSLATABLE', message: 'This message can\'t be translated.' };
const NOT_FOUND_ERROR = { status: 404, code: 'NOT_FOUND', message: 'Message not found or access denied' };
const DECLINED_ERROR = { status: 422, code: 'AI_DECLINED', message: 'The AI service declined this request.' };
const NO_ANSWER_ERROR = { status: 502, code: 'AI_NO_ANSWER', message: 'The AI service didn\'t return a usable answer. Please try again.' };

// ===== Preferences =====

async function getPreferences(userId) {
    const row = await queryOne(
        'SELECT ai_features, ai_consent_at, translation_language FROM privacy_settings WHERE user_id = ?',
        [userId]
    );
    const language = row && TRANSLATION_LANGUAGES[row.translation_language] ? row.translation_language : DEFAULT_LANGUAGE;
    return {
        // On unless turned off; nothing is sent before consent anyway
        enabled: !row || row.ai_features === null || row.ai_features === undefined || toBool(row.ai_features),
        consented: !!(row && row.ai_consent_at),
        language
    };
}

/**
 * Write one privacy_settings column, creating the row with its defaults if the user has none yet.
 * `column` is a fixed name from this file.
 */
async function upsertPreference(userId, column, value) {
    if (dbType === 'postgresql') {
        await executeQuery(
            `INSERT INTO privacy_settings (user_id, ${column}) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = CURRENT_TIMESTAMP`,
            [userId, value]
        );
    } else {
        await executeQuery(
            `INSERT INTO privacy_settings (user_id, ${column}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`,
            [userId, value]
        );
    }
}

async function saveLanguage(userId, language) {
    await upsertPreference(userId, 'translation_language', language);
}

/**
 * The one-time consent. A date from the app's clock is fine here: it's a record, not compared in SQL.
 */
async function recordConsent(userId, language) {
    await upsertPreference(userId, 'ai_consent_at', new Date());
    if (language) await saveLanguage(userId, language);
}

async function setChatAiEnabled(chatId, userId, enabled) {
    await executeQuery('UPDATE group_members SET ai_disabled = ? WHERE chat_id = ? AND user_id = ?', [!enabled, chatId, userId]);
}

/**
 * What the app needs to decide which AI controls to show. Without an API key, only that.
 */
async function getStatus(userId) {
    if (!aiEnabled()) return { available: false };

    const preferences = await getPreferences(userId);
    const disabled = await executeQuery(
        'SELECT chat_id FROM group_members WHERE user_id = ? AND ai_disabled = TRUE',
        [userId]
    );
    return {
        available: true,
        ...preferences,
        disabledChats: disabled.map(row => Number(row.chat_id)),
        summaryMinUnread: SUMMARY_MIN_UNREAD,
        dailyLimit: aiLimits().userDailyRequests,
        languages: Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => ({ code, name }))
    };
}

// ===== Gate =====

/**
 * Everything that must hold before anything of this chat may leave the server
 * @returns {Promise<{ error } | { member, preferences }>}
 */
async function checkAccess(userId, chatId) {
    if (!aiEnabled()) return { error: DISABLED_ERROR };

    const member = await queryOne(`
        SELECT last_read_message_id, ai_disabled, catchup_from_message_id,
            ${secondsUntilSql('catchup_at')} AS catchup_in
        FROM group_members
        WHERE chat_id = ? AND user_id = ?
    `, [chatId, userId]);
    if (!member) return { error: NOT_MEMBER_ERROR };

    const preferences = await getPreferences(userId);
    if (!preferences.enabled) return { error: TURNED_OFF_ERROR };
    if (toBool(member.ai_disabled)) return { error: CHAT_OFF_ERROR };
    if (!preferences.consented) return { error: CONSENT_ERROR };
    return { member, preferences };
}

/**
 * Check the caps, make the call, keep the books. The caller decides what to do with the text.
 * @returns {Promise<{ error } | { text }>}
 */
async function meteredCall(userId, feature, { system, text, maxTokens }) {
    const estimate = Math.ceil((system.length + text.length) / CHARS_PER_TOKEN_ESTIMATE) + maxTokens;
    const { error, reservation } = await usage.reserve(userId, estimate);
    if (error) return { error };

    const model = aiModel();
    let reply;
    try {
        reply = await client.complete({ system, text, maxTokens });
    } catch (failure) {
        await usage.release(reservation);
        await usage.logUsage({ userId, feature, model, outcome: 'error' });
        if (failure instanceof client.AiRequestError) return { error: failure.apiError };
        throw failure;
    }

    await usage.settle(reservation, reply.inputTokens + reply.outputTokens);
    const refused = reply.stopReason === 'refusal';
    await usage.logUsage({
        userId,
        feature,
        model,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        outcome: refused ? 'refused' : 'ok'
    });

    if (refused) return { error: DECLINED_ERROR };
    // Cut off: half a summary or translation is worse than none
    if (reply.stopReason !== 'end_turn') return { error: NO_ANSWER_ERROR };
    return { text: reply.text };
}

// ===== Summaries =====

/**
 * Where "unread" starts: the read position, or where it was when the user opened the chat a moment ago
 */
function unreadStart(member) {
    const read = Number(member.last_read_message_id) || 0;
    const from = member.catchup_from_message_id;
    const inSeconds = member.catchup_in;
    if (from === null || from === undefined || inSeconds === null || inSeconds === undefined) return read;
    if (Number(inSeconds) < -CATCHUP_WINDOW_SECONDS) return read;
    return Math.min(read, Number(from));
}

/**
 * Same count as the sidebar's badge, from a given position
 */
async function countUnread(chatId, userId, afterMessageId) {
    const row = await queryOne(`
        SELECT COUNT(*) AS count
        FROM messages m
        WHERE m.chat_id = ?
        AND m.id > ?
        AND m.sender_id <> ?
        AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
    `, [chatId, afterMessageId, userId]);
    return row ? parseInt(row.count) || 0 : 0;
}

/**
 * The only query that picks messages for a summary, newest first. Text messages from other people
 * after the read position; nothing deleted, disappearing, or from someone this user blocked.
 */
async function loadUnreadText(chatId, userId, afterMessageId, limit) {
    return executeQuery(`
        SELECT m.id, m.content, m.created_at, m.bot_name, u.username, u.full_name
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
        WHERE m.chat_id = ?
        AND m.id > ?
        AND m.sender_id <> ?
        AND m.message_type = 'text'
        AND m.file_id IS NULL
        AND m.content IS NOT NULL
        AND (m.deleted_for_everyone IS NULL OR m.deleted_for_everyone = FALSE)
        AND dm.id IS NULL
        AND m.expires_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = ? AND ub.blocked_id = m.sender_id)
        ORDER BY m.id DESC
        LIMIT ${parseInt(limit)}
    `, [userId, chatId, afterMessageId, userId, userId]);
}

function promptMessage(row) {
    return {
        sender: row.bot_name || decodeEntities(String(row.full_name || row.username)),
        time: `${new Date(row.created_at).toISOString().slice(0, 16)}Z`,
        text: row.content
    };
}

/**
 * Summary of a chat's unread messages, for this user only: nothing is stored or broadcast
 * @returns {Promise<{ error } | { bullets, summarizedMessages, unreadMessages }>}
 */
async function summarizeUnread(userId, chatId) {
    const { error, member } = await checkAccess(userId, chatId);
    if (error) return { error };

    const start = unreadStart(member);
    const unreadMessages = await countUnread(chatId, userId, start);
    if (unreadMessages <= SUMMARY_MIN_UNREAD) return { error: NOT_ENOUGH_UNREAD_ERROR };

    const rows = await loadUnreadText(chatId, userId, start, SUMMARY_MAX_MESSAGES);
    if (rows.length === 0) return { error: NOTHING_TO_SUMMARIZE_ERROR };

    const prompt = prompts.buildSummaryPrompt(rows.map(promptMessage));
    const result = await meteredCall(userId, 'summary', {
        system: prompts.SUMMARY_SYSTEM_PROMPT,
        text: prompt.text,
        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS
    });
    if (result.error) return { error: result.error };

    const bullets = prompts.parseBullets(result.text);
    if (bullets.length === 0) return { error: NO_ANSWER_ERROR };

    // This catch-up is done; opening the chat later doesn't offer the same messages again
    await executeQuery(
        'UPDATE group_members SET catchup_from_message_id = NULL, catchup_at = NULL WHERE chat_id = ? AND user_id = ?',
        [chatId, userId]
    );

    return { bullets, summarizedMessages: prompt.included, unreadMessages };
}

// ===== Translation =====

async function loadTranslatable(userId, messageId) {
    return queryOne(`
        SELECT m.id, m.chat_id, m.message_type, m.content, m.file_id, m.deleted_for_everyone, m.expires_at,
            CASE WHEN dm.id IS NULL THEN 0 ELSE 1 END AS deleted_for_me
        FROM messages m
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
        LEFT JOIN deleted_messages dm ON dm.message_id = m.id AND dm.user_id = ?
        WHERE m.id = ?
    `, [userId, userId, messageId]);
}

function isTranslatable(message) {
    return message.message_type === 'text'
        && !message.file_id
        && !!message.content
        && !toBool(message.deleted_for_everyone)
        && !toBool(message.deleted_for_me)
        && !message.expires_at;
}

async function saveTranslation(messageId, language, text) {
    const insert = 'INSERT INTO message_translations (message_id, language, translated_text) VALUES (?, ?, ?)';
    await executeQuery(dbType === 'postgresql'
        ? `${insert} ON CONFLICT (message_id, language) DO UPDATE SET translated_text = EXCLUDED.translated_text`
        : `${insert} ON DUPLICATE KEY UPDATE translated_text = VALUES(translated_text)`, [messageId, language, text]);
}

/**
 * Translate a message into the user's language. Each message and language goes out once; after that
 * every member reads the cached copy, which uses none of their allowance.
 * @returns {Promise<{ error } | { messageId, language, languageName, text, cached }>}
 */
async function translateMessage(userId, messageId) {
    if (!aiEnabled()) return { error: DISABLED_ERROR };

    // Part of the lookup: a non-member gets the same answer as for a message that doesn't exist
    const message = await loadTranslatable(userId, messageId);
    if (!message) return { error: NOT_FOUND_ERROR };

    const { error, preferences } = await checkAccess(userId, message.chat_id);
    if (error) return { error };
    if (!isTranslatable(message)) return { error: NOT_TRANSLATABLE_ERROR };

    const language = preferences.language;
    const languageName = TRANSLATION_LANGUAGES[language];
    const answer = (text, cached) => ({ messageId: Number(message.id), language, languageName, text, cached });

    const cached = await queryOne(
        'SELECT translated_text FROM message_translations WHERE message_id = ? AND language = ?',
        [message.id, language]
    );
    if (cached) return answer(cached.translated_text, true);

    const prompt = prompts.buildTranslationPrompt(message.content, languageName);
    const result = await meteredCall(userId, 'translation', {
        system: prompt.system,
        text: prompt.text,
        maxTokens: TRANSLATION_MAX_OUTPUT_TOKENS
    });
    if (result.error) return { error: result.error };

    const text = prompts.cleanTranslation(result.text);
    if (!text) return { error: NO_ANSWER_ERROR };

    // The original may have been edited or deleted during the call: don't cache a copy of the old text
    const current = await loadTranslatable(userId, messageId);
    if (current && isTranslatable(current) && current.content === message.content) {
        await saveTranslation(message.id, language, text);
    }
    return answer(text, false);
}

module.exports = {
    DISABLED_ERROR,
    CONSENT_ERROR,
    getPreferences,
    saveLanguage,
    recordConsent,
    setChatAiEnabled,
    getStatus,
    checkAccess,
    unreadStart,
    summarizeUnread,
    translateMessage
};
