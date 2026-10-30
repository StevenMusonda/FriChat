/**
 * Voice notes: "played" state. When someone other than the sender plays a voice note, a row goes into
 * voice_note_plays and the sender's tabs get voice_note_played (the mic icon turns blue).
 *
 * Played works like a read receipt: the play of someone with read receipts off is kept (so their own
 * "not played yet" dot goes away) but never shown to the sender; someone with read receipts off doesn't
 * see other people's plays either; nothing is recorded across a block.
 */

const { executeQuery, queryOne, dbType } = require('../config/database');
const { toBool } = require('./messageQueries');
const { readReceiptsEnabled } = require('./privacy');
const { checkBlockBetween } = require('./blocks');

/**
 * Record that userId played a voice note.
 * @returns {Promise<{ error: string } | { recorded: boolean }>}
 */
async function markVoicePlayed(io, messageId, userId) {
    messageId = Number(messageId);
    if (!Number.isInteger(messageId) || messageId < 1) return { error: 'Invalid message ID' };

    // Membership is part of the lookup: to a non-member the message doesn't exist
    const message = await queryOne(`
        SELECT m.id, m.chat_id, m.sender_id, m.message_type, m.deleted_for_everyone
        FROM messages m
        JOIN group_members gm ON gm.chat_id = m.chat_id AND gm.user_id = ?
        WHERE m.id = ?
    `, [userId, messageId]);

    if (!message || toBool(message.deleted_for_everyone)) return { error: 'Message not found' };
    if (message.message_type !== 'voice') return { error: 'This is not a voice note' };

    // Playing your own note isn't news to anyone
    const senderId = Number(message.sender_id);
    if (senderId === Number(userId)) return { recorded: false };

    if (await checkBlockBetween(userId, senderId)) return { recorded: false };

    let inserted;
    if (dbType === 'postgresql') {
        const rows = await executeQuery(
            'INSERT INTO voice_note_plays (message_id, user_id) VALUES (?, ?) ON CONFLICT (message_id, user_id) DO NOTHING RETURNING message_id',
            [messageId, userId]
        );
        inserted = rows.length > 0;
    } else {
        // INSERT IGNORE, not ON DUPLICATE KEY UPDATE: mysql2 connects with FOUND_ROWS, under which a
        // no-op update still reports 1 affected row and a repeat play would look like a first one
        const result = await executeQuery(
            'INSERT IGNORE INTO voice_note_plays (message_id, user_id) VALUES (?, ?)',
            [messageId, userId]
        );
        inserted = !!result && result.affectedRows === 1;
    }

    // Only the first play is news, and only when both of them share read receipts
    if (inserted && io && await readReceiptsEnabled(userId) && await readReceiptsEnabled(senderId)) {
        io.to(`user_${senderId}`).emit('voice_note_played', {
            messageId,
            chatId: Number(message.chat_id),
            userId: Number(userId)
        });
    }
    return { recorded: inserted };
}

/**
 * Add played state to a page of messages for this viewer:
 *   voice_played    - on the viewer's own voice notes: someone else played it (false with receipts off)
 *   played_by_me    - on other people's voice notes: the viewer played it already
 */
async function attachVoicePlays(messages, viewerId) {
    const voice = (messages || []).filter(m => m && m.message_type === 'voice');
    if (voice.length === 0) return messages;

    const ids = voice.map(m => m.id);
    // receipts_off: that listener's play is theirs to know, not the sender's
    const rows = await executeQuery(`
        SELECT vp.message_id, vp.user_id, CASE WHEN ps.read_receipts = FALSE THEN 1 ELSE 0 END AS receipts_off
        FROM voice_note_plays vp
        LEFT JOIN privacy_settings ps ON ps.user_id = vp.user_id
        WHERE vp.message_id IN (${ids.map(() => '?').join(', ')})
    `, ids);
    const receiptsOn = await readReceiptsEnabled(viewerId);

    const playedByOthers = new Set();
    const playedByMe = new Set();
    for (const row of rows) {
        if (Number(row.user_id) === Number(viewerId)) playedByMe.add(Number(row.message_id));
        else if (!parseInt(row.receipts_off)) playedByOthers.add(Number(row.message_id));
    }

    for (const message of voice) {
        if (Number(message.sender_id) === Number(viewerId)) {
            message.voice_played = receiptsOn && playedByOthers.has(Number(message.id));
        } else {
            message.played_by_me = playedByMe.has(Number(message.id));
        }
    }
    return messages;
}

module.exports = { markVoicePlayed, attachVoicePlays };
