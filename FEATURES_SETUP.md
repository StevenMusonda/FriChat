# New Features Setup Guide

## Features Added

1. **Delete Messages**
   - Delete for everyone (within 1 minute)
   - Delete for yourself (after 1 minute)
   
2. **Delete Chats**
   - Remove chats from your chat list
   - Soft delete - chat remains for other users

3. **Pin Messages**
   - Pin important messages with durations: 24h, 7 days, or 30 days
   - Auto-unpin when duration expires
   - View all pinned messages at top of chat

## Installation Steps

### 1. Update Database Schema

Run the schema updates to add new tables:

**Option A: Using phpMyAdmin (XAMPP)**
1. Open phpMyAdmin: `http://localhost/phpmyadmin`
2. Select the `frichat` database
3. Click on "SQL" tab
4. Copy and paste the contents of `database/schema_updates.sql`
5. Click "Go" to execute

**Option B: Using MySQL Command Line**
```bash
mysql -u root -p frichat < database/schema_updates.sql
```

The script adds:
- `deleted_messages` table - tracks user-specific message deletions
- `pinned_messages` table - stores pinned messages with expiration
- `deleted_chats` table - tracks chats deleted by users
- Additional columns to `messages` table for deletion tracking

### 2. Restart Backend Server

1. Stop the current backend server (Ctrl+C in terminal)
2. Start it again:
```bash
cd backend
npm start
```

You should see a new line:
```
✓ Message pin scheduler started (runs every 5 minutes)
```

### 3. Refresh Browser

Hard refresh your browser (Ctrl+Shift+R or Cmd+Shift+R) to load new JavaScript files.

## How to Use

### Delete Messages

1. **Hover over any message** you sent
2. Click the **3-dot menu** icon that appears
3. Select **"Delete for everyone"** (if within 1 minute) or **"Delete for me"**
4. Confirm deletion

- **Delete for everyone**: Message shows "🚫 This message was deleted" for all users
- **Delete for me**: Message disappears from your view only

### Pin Messages

1. **Hover over any message** (yours or others)
2. Click the **3-dot menu** icon
3. Select **"Pin message"**
4. Choose duration:
   - 24 hours
   - 7 days  
   - 30 days
5. Message appears at top of chat with countdown timer

**Unpinning:**
- Click **"Unpin"** button on pinned message
- Or wait for auto-unpin when duration expires

### Delete Chats

1. **Hover over a chat** in the sidebar
2. Click the **trash icon** that appears on the right
3. Confirm deletion

The chat is removed from your list but remains for other participants.

## API Endpoints Added

### Messages
- `DELETE /api/messages/:messageId` - Delete message
- `POST /api/messages/:messageId/pin` - Pin message with duration
- `DELETE /api/messages/:messageId/unpin` - Unpin message
- `GET /api/messages/chat/:chatId/pinned` - Get pinned messages

### Chats
- `DELETE /api/chats/:chatId` - Delete chat from user's list

## Technical Details

### Message Deletion Logic

```javascript
// Within 60 seconds: Delete for everyone
if (timeSinceCreation <= 60) {
    // Mark as deleted_for_everyone = TRUE
    // All users see "This message was deleted"
}

// After 60 seconds: Delete for self only
else {
    // Add entry to deleted_messages table
    // Only current user won't see the message
}
```

### Pin Expiration

The backend runs a scheduler every 5 minutes that automatically removes expired pins:

```javascript
setInterval(() => {
    DELETE FROM pinned_messages 
    WHERE pinned_until < CURRENT_TIMESTAMP
}, 5 * 60 * 1000);
```

### Chat Deletion

Soft delete approach:
- Entry added to `deleted_chats` table
- Chat excluded from getUserChats query for that user
- Other users still see the chat
- User can restart conversation by creating new chat

## Troubleshooting

### Issue: "Table doesn't exist" error
**Solution:** Run the schema_updates.sql file in your database

### Issue: Message actions not appearing
**Solution:** 
- Hard refresh browser (Ctrl+Shift+R)
- Check console for JavaScript errors
- Verify messageActions.js is loaded

### Issue: Scheduler not running
**Solution:**
- Restart backend server
- Check for "Message pin scheduler started" message
- Look for errors in backend console

### Issue: Can't delete messages
**Solution:**
- Check if user is the message sender
- Verify authentication token is valid
- Check backend console for errors

## Files Modified/Created

### Backend
- `backend/controllers/messageController.js` - Added delete/pin endpoints
- `backend/controllers/chatController.js` - Added delete chat endpoint
- `backend/routes/messages.js` - Added new routes
- `backend/routes/chats.js` - Added delete route
- `backend/utils/scheduler.js` - Created scheduler for auto-unpin
- `backend/server.js` - Initialized scheduler

### Frontend
- `frontend/js/messageActions.js` - **NEW** - Message action functionality
- `frontend/js/messages.js` - Updated message rendering
- `frontend/js/chat.js` - Added delete chat button, load pinned messages
- `frontend/css/style.css` - Added styles for new features
- `frontend/chat.html` - Added messageActions.js script

### Database
- `database/schema_updates.sql` - **NEW** - Schema changes

## Testing Checklist

- [ ] Can delete own message within 1 minute (delete for everyone)
- [ ] Can delete own message after 1 minute (delete for self)
- [ ] Deleted message shows placeholder for all users (delete for everyone)
- [ ] Deleted message disappears for current user only (delete for self)
- [ ] Can pin any message with 24h duration
- [ ] Can pin any message with 7d duration
- [ ] Can pin any message with 30d duration
- [ ] Pinned message appears at top of chat
- [ ] Can unpin message manually
- [ ] Pin expires automatically (wait 5-10 min after scheduled time)
- [ ] Can delete chat from sidebar
- [ ] Deleted chat removed from current user's list
- [ ] Deleted chat still visible to other users
- [ ] Can hover over message to see action menu
- [ ] Can hover over chat to see delete button

---

## Phase 2: Installable app, push notifications and do-not-disturb

FriChat can be installed as an app and sends push notifications when the tab is closed or in the background.

- **Install**: Chrome/Edge show an install icon in the address bar, and the bell (🔔) settings panel has an **Install app** button when the browser offers it. On iPhone/iPad the panel explains *Share → Add to Home Screen*.
- **Offline**: a service worker (`frontend/sw.js`) caches the app shell (HTML, CSS, JS, icons) and shows `offline.html` for pages it doesn't have. API responses are never cached; offline API calls get a JSON `503`.
- **Push notifications**: turn on **Enable notifications** in the bell panel. The browser asks for permission only after that click. A notification shows the sender, a short preview (photo/video/file messages show generic text), and opens or focuses the chat when clicked.
- **Who gets a push**: every chat member except the sender, unless they have muted the chat, have deleted it, have do-not-disturb on, or have a visible FriChat tab on that chat.
- **Unread badge**: the unread total (muted chats excluded) appears on the installed app icon where the Badging API is supported, and in the tab title, e.g. `(3) FriChat - Chat`.
- **Do not disturb**: the moon button in the sidebar header pauses all pushes. The bell panel also has daily **quiet hours** (start/end time in your timezone; a window like 22:00–07:00 crosses midnight).
- **Logout** removes this browser's subscription from the server and unsubscribes it in the browser.

### Setup

1. Install the new package:
   ```bash
   cd backend
   npm install
   ```
2. Run the migration on an existing database:
   ```bash
   # MySQL
   mysql -u root -p frichat < database/add_push_notifications.sql
   # PostgreSQL
   psql -U postgres -d frichat -f database/add_push_notifications_postgresql.sql
   ```
   Fresh installs get the tables from `schema.sql` / `schema_postgresql.sql`. The migration is safe to run more than once.
3. Generate VAPID keys **once** and paste the output into `backend/.env`:
   ```bash
   cd backend
   npm run vapid:generate
   ```
   | Variable | Purpose |
   |---|---|
   | `VAPID_PUBLIC_KEY` | Sent to browsers so they can subscribe |
   | `VAPID_PRIVATE_KEY` | Signs pushes. Keep it secret. |
   | `VAPID_SUBJECT` | Contact for push services: a `mailto:` address or `https://` URL |

   Without keys, push is off and everything else keeps working. Changing the keys invalidates every existing subscription; users then have to turn notifications on again.
4. Restart the backend. Serve the frontend over **HTTPS** (or `http://localhost`): service workers and push don't work on plain HTTP.

When deploying frontend changes, bump `CACHE_VERSION` in `frontend/sw.js` so installed apps fetch the new files.

### New API endpoints

All require `Authorization: Bearer <token>` and are rate limited to 30 requests per minute per IP.

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/notifications/push-config` | – | `{ enabled, publicKey }` |
| POST | `/api/notifications/subscriptions` | `{ endpoint, keys: { p256dh, auth } }` | Upserts by endpoint. HTTPS endpoints only, no IPs/localhost. `503` if VAPID isn't configured. |
| DELETE | `/api/notifications/subscriptions` | `{ endpoint }` | Removes only the caller's own row |
| GET | `/api/notifications/settings` | – | `{ dndEnabled, quietHoursEnabled, quietStart, quietEnd, timezone, dndActive }` |
| PUT | `/api/notifications/settings` | Any of `dndEnabled`, `quietHoursEnabled` (booleans), `quietStart`, `quietEnd` (`HH:MM`), `timezone` (IANA name) | Only the fields sent change |

### New Socket.IO events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `presence` | client → server | `{ visible: boolean }` | Sent on connect and on every tab visibility change. It only describes the sending socket, so no chat membership is involved. A socket counts as visible until it says otherwise. |
| `notification_settings_updated` | server → the user's own tabs | same shape as `GET /settings` | Keeps the moon button and settings panel in sync across tabs |

### Push payload (`frontend/sw.js` reads this)

`{ type: 'message', chatId, messageId, senderName, title, body, url: 'chat.html?chat=<id>', badge }`. For group chats the title is the group name and the body is `Sender: preview`. `badge` is the recipient's unread total.

### Manual test checklist

- [ ] Chrome: the address bar shows the install icon; installing opens FriChat in its own window with the chat-bubble icon
- [ ] The bell panel's **Install app** button opens the install dialog (Chrome/Edge). On iOS Safari the Add to Home Screen note appears instead.
- [ ] Turning on **Enable notifications** shows the permission prompt only after the click. Opening the page alone never prompts.
- [ ] User B enables notifications and closes the tab. User A sends a message, and B gets a notification with A's name and the text.
- [ ] A photo/file message shows "📷 Photo" / "📎 File", not the file name
- [ ] Clicking the notification with no FriChat window open opens the chat. With a window open, it focuses that window and switches to the chat.
- [ ] B has the chat open and visible: no push. B switches to another tab: a push arrives.
- [ ] B mutes the chat: no push. Unmute: pushes again.
- [ ] B turns on the moon (DND): no push, and the moon is highlighted in B's other tabs too
- [ ] Quiet hours covering the current time: no push. Move the window away from now: pushes again.
- [ ] The tab title shows `(N)` unread. The installed app icon shows a badge (Windows/macOS/ChromeOS/Android). Muted chats don't count.
- [ ] Logging out removes the row from `push_subscriptions`, and no more pushes arrive in that browser
- [ ] Offline (DevTools → Network → Offline): reloading still shows the app shell, and an uncached page shows the offline page
- [ ] The light/dark theme still toggles, and the browser's title-bar color follows it
- [ ] At a phone width (360px) all sidebar header buttons fit and the settings panel is usable

### Tests

`cd backend && npm test`. `test/push.test.js` covers quiet-hours math (timezones, overnight windows), previews, recipient filtering (mute, DND, quiet hours, visible/hidden tabs), deleting `404`/`410` subscriptions, settings upserts on both databases, input validation and the `presence` event.

### Known limitations

- iOS supports Web Push only for the installed Home Screen app (iOS 16.4+), and it doesn't support `beforeinstallprompt`.
- FriChat has no in-app sounds yet. DND suppresses pushes, and with them the system notification sound.
- Push sending runs in the web process (no queue), and presence lives in memory, so it's single-server only, like the rate limiter.
- Endpoint validation blocks `http://`, IP addresses and `localhost`, but a public hostname that resolves to a private IP would still pass. For stricter hosting, add an allowlist of push-service hosts.

---

## Phase 3: Reply, edit, forward and starred messages

All four actions live in the message's **⋯** menu (`frontend/js/messageActions.js`). They work the same in direct and group chats.

- **Reply**: shows a "Replying to …" bar above the composer (✕ or Esc cancels). The sent message shows a compact quote: the sender's name and a snippet, or 📷/🎥/📎 for media. Clicking the quote scrolls to the original and flashes it, loading older pages if needed. If the original was later deleted for everyone, the quote reads *Original message deleted* and its content is never sent to clients. File uploads sent while the reply bar is open reply too (first file only).
- **Edit**: offered only on your own text messages for **15 minutes** after sending (`EDIT_WINDOW_MINUTES` in `backend/config/messages.js`; the frontend mirrors it as `MESSAGE_EDIT_WINDOW_MINUTES` in `frontend/js/config.js` only to decide whether to show the menu item). The text is loaded into the composer; Enter saves and Esc cancels, giving back whatever you were typing before. Edited messages show an *edited* label, and quotes of them update live. Media, forwarded and deleted messages can't be edited.
- **Forward**: **Forward** sends one message. **Select** starts multi-select (tap messages, up to **5**), then **Forward** in the bar at the bottom. Pick up to 10 chats you're a member of (searchable). Copies show a *Forwarded* label, appear live in each chat, and reuse the original file. Nothing is re-uploaded.
- **Starred messages**: **Star**/**Unstar** is per user (a small ★ appears in the message footer). The ☆ button next to the chat search opens the *Starred messages* panel. Click an entry to open that chat at the message, or click ★ to unstar. Only chats you're still a member of are listed, and deleted messages drop out.

### Setup

No new packages or env variables. Run the migration on an existing database:

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_message_actions.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_message_actions_postgresql.sql
```

It adds `messages.reply_to_message_id` (FK, `ON DELETE SET NULL`), `messages.edited_at`, `messages.is_forwarded` and the `starred_messages` table. Fresh installs get these from `schema.sql` / `schema_postgresql.sql`. `frontend/sw.js` `CACHE_VERSION` is bumped to `frichat-shell-v2` so installed apps fetch the new files.

### New and changed API endpoints

All require `Authorization: Bearer <token>`. Every action checks server-side that the caller is a member of the message's chat (and of each target chat for forwards).

| Method | Endpoint | Body / query | Notes |
|---|---|---|---|
| POST | `/api/messages` | adds optional `replyToMessageId` | Must be a message in the same chat that isn't deleted for everyone, else `400` |
| POST | `/api/messages/upload` | adds optional multipart `replyToMessageId` | Same rule |
| PATCH | `/api/messages/:messageId` | `{ content }` (1–5000 chars) | Sender only (`403`). `400` for deleted, media or forwarded messages, or when the edit window has passed. Non-member: `404`. Broadcasts `message_edited`. |
| POST | `/api/messages/forward` | `{ messageIds: [1–5 ids], chatIds: [1–10 ids] }` | `404` if a source message isn't visible to you or a target chat isn't yours. `400` for deleted messages. Returns the new messages. |
| POST | `/api/messages/:messageId/star` | – | Idempotent. Non-member: `404`. Deleted: `400`. |
| DELETE | `/api/messages/:messageId/star` | – | Removes only your own star. `404` if it isn't starred. |
| GET | `/api/messages/starred` | `?limit=1–100&before=<starId>` | Newest star first, with `chat_display_name` and `pagination.nextCursor` |

Message objects (`GET /api/messages/chat/:id`, `new_message`) now also carry `edited_at`, `is_forwarded`, `reply_to` (`{ id, deleted, sender_id, sender_name, message_type, snippet, file_name }` or `null`), and, in history only, `is_starred` for the requesting user.

Rate limits (per IP): edit, star and the starred list share 60/min. Forward is 10/min, because one forward can create up to 50 messages.

Status codes: an expired edit window returns `400` and a forward to a chat you're not in returns `404`, both on purpose. (Since the cleanup below, `apiRequest` logs out only on `401`, so a `403` no longer ends the session either.)

### New and changed Socket.IO events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `send_message` | client → server | adds optional `replyToMessageId` | Validated like the REST field. Invalid targets emit `error` and nothing is stored. |
| `message_edited` | server → `chat_<id>` room | `{ messageId, chatId, content, editedAt }` | Only emitted by the edit endpoint after its checks |
| `message_star_updated` | server → the user's own tabs (`user_<id>`) | `{ messageId, chatId, starred }` | Other chat members never see your stars |

Forwarded copies arrive through the existing `new_message` event in each target chat.

### Manual test checklist

Use two browsers (A and B) in the same group, plus a direct chat between them.

- [ ] A: ⋯ → Reply on B's message. The bar shows "Replying to B" and the text. Send. Both A and B see the quote block live.
- [ ] Click the quote: it scrolls to the original and flashes it. The same works for an original several pages up.
- [ ] Reply to a photo: the quote shows "📷 Photo"
- [ ] B deletes (for everyone, within 1 minute) a message A replied to. After reload, A's reply shows *Original message deleted*.
- [ ] A: ⋯ → Edit on own text message. Change it and press Enter. B sees the new text and *edited* live. Esc during an edit restores what A was typing before.
- [ ] No Edit item on B's messages, on photos, on forwarded messages, or on messages older than 15 minutes
- [ ] A: ⋯ → Select, tap a second message (a sixth one shows an error), Forward, search, pick the direct chat and a group. Copies show *Forwarded* live for B in both chats, and the forwarded photo opens without a new upload.
- [ ] A: ⋯ → Star. A ★ appears for A, B sees nothing. The ☆ panel lists it with the chat name. Clicking it opens that chat at the message. Unstar from the panel removes it, and the change shows in A's other tab too.
- [ ] Toggle the dark theme: quote blocks, bars and dialogs stay readable
- [ ] At a phone width (360px) the reply bar sits right above the composer, the selection bar covers the composer, the ☆ button fits next to search, and the dialogs fit

### Tests

`cd backend && npm test`. `test/messageActions.test.js` runs on both fake drivers. It covers reply targets (same chat, deleted, other chat) over REST and the socket event, the reply quote shape, the edit rules and the SQL edit window, forward membership and file reuse, stars and the starred list, and validation for all new inputs.

### Known limitations

- ~~Deleting a message for everyone isn't broadcast live~~ and ~~socket `error` events aren't shown~~: both fixed in the cleanup below
- The sidebar preview shows a forwarded or edited last message as plain text, with no label
- Rate limits are per IP and in memory (same as Phase 2)

---

## Cleanup before Phase 4: one text rule, live deletes, socket errors, 401 logout

### One text rule for messages

Message text is stored **raw** on every write path: REST `POST /api/messages`, socket `send_message`, `PATCH /api/messages/:id` (edit) and `POST /api/messages/forward`. All of them go through one function, `cleanMessageText()` in `backend/utils/messageText.js`. Use it for any future path too, such as webhooks. It:

- strips control characters (C0 except tab/newline, DEL, C1) and turns `\r\n` / `\r` into `\n`
- trims, then rejects empty text (for text messages and edits) and anything over 5000 characters (`MAX_MESSAGE_LENGTH`)
- rejects anything that isn't a string
- **never HTML-escapes**

Group chat names from `POST /api/chats` are stored raw too. They get the same control-character strip, and the existing 100-character validator applies. `createChat` has no first-message option, so there was no message path there to change. Profile full names still use the old `sanitizeHtml` on write. They are out of scope here.

Escaping happens only at render time in the frontend: `escapeHtml()` in `frontend/js/chat.js` for template strings (it now also escapes `"` and `'`, so it's safe in attributes), or `textContent`. This covers message bodies, reply quotes and the reply/edit bar, the chat list preview, the starred panel, pinned messages, reactions (emoji and names were previously inserted unescaped) and file names. Push notification text is plain text by nature and no longer HTML-decodes message text or chat names. There is no message search feature yet. The sidebar search only filters chat names in memory.

#### Fixing rows stored escaped by the old REST path

Before this change, REST sends and group names were saved through `sanitizeHtml` (`&amp; &lt; &gt; &quot; &#x27; &#x2F;`). Since the frontend escapes too, those rows showed up as `&amp;` etc. Socket sends were always raw, so old data is mixed. The one-off script `backend/scripts/unescape-legacy-messages.js` fixes it on either engine:

```bash
cd backend
# 1. Back up the database first.
# 2. Dry run: prints every row it would change, writes nothing
node scripts/unescape-legacy-messages.js --before "<deploy time, e.g. 2026-10-26T18:00:00Z>" --chat-names
# 3. Apply, ONCE, and keep the output
node scripts/unescape-legacy-messages.js --before "<same time>" --chat-names --apply
```

The script only changes a row when all of these hold:
- it was created before `--before`
- it is a text message that was never edited (edits were always stored raw) or a group name
- it looks exactly like `sanitizeHtml` output: it has at least one of those six entities, no raw `< > " ' /`, and no other `&`

**Do not run it twice.** Un-escaping isn't idempotent. Text that someone originally typed as `&lt;b&gt;` was stored as `&amp;lt;b&amp;gt;`. The first run correctly restores `&lt;b&gt;`, but that result still looks escaped, so a second run would turn it into `<b>`. The same goes for a raw socket message from before the cutoff that consists only of entity text. Such text is rare, and it is always shown as text, never run as HTML. `--before` stops it from ever touching messages written after the deploy. Applying the script also bumps `messages.updated_at` / `chats.updated_at` on the rows it changes.

### Delete-for-everyone columns on MySQL

`messages.deleted_at`, `deleted_by` (FK to `users`, `ON DELETE SET NULL`) and `deleted_for_everyone` were only created by a PostgreSQL-only migration. They are now in both `schema.sql` and `schema_postgresql.sql`, with a migration for each engine:

```bash
# MySQL (safe to run more than once)
mysql -u root -p frichat < database/add_message_delete_columns.sql
# PostgreSQL (safe to run more than once; a no-op if add_message_columns_postgresql.sql was run)
psql -U postgres -d frichat -f database/add_message_delete_columns_postgresql.sql
```

### Live "delete for everyone"

`DELETE /api/messages/:messageId` now also checks that the sender is still a member of the chat (`404` if not). When the message is deleted for everyone, the server broadcasts it, and every open client:

- swaps the message for *This message was deleted*
- turns quotes of it into *Original message deleted*
- updates the sidebar preview
- drops it from the reply/edit bar (with a toast), the selection, the pinned bar and the starred panel

The chat list preview and the pinned list no longer return the content of messages deleted for everyone.

### Socket errors are shown

Every `error` the server emits for `send_message` now carries `event: 'send_message'`. This covers an invalid type, empty or oversized text, not being a member, a bad or deleted reply target and server failures. The frontend shows each one as an error toast.

### Logout only on 401

`apiRequest` (`frontend/js/auth.js`) logs out only on `401`, and only when a token was sent, so a wrong password on the login page isn't treated as an expired session. A `403` is returned to the caller like any other error. The auth middleware used to answer an invalid or expired token with `403`, and a token for a deleted user with `404`. Both now return `401`. That was the only case that relied on the old 403-logout.

### Endpoints and events

| Change | Details |
|---|---|
| `POST /api/messages`, `PATCH /api/messages/:id`, `POST /api/messages/forward` | Text stored raw via `cleanMessageText`. `400` for empty, non-string or over 5000 characters. |
| `POST /api/chats` | `chatName` stored raw (control characters stripped) |
| `DELETE /api/messages/:id` | Non-member: `404`. Broadcasts `message_deleted` when deleted for everyone. |
| `GET /api/chats` | `lastMessage.content` is `null` and `lastMessage.deleted` is set for messages deleted for everyone |
| `GET /api/messages/chat/:id/pinned` | Leaves out messages deleted for everyone |
| Any authenticated endpoint | Invalid/expired token or deleted user: `401` (was `403` / `404`) |
| `message_deleted` (server → `chat_<id>`) | `{ messageId, chatId, deletedForEveryone: true }` |
| `error` (server → socket) | `{ event: 'send_message', message }` |

No new env variables or npm packages. `frontend/sw.js` `CACHE_VERSION` is now `frichat-shell-v3`.

### Manual test checklist

- [ ] Send `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` with the socket connected, and again with the backend's socket blocked (REST fallback). Both show as literal text, with no alert, for sender and receiver.
- [ ] Edit a message to one of the payloads, and forward one. It shows as text in the thread, in quotes, in the sidebar preview, in the starred panel and when pinned.
- [ ] Send `Tom & Jerry "1/2"` over REST and reload. It shows exactly as typed, not `&amp;`.
- [ ] Create a group named `A & B <test>`. The sidebar, header and chat info show it as typed.
- [ ] A and B in one chat: A deletes a fresh message for everyone. B sees the placeholder live without reloading. B's reply to it switches to *Original message deleted*. The sidebar preview updates.
- [ ] B has the reply bar open on a message that A then deletes. The bar closes and a toast says so.
- [ ] Reply via the socket to a message that was just deleted (open two tabs and delete in the other). An error toast appears and nothing is sent.
- [ ] Trigger a `403` (for example, `PATCH` someone else's message from devtools with `apiRequest`). You stay logged in. Corrupt the token in localStorage and reload: you are sent to the login page.
- [ ] A wrong password on the login page shows the error message and doesn't reload the page
- [ ] Dark theme and 360px width: toasts and the deleted placeholder stay readable

### Tests

`test/textRule.test.js` (both fake drivers) covers:
- `cleanMessageText`
- `<script>` and `<img onerror>` payloads stored raw through REST send, socket `send_message`, edit and forward
- the real frontend `escapeHtml` and message renderers (loaded from `frontend/js`) showing those payloads as inert text in bodies, quotes, file names and reactions
- the un-escape script's detection, including the run-twice risk
- the `message_deleted` broadcast and its authorization
- socket error payloads
- `401` from the auth middleware
- `apiRequest` logging out only on `401`

### Known limitations

- Profile full names are still escaped on write (and decoded for push titles). Unifying them is left for later.
- ~~Socket `send_message` still accepts a client-supplied `fileData` record~~ (fixed in the next section)
- Bidi/format characters (for example U+202E) aren't stripped. Only control characters are.
- The un-escape script was dry-run on PostgreSQL only, not on a live MySQL server


## Security fix: files are attached by upload id only

Before this fix, socket `send_message` accepted a `fileData` record from the client and inserted a `files` row with whatever `uploadPath`, name, mime type and size the client sent. A message could therefore point at any path on the server, for example `../../.env`.

Now:
- A client can only reference a file by the `fileId` returned by `POST /api/messages/upload`.
- On every send, the server checks that the file row exists, was uploaded by the same user, is not attached to a message yet, and has a stored path that resolves inside the uploads folder. A conditional `UPDATE` then claims it, so the same id can't be attached twice even if two sends race.
- The message type (`image`/`video`/`file`) comes from the mime type the server recorded at upload. Path, name and size also come only from that row.
- `fileData` on `send_message` is rejected outright.
- These rules apply to socket `send_message` and to `POST /api/messages`.
- Forwarding still reuses the source message's file. The source file row must exist and have a path inside the uploads folder, and the copy's type follows the stored mime type.
- `/uploads/*` requests are decoded and resolved first, and anything that resolves outside the uploads folder gets a `404` before `express.static` sees it. This blocks encoded `../`, backslashes and NUL.
- No code path deletes uploaded files today. If one is added, check it with `resolveUploadPath()` from `backend/utils/uploads.js`.

### Migration

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_file_attachment_claim.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_file_attachment_claim_postgresql.sql
```

The migration adds `files.attached_at` and marks every existing row as attached, so no older file can be claimed by a new send. Run it before starting the new code: uploads and file sends fail until the column exists.

### Endpoints and events

| Endpoint / event | Change |
|---|---|
| `POST /api/messages/upload` | Without `chatId`, the file is only stored and the response is `201 { data: { fileId, messageType, originalName, fileSize } }`. With `chatId`, it uploads and sends as before. Now rate limited to 30 per minute per IP. |
| `POST /api/messages` | Optional `fileId` (integer). Without it, `messageType` must be `text`. |
| `send_message` (socket) | `fileData` is rejected. Optional `fileId`. Without it, `messageType` must be `text`. Errors arrive as `error { event: 'send_message', message }`. |
| `POST /api/messages/forward` | Refuses sources whose file row is missing or points outside the uploads folder (`400`) |

There are no new env variables or npm packages. `UPLOAD_PATH` (already in `.env.example`) is the folder the containment check uses. It is resolved against the server's working directory, the same way multer uses it.

### Manual test checklist

- [ ] Send an image and a PDF from the UI. Both show for the sender and the receiver, as before.
- [ ] In devtools: `socket.emit('send_message', { chatId: <id>, messageType: 'file', fileData: { uploadPath: '../../.env' } })`. An error toast appears and nothing is sent.
- [ ] Upload with `chatId` left out, using `fetch` with a `FormData` that has only `file`. The response contains a `fileId`. Send `send_message` with `{ chatId, messageType: 'text', fileId }`. The file message appears, typed from the real file.
- [ ] Send the same `fileId` again. The error says "File is already attached to a message".
- [ ] As user B, send user A's unattached `fileId`. The error says "File not found".
- [ ] Open `http://localhost:3000/uploads/..%2f..%2f.env` and `/uploads/..%5c.env`. Both return `404`.
- [ ] Forward an image message. It arrives as an image.

### Tests

`test/fileAttach.test.js` (both fake drivers) covers:
- forged `fileData`, another user's id, an already used id, an outside path, and bad ids, on the socket and over REST
- upload-only followed by send, including a second send of the same id
- upload with `chatId` stored as attached
- `resolveUploadPath`
- the static guard, as a unit test and over real HTTP against `server.js`

`test/messageActions.test.js` adds a forward of an attachment whose stored path is outside the uploads folder.

### Known limitations

- Files uploaded without a `chatId` and never sent stay on disk and in `files`. Nothing cleans them up yet.
- Rejected uploads (for example, from a non-member) are also left on disk.
- The static route serves `backend/uploads`, while multer writes to `UPLOAD_PATH` relative to the working directory. These match when the server runs from `backend/` with the default setting, as `start.bat` and `npm start` do. The mismatch existed before this fix and is unchanged.
- The frontend still uploads and sends in one request. Upload-only plus `fileId` is available, but the UI doesn't use it yet.

---

## Phase 4: Formatting, @mentions and link previews

### Formatting

Messages support a small set of formatting marks. `frontend/js/formatter.js` turns them into HTML with a whitelist: every character of the text is escaped first, and the only markup it ever adds is the fixed set below. User-typed HTML such as `<script>` or `<b>` always shows as plain text. There is no Markdown library and no raw HTML path.

| Type | Shows as |
|---|---|
| `**bold**` | **bold** |
| `_italic_` | *italic* |
| `~strike~` | ~~strike~~ |
| `` `code` `` | inline code |
| ` ```js` … ` ``` ` | a code block with a language label and a **Copy** button |
| `https://…` | a link (http/https only), opened in a new tab with `rel="noopener noreferrer nofollow ugc"` |

- Marks don't cross lines. `_` and `~` must sit at a word boundary, so `snake_case_names` stay as typed. Crossed or unclosed marks stay literal text, and the formatter's own tags are always balanced.
- Nothing inside code is formatted, linked or treated as a mention.
- The composer is now a growing textarea. **Enter** sends, **Shift+Enter** adds a line, **Ctrl/Cmd+B** wraps the selection in `**`, and **Ctrl/Cmd+I** wraps it in `_`. A one-line hint under the composer lists the marks on desktop. It is hidden at phone widths.
- Message text keeps its line breaks now (`white-space: pre-wrap`).

### @mentions (group chats)

- Typing `@` in a group opens a list of the chat's members. Use **↑/↓** to move, **Enter** or **Tab** to insert `@username`, and **Esc** to close. The list matches usernames first, then words of the full name.
- The server decides who was mentioned (`backend/utils/mentions.js`). It reads `@username` (3–50 letters, digits or `_`, case-insensitive). It skips e-mail addresses and code. It keeps only members of that group chat, never the sender, at most 20 per message. Mentions are stored in `message_mentions`. Direct chats have no mentions.
- Edits re-sync the mentions (removed names are dropped, new ones are added). An edit never sends a push. Forwarded copies don't carry mentions.
- Messages that mention you get an orange outline, and your own `@name` is highlighted. Only stored mentions are styled, so `@whatever` typed by hand stays plain text.
- The sidebar row shows an orange **@** badge while you have an unread message that mentions you. It disappears once your read position passes that message.
- **Notify only for @mentions**: a checkbox in a group's ⋯ chat options menu (`group_members.mentions_only`). Push rules per member:

  | Chat muted? | Mentions only? | Not mentioned | Mentioned |
  |---|---|---|---|
  | no | no | push | push |
  | no | yes | – | push |
  | yes | no | – | – |
  | yes | yes | – | push |

  Do-not-disturb, quiet hours, a deleted chat and a visible tab on the chat still suppress every push, mentions included. A mention push has the title *"Alice mentioned you in Team"* and `mentioned: true` in its payload.

### Link previews

When a text message contains a URL, the server fetches the first one (`backend/utils/linkPreview.js`) after the message has been sent and broadcast. The send never waits for the fetch. The server reads `og:title`, `og:description`, `og:image` and `og:site_name`, falling back to Twitter tags, `<title>` and `<meta name="description">`. It stores the result in `link_previews` and links it from `messages.link_preview_id`. Then it broadcasts `message_link_preview`. The card shows the site, title, description and image. The **sender** can remove it with ✕. A removed preview never comes back, not even after an edit. An edit to a different link fetches a new preview, and an edit that removes the link clears it.

SSRF protection for the server-side fetch:
- Only `http:`/`https:` is fetched. URLs with `user:password@`, `localhost`/`*.localhost` names and URLs over 2048 characters are refused.
- Every address a hostname resolves to must be public unicast. The fetch refuses loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), CGNAT, multicast, broadcast, unspecified, unique-local (fc00::/7), IPv4-mapped/NAT64/6to4 IPv6, and documentation, benchmark and reserved ranges. If any answer is private, the whole host is refused.
- The check runs inside the socket's own DNS lookup, so the connection goes to exactly the address that was checked. A DNS answer can't change between the check and the connect. IP literals, including encodings like `http://2130706433/` or `0x7f.0.0.1`, are normalized and checked before connecting.
- Redirects are followed by hand, at most 3, and every hop goes through the same checks.
- One 5-second deadline covers the whole chain (`TIMEOUT_MS`). At most 512 KB of body is read, counted after gzip/deflate/br decompression, so compressed bombs are capped too. Only `text/html` responses are parsed.
- Each sender gets at most 20 preview fetches per minute. Concurrent sends of the same URL share one fetch.
- Results are cached by SHA-256 of the URL: good previews for 24 hours, failures (including refused URLs) for 1 hour.
- The image is loaded by the viewer's browser, not by the server. It is dropped if it isn't http(s) or points at a localhost name or a private IP literal, and it loads with `referrerpolicy="no-referrer"`.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_mentions_and_link_previews.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_mentions_and_link_previews_postgresql.sql
```

The migration adds the `message_mentions` and `link_previews` tables, `group_members.mentions_only`, `messages.link_preview_id` (FK, `ON DELETE SET NULL`) and `messages.link_preview_dismissed`. Fresh installs get these from `schema.sql` / `schema_postgresql.sql`. Run the migration before starting the new code, because sends and the chat list read the new columns.

- New env variable (in `backend/.env.example`): `LINK_PREVIEWS_ENABLED` (default `true`). Set it to `false` to switch previews off.
- `ipaddr.js` is now listed in `backend/package.json`. It was already installed as an Express dependency, so run `cd backend && npm install` and nothing new is downloaded.
- `frontend/sw.js` `CACHE_VERSION` is now `frichat-shell-v4`, and the shell includes `js/formatter.js` and `js/mentions.js`.

### New and changed endpoints

All require `Authorization: Bearer <token>`.

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| PUT | `/api/chats/:chatId/mentions-only` | `{ enabled: boolean }` | Non-member: `403`. `400` unless `enabled` is a real boolean. Returns the chat settings (now with `mentionsOnly`). Rate limited to 30/min. |
| DELETE | `/api/messages/:messageId/link-preview` | – | Sender only (`403`). Non-member: `404`. Broadcasts `message_link_preview` with `preview: null`. Shares the 60/min message-action limit. |
| GET | `/api/chats` | – | Each chat adds `unread_mention_count` and `mentions_only` |
| GET | `/api/messages/chat/:id`, `new_message`, send responses | – | Messages add `mentions: [{ user_id, username }]` and `link_preview: { url, title, description, image_url, site_name }` or `null` |
| PUT `/mute`, `/archive`, `/mentions-only` | | | `chat_settings_updated` and the responses add `mentionsOnly` |

### New and changed Socket.IO events

| Event | Direction | Payload | Notes |
|---|---|---|---|
| `message_link_preview` | server → `chat_<id>` | `{ messageId, chatId, preview }` | Sent when a preview is attached, replaced or removed. `preview` is `null` when removed. |
| `message_edited` | server → `chat_<id>` | adds `mentions` | |
| `read_position_updated` | server → the user's own tabs | adds `unreadMentionCount` | Drives the @ badge |
| `send_message` | client → server | unchanged | Mentions are parsed from `content` on the server, after the membership check |

No new client → server events.

### Manual test checklist

Use three users (A, B, C) in one group, and A and B in a direct chat.

- [ ] Send `<script>alert(1)</script>` and `<b>hi</b> <img src=x onerror=alert(1)>`. Both show as literal text for sender and receiver, with no alert. Repeat inside `**…**`, `` `…` `` and a ` ``` ` block.
- [ ] Send `` **bold** _italic_ ~strike~ `code` ``. Each renders. `snake_case_name` and `2~3` stay as typed.
- [ ] Shift+Enter, then a fenced block with ` ```js `. The block shows `js` and a Copy button. Copy, paste elsewhere: the exact code is pasted.
- [ ] Select a word, press Ctrl+B (Cmd+B on macOS): it becomes `**word**`. Ctrl+I with nothing selected puts the caret between `_` `_`.
- [ ] A types `@` in the group: B and C are listed, A is not. ↑/↓ and Enter insert `@b_username `. Enter doesn't send while the list is open. Esc closes it, and Esc doesn't cancel an open reply bar while the list is open.
- [ ] Typing `@` in the direct chat opens nothing.
- [ ] A sends `hi @<B>`. B sees the message outlined and their name highlighted. B's sidebar row shows **@** until B opens the chat and scrolls to it. The badge also clears in B's other tab.
- [ ] B: ⋯ → **Notify only for @mentions**. With B's tab hidden, a message from A without a mention gives no push, and one with `@<B>` does, titled "A mentioned you in <group>". Mute the chat as well: mentions still notify. Untick the option: the muted chat is silent again. Turn on DND: no pushes at all.
- [ ] A sends `https://example.com`. A preview card appears for both a moment later. A sees ✕, B doesn't. A clicks ✕: the card disappears for both and stays gone after a reload.
- [ ] A sends `http://localhost:3000/api/health`, `http://169.254.169.254/latest/meta-data/` and `http://127.0.0.1:3000/`. No card appears, and the server log shows `Link preview skipped … EBLOCKED`.
- [ ] A edits a message to a different link: the card changes. A edits the link out: the card disappears.
- [ ] Dark theme: code blocks, inline code, links, mentions, the @ badge, the suggestion list and preview cards stay readable in sent and received bubbles.
- [ ] At a phone width (360px) the suggestion list fits above the composer, the hint is hidden, the textarea grows to about 4 lines, and preview cards fit the bubble.

### Tests

`cd backend && npm test` (299 tests).
- `test/richText.test.js` loads the real `frontend/js/formatter.js`, `mentions.js` and `messages.js`. It covers XSS payloads, a 3000-input fuzz that checks only whitelisted, balanced tags come out, every mark, links, code blocks, mention highlighting, escaping of preview cards and the autocomplete helpers.
- `test/mentions.test.js` (both fake drivers) covers parsing, storage on REST and socket sends, member-only and group-only rules, edit re-sync, unread-mention counts, the mentions-only endpoint and its validation, and push routing (the full mute × mentions-only × mentioned table, plus DND).
- `test/linkPreview.test.js` covers address ranges and URL rules. It refuses `localhost`, `169.254.x.x`, private, IPv6, encoded and mapped addresses, and DNS answers pointing inside, and checks that the real policy never connects to a loopback test server. Redirects to internal targets, the redirect limit, the timeout and the size cap (also for a gzip bomb) are tested against local servers. It also covers Open Graph parsing, the cache, the per-sender budget, `LINK_PREVIEWS_ENABLED`, dismissing and the dismiss endpoint.
- `test/push.test.js` was updated, because muting is now decided after the query so that mentions can get through.

### Known limitations

- MySQL wasn't run against a live server. The PostgreSQL migration, a fresh `schema_postgresql.sql` install and the real queries were checked on a scratch PostgreSQL database.
- The UI wasn't driven in a real browser here. Rendering is covered by the tests above, but the composer, autocomplete, Copy button and layout need the manual checklist.
- The @ badge counts from the server's read position. If a mentioning message is deleted for everyone while unread, the badge stays until the next read or reload.
- Previews are fetched without a proxy and from the web process (no queue), and the per-sender budget is in memory, so this is single-server only, like the rate limiters. A page that needs JavaScript to set its `og:` tags gives no preview.
- Preview images load directly from the third-party site in viewers' browsers (no image proxy). That site sees the viewer's IP address, but not the referrer.
- Only the first link in a message gets a preview.

---

## Database: fresh install vs. upgrade

`schema.sql` and `schema_postgresql.sql` now contain everything the migration files create, including the `deleted_messages`, `pinned_messages` and `deleted_chats` tables from `schema_updates*.sql` and the read-state columns (`group_members.last_read_message_id`, `muted_until`, `archived_at`) and `idx_msg_chat_id_id` index from `add_read_state*.sql`. Earlier versions of the schema files were missing these.

### Fresh install (empty database)

Run only the schema file. Don't run any migration afterwards. The MySQL migrations marked "run once" fail on columns that already exist.

```bash
# MySQL
mysql -u root -p frichat < database/schema.sql
# PostgreSQL
psql -U postgres -d frichat -f database/schema_postgresql.sql
```

The schema files start by dropping every FriChat table, so never run them on a database whose data you want to keep. `sample_data.sql` is optional, for demo data.

### Upgrade (existing database)

Don't re-run the schema file. Run the migrations you haven't run yet, in this order. Each header says whether that file is safe to run more than once.

| # | MySQL | PostgreSQL |
|---|-------|------------|
| 1 | — | `fix_reactions_constraint.sql` (only databases created before the reaction-constraint fix) |
| 2 | `schema_updates.sql` | `schema_updates_postgresql.sql` |
| 3 | `add_message_delete_columns.sql` | `add_message_delete_columns_postgresql.sql` (or the older `add_message_columns_postgresql.sql`; same result) |
| 4 | `add_password_resets.sql` | `add_password_resets_postgresql.sql` |
| 5 | `add_read_state.sql` (run once) | `add_read_state_postgresql.sql` |
| 6 | `add_push_notifications.sql` | `add_push_notifications_postgresql.sql` |
| 7 | `add_message_actions.sql` (run once) | `add_message_actions_postgresql.sql` |
| 8 | `add_file_attachment_claim.sql` (run once) | `add_file_attachment_claim_postgresql.sql` |
| 9 | `add_mentions_and_link_previews.sql` (run once) | `add_mentions_and_link_previews_postgresql.sql` |
| 10 | `reactions_one_per_user.sql` | `reactions_one_per_user_postgresql.sql` |
| 11 | `add_group_invites_and_settings.sql` (run once) | `add_group_invites_and_settings_postgresql.sql` |
| 12 | `add_security_layer.sql` (run once) | `add_security_layer_postgresql.sql` |
| 13 | `add_message_search.sql` (run once) | `add_message_search_postgresql.sql` (PostgreSQL 12+) |
| 14 | `add_polls_and_scheduling.sql` (run once) | `add_polls_and_scheduling_postgresql.sql` |

```bash
# MySQL, one file at a time
mysql -u root -p frichat < database/<file>.sql
# PostgreSQL: every migration is safe to re-run, so you can run them all in order
psql -U postgres -d frichat -f database/<file>_postgresql.sql
```

On PostgreSQL, a database built from the initial-commit schema plus all the migrations above matches a fresh `schema_postgresql.sql` install: same tables, columns, types, defaults, indexes, constraints, views, triggers and enum types. The only difference is the column order inside a table, because `ALTER TABLE ADD COLUMN` adds columns at the end. Running all the migrations on top of a fresh install is a no-op. The MySQL files were updated the same way but not checked against a live MySQL server.

## Reactions: one per user per message

A user has at most one reaction on a message. Reacting with a different emoji replaces it; reacting with the same emoji again removes it. The REST routes and the socket events share one implementation (`backend/utils/reactions.js`), so both behave the same on MySQL and PostgreSQL.

**Migration:** `database/reactions_one_per_user.sql` (MySQL) / `database/reactions_one_per_user_postgresql.sql` (PostgreSQL). Each keeps only the newest reaction (highest id) per user and message, then sets the unique key to `(message_id, user_id)`. Both are safe to run more than once. Fresh installs from `schema.sql` / `schema_postgresql.sql` already have the key. No new env variables.

**Endpoints** (rate limited, member of the message's chat only, `emoji` is 1-10 characters without whitespace):
- `POST /api/messages/:messageId/reactions` `{ emoji }` → `data.action` is `added`, `replaced` or `removed`
- `DELETE /api/messages/:messageId/reactions` `{ emoji? }` → removes the user's reaction (only if it is still `emoji`, when given)

**Socket events:** `add_reaction { messageId, emoji }` (same toggle/replace rule) and `remove_reaction { messageId, emoji }`. The server broadcasts `reaction_added { messageId, userId, username, emoji, previousEmoji }` for add and replace, and `reaction_removed { messageId, userId, emoji }`. Refusals come back as `error { event, message }`.

**Manual test checklist**
- [ ] Two users in one chat. User A reacts 👍: both see 👍 1.
- [ ] A reacts ❤️ on the same message: both see ❤️ 1 and no 👍.
- [ ] A clicks ❤️ again: the reaction disappears for both.
- [ ] B reacts 👍, A reacts 👍: both see 👍 2; A clicks it: 👍 1.
- [ ] Reload: counts match what was shown live.


---

## Phase 5: Invite links, join approval, group profile and announcement-only mode

Groups get a profile (description and photo), invite links with an optional QR code, an optional approval step for people who join by link, an announcement-only mode, member tags, and a group info panel with a Leave action. Invite links can be switched off with `ENABLE_INVITE_LINKS=false` until the phase 6 safety work is done.

### What it does

- **Invite links.** Admins create links that expire after 1 hour, 1 day, 7 days or never, with an optional maximum number of uses (1–1000). A link looks like `<FRONTEND_URL>/join.html?code=<22 characters>`. The code is 128 random bits. The database keeps only its SHA-256 hash and its first 4 characters (the "hint" admins see in the list), so the full link is shown once, right after it's created, with Copy, a QR code and Download QR code. Admins can list and revoke links.
- **Join page.** Opening a link while signed in shows the group name, photo, description and member count, plus a **Join group** button (or **Request to join**). When signed out, the page sends the user to `login.html?next=join.html?code=…`. After login they come back to the page. `next` accepts only a join-page URL, so it can't be used as an open redirect. Signing up instead of logging in also comes back, because the code is kept in `sessionStorage` and `chat.html` picks it up.
- **Clear failures.** An expired, revoked, used-up, unknown or malformed link gets its own message and reveals nothing about the group (`410` with `code` `EXPIRED`, `REVOKED` or `USED_UP`; `404` `INVALID`; `400` for a malformed code). The last use of a link is claimed with one conditional `UPDATE`, so two people can't both take it. Opening a link you've already used, or one you have a pending request for, doesn't use it up.
- **Approve new members.** With this group setting on, joining by link creates a pending request. All admins get a toast and a badge on the ⓘ button, and the panel lists the requests with **Approve** and **Decline**. The requester is told live (`join_request_decided`). When approved, the chat appears in their list and their open tabs join the room straight away. A declined user can ask again. A request does use one link use.
- **Group profile.** Admins edit the name (1–100 characters) and description (up to 500), and upload or remove a photo: JPEG, PNG or WebP, up to 2 MB (`GROUP_AVATAR_MAX_BYTES`). The type is checked from the file's bytes, not its name or mime type. With `sharp` installed, the photo is re-encoded as a 256×256 WebP, which also strips EXIF data such as GPS position. Files get random names under `uploads/group-avatars/`, and the old file is deleted when a photo is replaced. The photo shows in the chat header, the group panel and the join page.
- **Announcement-only.** With this on, only admins can send. Members see a locked composer saying "Only admins can send messages in this group". The server enforces it on every send path: `POST /api/messages`, `POST /api/messages/upload` with a `chatId`, `POST /api/messages/forward` into the group, and the `send_message` socket event. All of them go through `checkCanPost` in `backend/utils/groups.js`. Reactions, reading and editing your own earlier messages still work.
- **Leaving.** **Leave group** is at the bottom of the panel. If you're the only admin, you pick who becomes admin, and the longest-standing member (earliest `joined_at`) is preselected. Over the API, `newAdminId` is optional, and without it the longest-standing member is promoted. If two admins leave at the same moment, a check after the delete still promotes someone. Removing yourself with `DELETE /api/chats/:id/members/:yourId` follows the same rule.
- **Member tags.** Admins give any member a short label (up to 30 characters). It shows next to the name in the panel and on that member's messages.
- **Group info panel** (ⓘ in a group). It shows the profile, the settings (admins can toggle them; members see a note), invite links, join requests, members with **Admin** badges and tags, and Leave. Every value from users is inserted with `textContent`.

Two fixes in the same code:
- Removing a member (or leaving) now takes that user's open sockets out of the chat room, so they stop receiving its live messages without a reconnect.
- The ⓘ button used to show the direct-chat layout for groups, because it checked `chat.type` instead of `chat.chat_type`.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_group_invites_and_settings.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_group_invites_and_settings_postgresql.sql

# Optional image resizing for group photos
cd backend && npm install
```

The migration adds `chats.description`, `chats.avatar_url`, `chats.approve_new_members`, `chats.announcement_only`, `group_members.member_tag`, and the `chat_invites` and `chat_join_requests` tables. Fresh installs get all of these from `schema.sql` / `schema_postgresql.sql`. Run the migration before starting the new code, because every send now reads `chats.announcement_only`.

- New env variables (in `backend/.env.example`):
  - `ENABLE_INVITE_LINKS` (default `true`). With `false`, creating, listing, previewing and joining by link return `404` with `code: "DISABLED"`, and the panel says links are off. Revoking existing links and handling pending requests still work.
  - `GROUP_AVATAR_MAX_BYTES` (default `2097152`). The frontend checks the default 2 MB before uploading, so if you raise it, also change `GROUP_AVATAR_MAX_BYTES` in `frontend/js/groups.js`.
- New npm package: `sharp` (`optionalDependencies`, `^0.34.5`). If it fails to install, uploads still work, but photos are stored as uploaded (type and size checks still apply, no resize, no EXIF stripping).
- Frontend: `frontend/vendor/qrcode-generator/qrcode.js` (MIT, Kazuhiko Arase, v2.0.4, unchanged; licence next to it) is served locally, so there is no CDN. `frontend/sw.js` `CACHE_VERSION` is now `frichat-shell-v5`, and the shell includes `join.html`, `js/groups.js`, `js/join.js` and the QR library.
- Invite URLs use `FRONTEND_URL` (falls back to `CORS_ORIGIN`), the same as password reset links. Set it to the public address of the `frontend/` folder.

### New endpoints

All require `Authorization: Bearer <token>`. Group routes return `403` to non-members ("Access denied to this chat") and to members who aren't admins ("Only group admins can do this"), and `400` for direct chats. Rate limits are per IP: 30/min for group actions, 10/min for avatar upload and removal, 20/min for invite preview and join.

| Method | Endpoint | Body | Who | Notes |
|---|---|---|---|---|
| GET | `/api/chats/:chatId` | – | members | Now also returns `description`, `avatar_url`, `approve_new_members`, `announcement_only`, `my_role`, `can_post`, `invite_links_enabled`, `pending_request_count` (admins), and participants with `member_tag` and `joined_at`, longest-standing first |
| PATCH | `/api/chats/:chatId/settings` | any of `chatName`, `description`, `approveNewMembers`, `announcementOnly` | admins | An empty `description` clears it. Broadcasts `group_updated` |
| POST | `/api/chats/:chatId/avatar` | multipart `avatar` | admins | JPEG/PNG/WebP up to `GROUP_AVATAR_MAX_BYTES`. Returns the profile with `avatarUrl` and `resized` |
| DELETE | `/api/chats/:chatId/avatar` | – | admins | |
| POST | `/api/chats/:chatId/invites` | `{ expiresIn?: '1h'\|'1d'\|'7d'\|'never', maxUses?: 1-1000 \| null }` | admins | `201` with `code` and `url`. This is the only response that contains them |
| GET | `/api/chats/:chatId/invites` | – | admins | `[{ id, tokenHint, createdByUsername, createdAt, expiresAt, maxUses, useCount, revokedAt, status }]`, where `status` is `active`, `revoked`, `expired` or `used_up` |
| DELETE | `/api/chats/:chatId/invites/:inviteId` | – | admins | `409` if already revoked, `404` if it isn't this group's |
| GET | `/api/chats/:chatId/join-requests` | – | admins | Pending requests, oldest first |
| POST | `/api/chats/:chatId/join-requests/:requestId/approve` | – | admins | `409` if already handled |
| POST | `/api/chats/:chatId/join-requests/:requestId/decline` | – | admins | `409` if already handled |
| PUT | `/api/chats/:chatId/members/:userId/tag` | `{ tag: string \| null }` | admins | Up to 30 characters, trimmed. `null` or `''` clears it. `404` if the user isn't a member |
| POST | `/api/chats/:chatId/leave` | `{ newAdminId? }` | members | Returns `newAdmin: { userId, username } \| null` |
| GET | `/api/invites/:code` | – | any signed-in user | Preview `{ chatId, chatName, description, avatarUrl, memberCount, approvalRequired, joinState }`, where `joinState` is `none`, `member`, `pending` or `declined` |
| POST | `/api/invites/:code/join` | – | any signed-in user | `201` `joined`, `202` `pending`, or `200` `already_member` / `pending` |

Changed: `POST /api/messages`, `POST /api/messages/upload` (with `chatId`) and `POST /api/messages/forward` return `403` with `code: "ANNOUNCEMENT_ONLY"` when a non-admin posts into an announcement-only group.

### New Socket.IO events

All are server → client. No new client → server events.

| Event | Sent to | Payload | When |
|---|---|---|---|
| `group_updated` | `chat_<id>` | `{ chatId, chatName, description, avatarUrl, approveNewMembers, announcementOnly }` | Settings, name, description or photo changed. The composer locks or unlocks live |
| `group_members_updated` | `chat_<id>` | `{ chatId }` | Someone joined, left, was removed, was approved or got a tag. Clients refetch the chat |
| `group_left` | `user_<id>` | `{ chatId }` | You left or were removed. Every tab drops the chat |
| `join_request_created` | each admin's `user_<id>` | `{ chatId, chatName, requestId, user: { id, username, fullName }, pendingCount }` | Someone asked to join |
| `join_requests_updated` | each admin's `user_<id>` | `{ chatId, pendingCount }` | A request was approved or declined |
| `join_request_decided` | requester's `user_<id>` | `{ chatId, chatName, status: 'approved' \| 'declined' }` | |

Changed: `send_message` from a non-admin in an announcement-only group is refused with `error { event: 'send_message', message: 'Only admins can send messages in this group', code: 'ANNOUNCEMENT_ONLY' }`. Nothing is stored or broadcast.

### Manual test checklist

Use four users. A is the admin of a group with B and C. D is not in it. Use a private window for D.

- [ ] A: open the group and click ⓘ. The panel shows the profile, Settings, Invite links, Members (A has an **Admin** badge) and Leave. B's panel has no admin controls.
- [ ] A: **Edit name & description**, enter `<b>x</b>` in both, and save. Everyone sees the literal text. The header and sidebar name update live in B's window.
- [ ] A: **Add photo** with a JPEG over 2 MB: it is refused. A GIF, or a `.txt` file renamed to `.png`: refused. A normal photo: it shows in the header, the panel and on the join page as a 256×256 WebP.
- [ ] A: create a link with **1 hour** and max uses **1**. The link, Copy, a QR code and **Download QR code** appear. Scan the QR code with a phone: it opens the link.
- [ ] D (signed out): open the link. You land on the login page, and after logging in you're back on the join page with the group name, photo, description and member count. Click **Join group**: the chat opens, and A, B and C see D in the member list.
- [ ] Open the same link as another user: "This invite link has reached its maximum number of uses." In A's list the link shows **Used up**.
- [ ] A: create a link and click **Revoke**. Opening it says "This invite link has been revoked by a group admin."
- [ ] Expired: create a **1 hour** link, then in the database run `UPDATE chat_invites SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = <id>` (MySQL: `INTERVAL 1 MINUTE`). Opening it says "This invite link has expired."
- [ ] `join.html?code=oops` and a made-up 22-character code both say the link is invalid. `login.html?next=https://example.com` goes to `chat.html` after login, not to example.com.
- [ ] A: turn on **Approve new members** and create a link. D (removed first, or a fifth user) clicks **Request to join**: "Request sent". A gets a toast and a red badge on ⓘ. **Approve**: D gets "You've been accepted into …" and the chat appears without a reload. Try **Decline** with another user: they get the declined toast, and the join page says they can ask again.
- [ ] A: turn on **Announcement-only**. B's composer turns into the lock notice live. B can't type, attach or send, but can still react. A can send.
- [ ] Bypass attempt as B: in the browser console, run `socket.emit('send_message', { chatId: <id>, messageType: 'text', content: 'x' })`. You get an error toast, and nothing appears for anyone. `fetch` to `POST /api/messages` gets `403 ANNOUNCEMENT_ONLY`. Forwarding a message into the group is refused too.
- [ ] Direct API calls as B: `PATCH /api/chats/<id>/settings`, `POST /api/chats/<id>/invites`, `PUT /api/chats/<id>/members/<C>/tag` and `POST /api/chats/<id>/join-requests/<r>/approve` all return `403`, and nothing changes.
- [ ] A: **Add tag** for B with `Design lead`. The tag shows next to B's name in the panel and on B's messages. Entering 31 characters is cut at 30 by the input, and the server refuses longer ones. **Clear** removes it.
- [ ] A (the only admin): **Leave group**. The picker preselects the longest-standing member, marked "longest in the group". Pick C and confirm: A's chat closes and disappears from A's list in every tab, and C has the **Admin** badge.
- [ ] Set `ENABLE_INVITE_LINKS=false` and restart. The panel says invite links are off, existing links say "Invite links are turned off on this server.", and links can still be revoked.
- [ ] Dark theme and a 360px-wide phone: the panel, the invite form (stacked), the QR code (white background), the join page and the lock notice fit with no sideways scrolling.

### Tests

`cd backend && npm test` (404 tests, 73 new).
- `test/groups.test.js` (both fake drivers) covers:
  - Invites: the code format, that only the hash and hint are stored, the expiry SQL, and that listing never leaks the code.
  - Joining: preview, joining with the use count, socket room join and `deleted_chats` cleanup, and repeat joins.
  - Failing links: expired, revoked, used-up and unknown links both on preview and join, the lost-race case, direct-chat links, and `ENABLE_INVITE_LINKS`.
  - Approval: request, admin notice, approve, double decision (`409`), decline and asking again.
  - Permissions: every admin endpoint as a non-admin (`403`, nothing changed), as a non-member, and on a direct chat.
  - Announcement-only: REST send, upload, forward, the socket event (no insert, no broadcast) and `GET /chats/:id` `can_post`.
  - Leaving: longest-standing member, picked successor, invalid picks, another admin remaining, and self-removal.
  - Validation rules, avatar type sniffing, resize to 256×256 WebP, and safe deletion.
- `test/groupsFrontend.test.js` loads the real `auth.js`, `chat.js`, `groups.js` and the vendored QR library. It covers the `next=` open-redirect guard, the pending-invite storage, the avatar URL whitelist, tag escaping in sender lines, the composer lock, and that the QR library draws a valid code.
- The test doubles in `fileAttach`, `mentions`, `messageActions`, `sendMessage` and `textRule` were taught the new posting-check query. Their assertions are unchanged.

### Known limitations

- MySQL wasn't run against a live server. On PostgreSQL 18, a fresh `schema_postgresql.sql` install matched an older schema plus the new migration (run twice) column for column, and the real server was driven end to end over REST and Socket.IO, and in headless Edge (light/dark, 375px).
- Phase 6 items: anyone who has a valid link can join, including someone an admin removed earlier (there are no bans yet). Join requests have no per-user limit beyond the link's max uses and the per-IP rate limit. Rate limits are in memory and per IP, as elsewhere.
- A requester who is offline when their request is decided gets no push notification. They see the result when they next open FriChat (the chat is in their list) or the join page.
- Only admins can tag. There is no promote or demote endpoint besides the leave hand-over (not in this phase).
- Changing `chats` settings bumps `chats.updated_at` (existing `ON UPDATE` / trigger), so a settings change moves the group up the sidebar like a new message.

---

## Phase 6: Safety layer (verification, sessions, devices, blocking, socket limits, group follow-ups)

The safety layer that has to exist before strangers can reach members through invite links: verified email addresses, short-lived tokens with revocable per-device sessions, blocking, Socket.IO rate limits, and the Phase 5 group follow-ups (bans, admin rights, join-decision pushes, join-request limits).

### What it does

- **Tokens moved out of `localStorage`.** Before this phase, a 7-day JWT was stored in `localStorage` and read by `auth.js`, `websocket.js`, `messages.js`, `groups.js` and `pwa.js`. Now:
  - The **access token** is a 15-minute JWT (`ACCESS_TOKEN_TTL`) that carries `userId` and the session id (`sid`). It lives only in a JavaScript variable in `auth.js`.
  - The **refresh token** is 256 random bits in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie named `frichat_refresh`. The cookie has `Path=/api/auth`, so it never goes to chat, message or upload routes.
  - Each page load calls `POST /api/auth/refresh` to get an access token, and the client renews it a minute before it expires. Any old `authToken` left in `localStorage` is deleted on load. `localStorage` keeps only the non-secret `userData` as a "signed in on this browser" hint.
- **Rotation and reuse detection.**
  - Every refresh returns a new refresh token. The old token's SHA-256 hash moves to `session_refresh_tokens`, and only hashes are ever stored.
  - Presenting an old token again means a copy exists somewhere. The server revokes that whole session (the family), disconnects its sockets, and returns `401 TOKEN_REUSED`. The newest token stops working too.
  - Two tabs refreshing at the same moment is a race, not theft. Within `REFRESH_REUSE_GRACE_SECONDS` (default 10) of a rotation, the old token gets `409 REFRESH_RACE` instead of a revoke, and the client retries with the cookie the other tab just received. Tabs also serialise refreshes with the Web Locks API where the browser supports it.
- **Sessions table.** One row per signed-in device. Each row holds the user, the current refresh-token hash, a device label parsed from the user agent (for example "Chrome on Windows" or "Safari on iPhone", with no external parser), the last IP, created, last active (written at most once a minute), expiry (30 days, sliding) and revoked. The IP is shown as-is, with no geolocation lookup.
- **Every request re-checks the session.** The auth middleware and the Socket.IO handshake load the user through `sessions JOIN users WHERE revoked_at IS NULL`. A revoked device is refused on its next request, not when its access token expires. Revoking a session emits `session_revoked` to the room `session_<id>`, and then disconnects every socket in it. In a live test the revoked device was disconnected 6 ms after **Log out**. On reconnect the handshake checks the token and session again:
  - `Invalid or expired token`: the client refreshes and reconnects.
  - `Session revoked`: the client signs out.
- **Settings > Devices** lists active sessions newest first, with device, last active and IP, and marks **This device**. Each other device has **Log out**, the current one has **Log out this device**, and there is a **Log out all other devices** button.
- **Change password** (Settings) needs the current password, and the new one must be different. It signs out every other device and keeps this one. A wrong current password returns `400`, not `401`, so it doesn't sign you out. A **password reset** by email signs out every device.
- **Email verification.**
  - Sign-up sends a link to `<FRONTEND_URL>/verify-email.html?token=…`. The link is single-use and expires after 24 hours (`EMAIL_VERIFICATION_TTL_HOURS`). Only its SHA-256 hash is stored, it goes out through `utils/mailer.js`, and without SMTP the link is printed to the server console.
  - Unverified users can sign in and use the chats they already have, but they can't:
    - create invite links
    - join groups by link
    - start a chat with, create a group with, or add to a group anyone they don't already share a chat with
  - The refusal is `403 EMAIL_NOT_VERIFIED`. A banner in the sidebar, Settings > Email and the join page all offer **Resend**, rate limited to 3 per 15 minutes per account and 10 per hour per IP. Open tabs drop the banner live (`email_verified`) when the link is used.
  - **Accounts that already exist when you run the migration are marked verified**, so current users lose nothing.
- **Blocking.** **Block user** / **Unblock user** is in the chat ⋯ menu of a direct chat and in the ⋯ options of each member in a group panel. **Settings > Blocked users** lists blocked users with **Unblock**. The server enforces the following:
  - **Direct messages, both directions:** `POST /api/messages`, upload into the chat, forward, `send_message`, reactions and edits are refused with `403 BLOCKED` (socket: `error { code: 'BLOCKED' }`). The composer of a blocked direct chat is locked with the reason. No new direct chat can be created between the two.
  - **Presence:** the blocker's `user_status` broadcasts skip the blocked user's sockets. REST lists (chat list, chat details, user search) show the blocker as `offline` to them, and blocking immediately sends the blocked user's open tabs an `offline` status.
  - **Typing:** `user_typing` isn't delivered between the two users, in either direction.
  - **Groups:** the blocked user can't put the blocker into a new group or add them to one. The blocker can still add the person they blocked.
  - **Other paths:** @mentions from the blocked user don't mention or notify the blocker, new-message pushes from the blocked user skip the blocker, and admins who blocked a requester aren't sent the live `join_request_created` notice.
- **Socket.IO rate limits.** `backend/config/socketLimits.js` defines token buckets per socket and per user (all of a user's tabs share the user bucket) for each event group:
  - `send_message`
  - `typing` (dropped silently)
  - `add_reaction` and `remove_reaction`
  - `join_chat` and `authenticate`

  A dropped event is answered with `rate_limited { event, retryAfterMs }`, and the UI shows a toast. A socket that hits the limit 30 times in a minute is disconnected (`rate_limited { disconnected: true }`), and its user bucket still applies after it reconnects.
- **Group follow-ups from Phase 5:**
  - **Remove and ban.** In the members panel, each member's ⋯ menu offers **Remove** and **Remove and ban**. A banned user can't rejoin through any invite link (`403 BANNED`, and the attempt doesn't use the link) and can't be added back by an admin. Banning also deletes their pending request, and approving a request from a banned user is refused (`409`). A **Banned** section for admins lists banned users, who banned them, and an **Unban** button.
  - **Make admin / Remove admin.** These are in the same ⋯ menu. The demote is one conditional `UPDATE` that applies only while another admin exists, with a repair step if two admins demote each other at the same moment, so a group always keeps at least one admin (`409 LAST_ADMIN`).
  - **Push for join decisions.** When an admin approves or declines a request, the requester gets a Web Push notification on every device where they enabled push. The notification respects do-not-disturb, reuses the Phase 2 push code, and opens the chat when the request was approved.
  - **Join-request limits.** A user can have at most 3 pending requests across all groups (`429 TOO_MANY_PENDING`). After a decline, they can't ask the same group again for 24 hours (`429 DECLINED_RECENTLY`, and the join page explains it). Neither refusal uses up the link. The limits are in `backend/config/groups.js`.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_security_layer.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_security_layer_postgresql.sql
```

The migration adds:
- `users.email_verified_at`, with every existing account marked verified.
- The tables `email_verifications`, `sessions`, `session_refresh_tokens`, `user_blocks` and `group_bans`.
- The index `idx_join_requests_user_status`.

Fresh installs get all of this from `schema.sql` / `schema_postgresql.sql`. **Run the migration before starting the new code**, because every authenticated request now reads `sessions`. After the upgrade, everyone has to sign in once, since the old 7-day tokens are refused (they have no session).

Users from `sample_data.sql` are unverified on a fresh install. To use them for invite links, verify them by hand:
```sql
UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE email_verified_at IS NULL;
```

New env variables (all optional, in `backend/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_TOKEN_TTL` | `15m` | Access JWT lifetime. Replaces `JWT_EXPIRES_IN`, which is no longer used |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token and session lifetime. It slides forward on every refresh |
| `REFRESH_REUSE_GRACE_SECONDS` | `10` | How long a just-rotated token gets "retry" instead of revoking the session |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | Verification link lifetime |
| `COOKIE_SAMESITE` | `strict` | `strict`, `lax` or `none`. Use `none` only when the frontend and API are on different sites, for example two different `*.onrender.com` hosts. `none` forces `Secure` |
| `COOKIE_SECURE` | `true` | Set `false` only for plain-http development in a browser that refuses Secure cookies from `http://localhost` (older Safari) |
| `TRUST_PROXY` | unset | Behind a reverse proxy (Render, nginx), set it to the number of proxies (usually `1`). `req.ip`, the rate limits and the IPs under Devices then show the client's address |

No new npm packages.

### New endpoints

Refresh and logout read the cookie and require the header `X-FriChat-Refresh: 1`. A page on another origin can't send that header without a CORS preflight, which `CORS_ORIGIN` refuses.

| Method | Endpoint | Body | Auth | Notes |
|---|---|---|---|---|
| POST | `/api/auth/login`, `/api/auth/register` | as before | – | Return `accessToken`, `expiresIn` and `emailVerified` (no `token` any more), and set the refresh cookie. New rate limits: 20 logins per 15 minutes and 10 sign-ups per hour, per IP |
| POST | `/api/auth/refresh` | – | cookie + header | `200` with a new access token and a rotated cookie. `409 REFRESH_RACE` means retry. `401` with `NO_SESSION`, `SESSION_EXPIRED` or `TOKEN_REUSED` (session revoked). Limit 30/min per IP |
| POST | `/api/auth/logout` | – | cookie + header (Bearer optional) | Revokes this session and clears the cookie, also with an expired access token |
| POST | `/api/auth/verify-email` | `{ token }` | – | `400` if the link is invalid, expired or used. Limit 20 per 15 min per IP |
| POST | `/api/auth/resend-verification` | – | Bearer | `400 ALREADY_VERIFIED`. 3 per 15 min per account, 10 per hour per IP |
| PUT | `/api/auth/password` | `{ currentPassword, newPassword }` | Bearer | `400 WRONG_PASSWORD`. Returns `revokedSessions`. 5 per 15 min per IP |
| GET | `/api/auth/sessions` | – | Bearer | `[{ id, device, userAgent, ipAddress, createdAt, lastActiveAt, current }]` |
| DELETE | `/api/auth/sessions/:sessionId` | – | Bearer | Own sessions only (`404` otherwise). Disconnects that device's sockets at once |
| POST | `/api/auth/sessions/revoke-others` | – | Bearer | Everything except the calling session |
| GET | `/api/blocks` | – | Bearer | `[{ id, username, fullName, avatarUrl, blockedAt }]` |
| POST | `/api/blocks` | `{ userId }` | Bearer | `201` (`200` if already blocked). `400` for yourself, `404` for an unknown user |
| DELETE | `/api/blocks/:userId` | – | Bearer | `404` if not blocked |
| DELETE | `/api/chats/:chatId/members/:userId?ban=true` | – | admins | Remove and ban. Plain removal is unchanged. Now validated and rate limited |
| PUT | `/api/chats/:chatId/members/:userId/role` | `{ role: 'admin' \| 'member' }` | admins | `409 LAST_ADMIN`, `404` if not a member |
| GET | `/api/chats/:chatId/bans` | – | admins | `[{ userId, username, fullName, avatarUrl, bannedBy, bannedAt }]` |
| DELETE | `/api/chats/:chatId/bans/:userId` | – | admins | Unban, `404` if not banned |

Block, ban, role and device routes are limited to 30/min per IP.

Other changes to existing endpoints:
- `POST /api/chats/:chatId/members` is now validated and rate limited, and refuses with `403` and code `BANNED`, `BLOCKED` or `EMAIL_NOT_VERIFIED`.
- `POST /api/chats` refuses with `BLOCKED` or `EMAIL_NOT_VERIFIED`.
- `POST /api/chats/:chatId/invites` refuses with `EMAIL_NOT_VERIFIED`.
- `POST /api/invites/:code/join` refuses with `EMAIL_NOT_VERIFIED`, `BANNED`, `TOO_MANY_PENDING` or `DECLINED_RECENTLY`.
- `GET /api/invites/:code` now also returns `canRequestAgain` and `emailVerified`, and `joinState` can be `banned`.
- `GET /api/chats/:chatId` returns `can_post: false` and `post_blocked_message` for a blocked direct chat.
- Message send, upload, forward, reaction and edit refuse with `403 BLOCKED` in a blocked direct chat.

### New Socket.IO events

| Event | Direction | Payload | When |
|---|---|---|---|
| `session_revoked` | server → `session_<id>` | `{ reason: 'logout' \| 'user' \| 'password' \| 'reuse' }` | Right before that device's sockets are disconnected |
| `rate_limited` | server → socket | `{ event, retryAfterMs, disconnected? }` | A limited event was dropped (`typing` is dropped silently) |
| `email_verified` | server → `user_<id>` | `{ userId }` | The verification link was used |
| `block_updated` | server → blocker's `user_<id>` | `{ userId, blocked }` | Block list changed in another tab |
| `user_status` | server → blocked user | `{ userId, status }` | Sent at block (`offline`) and unblock (the real status) |

Changed:
- The handshake now needs a session-bound access token and refuses revoked sessions (`connect_error: Session revoked`).
- Every socket joins `session_<id>`.
- `send_message`, `typing`, `add_reaction`, `remove_reaction`, `join_chat` and `authenticate` are rate limited.
- `send_message` into a blocked direct chat returns `error { event, message, code: 'BLOCKED' }`.

### Manual test checklist

Use users A, B and C, a second browser (or a private window) for A's second device, and the server console for the email links when SMTP isn't set.

1. [ ] Run the migration and restart. A signs in. In DevTools > Application: `localStorage` has no `authToken`, and the cookie `frichat_refresh` is `HttpOnly`, `Secure`, `Strict`, with `Path=/api/auth`. Reload the page several times: you stay signed in.
2. [ ] Wait 15+ minutes, or set `ACCESS_TOKEN_TTL=1m`, and keep chatting. Messages still send, and the Network tab shows `/auth/refresh` calls and no `401` loops.
3. [ ] Sign up as a new user D. The sidebar shows the verify banner. D can't start a chat with A (`EMAIL_NOT_VERIFIED` toast) and the join page asks D to verify. Open the console link: "Your email address is verified", and D's open tab drops the banner without a reload. Opening the link again says it's invalid.
4. [ ] As D before verifying, click **Resend email** 4 times: the 4th is refused with a "We already sent you a few links" message.
5. [ ] A signs in on a second browser. **Settings > Devices** lists both, with the right browser names, "This device" on the current one, last active and IP. **Log out** the other one: that browser goes to the login page within a second ("You were signed out of this device"). Reloading it doesn't get back in.
6. [ ] **Log out all other devices** works the same way for every other device.
7. [ ] Stolen token: in browser 1, copy the `frichat_refresh` cookie value. Reload the page (the token rotates). Wait 15 seconds, then run `curl -X POST -H "X-FriChat-Refresh: 1" -H "Cookie: frichat_refresh=<old value>" http://localhost:3000/api/auth/refresh`: `401 TOKEN_REUSED`. Browser 1 is signed out ("For your security…") and the device is gone from the list.
8. [ ] **Change password** with a wrong current password: error, still signed in. With the right one: the other browser is signed out and this one stays. **Forgot password** → reset: every browser is signed out.
9. [ ] B blocks A from the ⋯ menu of their direct chat. A's composer in that chat is locked ("You can't send messages to this user."), and B's shows "You blocked this user…". A sees B as offline, even though B is online. A's typing in a shared group doesn't show for B, and B's typing doesn't show for A.
10. [ ] Bypass as A from the console: `socket.emit('send_message', { chatId: <dm>, messageType: 'text', content: 'x' })` → error toast, nothing delivered. `POST /api/messages`, forwarding into the direct chat and reacting there → `403`. A creating a new group with B, or adding B to A's group → `403`. `@B` in a shared group doesn't notify or highlight for B.
11. [ ] **Settings > Blocked users** lists A. **Unblock**: A can message B again, and B's online status shows for A again.
12. [ ] Rate limit: from the console, run `for (let i = 0; i < 30; i++) socket.emit('send_message', { chatId: <id>, messageType: 'text', content: 'spam ' + i })`. About 10 arrive, and then "You're sending messages too fast" appears.
13. [ ] Group (A admin, with B and C): open B's ⋯ → **Make admin**. B gets the Admin badge in every member's panel. A → **Remove admin** on A: allowed (B is admin). B tries to remove their own admin rights while they're the last admin → "A group needs at least one admin".
14. [ ] ⋯ on C → **Remove and ban**. C is removed. In the **Banned** section, C shows with "banned by @…". C opening any invite link: "You can't join this group". Adding C back → refused. **Unban**: C can join again.
15. [ ] Approval on: D (verified) requests to join with push enabled and the tab closed. A approves, and D gets a "You joined …" push. Decline another request: "Join request declined" push. The declined user can't request again (join page and API) until 24 h have passed.
16. [ ] D requests to join 3 approval groups, then a 4th: "You already have 3 join requests waiting…".
17. [ ] Dark theme and a 360px-wide phone: the verify banner, the Settings sections (password form, devices, blocked list) and the member ⋯ actions fit without sideways scrolling.

### Tests

`cd backend && npm test` (477 tests, 73 more than before; all pass).
- `test/sessions.test.js` drives the real Express app over HTTP on both fake drivers. It covers:
  - Cookie flags, path and token lifetime, and that only hashes are stored.
  - Rotation, and the stolen old token: `401`, family revoked, sockets disconnected, the newer token dead too.
  - The `409` race and the header requirement.
  - Devices: list, current device, revoking (only your own), and revoke-others.
  - Change password (wrong, same, ok) and reset revoking everything.
  - Logout with an expired access token, and verify/resend including the per-account limit.
  - The Socket.IO handshake (valid, expired, legacy, revoked), cookie settings and device labels.
- `test/authClient.test.js` runs the real `frontend/js/auth.js` in a sandbox. It covers:
  - The token is never written to storage, and an old `authToken` is deleted.
  - A `401` refreshes and retries once, and a failed refresh, revoked session or reused token signs out with the right reason.
  - `403` keeps the session, a network error doesn't sign out, `409` is retried, concurrent callers share one refresh, and the login page never refreshes.
- `test/groups.test.js` now also covers bans, admin rights, the join-request limit, join-decision pushes, the email-verification gates, blocking on every path (REST, socket, reactions, forward, create and add, presence and typing broadcasts, mentions) and the token buckets.
- Existing tests: the fake databases in `chatList`, `messageActions`, `mentions`, `push`, `textRule`, `sendMessage`, `fileAttach`, `reactions` and `linkPreview` were taught the new block lookups. Three assertions were updated on purpose:
  - The chat list is now 4 queries.
  - The push recipient query binds the sender twice.
  - A declined requester waits 24 hours instead of asking again immediately.

  The old "frontend apiRequest" test moved to `authClient.test.js`.
- Live check on PostgreSQL 18, in throwaway databases that were dropped afterwards:
  - The HEAD schema plus the migration, run twice, matches a fresh `schema_postgresql.sql` for every new table and column. Pre-existing users came out verified and later sign-ups unverified.
  - An end-to-end script against the real server, with real Socket.IO clients, passed 18 checks, including the stolen-token case and the 6 ms device disconnect.

### Known limitations

- **MySQL wasn't run against a live server** (none is installed here). The MySQL statements use `DATE_ADD`/`DATE_SUB` with `INTERVAL ? DAY|HOUR|SECOND`. The no-last-admin demote uses a derived table holding the `COUNT(*)`, which MySQL materializes, so the self-referencing `UPDATE` is allowed. Both fake drivers exercise every statement.
- Rate limits (HTTP and socket) and the "last active" throttle are in memory, per server instance, like the existing limiter. Socket revocation uses Socket.IO rooms, so it works across instances only with a shared adapter.
- A socket that connected with a valid access token stays connected after that token expires, until its session is revoked or the socket reconnects. This is the usual Socket.IO model. Revocation is the control.
- If a refresh response is lost on the network after the server rotated the token, the browser keeps the old cookie. The next refresh after the grace window then looks like reuse and signs that device out. This is safe, but it can sign someone out after a bad connection.
- Blocks don't hide group messages: in a shared group, the blocker still sees the blocked user's messages and vice versa, as in most chat apps. Read receipts (`messages_read`) and pins in an existing direct chat aren't filtered by blocks.
- `Secure` cookies over plain `http://localhost` work in Chrome, Edge and Firefox. Older Safari needs `COOKIE_SECURE=false` for local http testing. For deployments where the frontend and API are on different sites, set `COOKIE_SAMESITE=none` (HTTPS only).
- `sample_data.sql` users are unverified on a fresh install (see the SQL above). The sample data itself wasn't changed.
- The block confirm, remove and ban dialogs use the browser's `confirm()` box.

## Phase 7: Message search, shared media, lightbox and a better composer

Find old messages fast, browse what a chat has shared, and send files more easily.

### What it does

- **Message search.** The 🔍 button in the chat header searches the open chat. The 🔍 button next to "Search chats..." in the sidebar searches every chat you're in. Ctrl/Cmd+Shift+F also opens it. The search uses the database's full-text index: MySQL `FULLTEXT`, or PostgreSQL `tsvector` with a GIN index. Every word you type must match, as the start of a word, so "deplo" finds "deployment".
  - Filters: sender, "contains" (photo, video, file or link), and a from/to date. Both dates are included.
  - Each result shows a snippet with the matching words highlighted. Clicking it opens the chat at that message, even if it's thousands of messages back. The server loads the page around the message, and newer pages load as you scroll down. A "jump to latest" button takes you back to the newest messages.
  - Only chats you're a member of are searched. Messages deleted for everyone, or deleted just for you, never show up. Global search also leaves out chats you removed from your list.
- **Shared media** in chat info, for both direct chats and groups. It has three tabs:
  - **Media**: a grid of photos and videos. Tapping one opens the lightbox.
  - **Files**: tap a file to show its message in the chat, or download it.
  - **Links**: http(s) links from text messages, each with a **Show in chat** button.

  Each tab loads 30 items at a time and has a **Load more** button.
- **Lightbox.** Click a photo, or the ⤢ button on a video, to open it full screen.
  - ←/→ (or swiping on a phone) moves through every photo and video in the chat, loading more at either end.
  - Esc closes it.
  - **Download** saves the file, and **Show in chat** jumps to its message.
- **Composer uploads.** The 📎 button, dragging files onto the chat, and pasting (for example a screenshot) all put files in a preview tray above the composer.
  - Remove any file with × before sending.
  - Send uploads the files one at a time, with a progress bar each, then sends the text. A reply applies to the first file.
  - × during an upload cancels it.
  - The tray holds up to 10 files. Files that are too large or of a type the server doesn't allow are refused before upload. The limits come from the server's `MAX_FILE_SIZE` / `ALLOWED_*_TYPES`, and the server still enforces them.
- **Drafts.** Unsent text is saved per chat, and per account, in this browser's localStorage. It comes back when you reopen the chat. The chat list shows it as "**Draft:** …" until you send it or clear the text.
- **Enter key setting.** Settings → Chat → **Press Enter to send**.
  - On (the default): Enter sends and Shift+Enter adds a line.
  - Off: Enter adds a line and Shift+Enter sends.
  - Ctrl/Cmd+Enter always sends. The hint under the composer follows the setting.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_message_search.sql
# PostgreSQL 12+ (safe to run more than once)
psql -U postgres -d frichat -f database/add_message_search_postgresql.sql
```

The migration adds:
- **MySQL:** `FULLTEXT INDEX ft_messages_content (content)` and `INDEX idx_msg_chat_type_id (chat_id, message_type, id)`.
- **PostgreSQL:**
  - A stored generated column, `messages.search_vector`, built as `to_tsvector('simple', content)`. "simple" means no stemming and no stopwords, so it works for any language.
  - The GIN index `idx_messages_search`, plus `idx_msg_chat_type_id`.

Both migrations rebuild the `messages` table, so on a big database run them when few people are online. Fresh installs get the same objects from `schema.sql` / `schema_postgresql.sql`.

No new env variables and no new npm packages.

**Acceptance check (seed + benchmark):**
```bash
cd backend
node scripts/seed-search-test.js            # seeds once, then times 10 searches and checks for leaks
node scripts/seed-search-test.js --reset    # recreate the seed data
node scripts/seed-search-test.js --clean    # remove it
```
- **What it seeds:** a group with 10,000 messages (`--count=N` for more), a private chat the test user isn't in, and messages deleted for the user and for everyone.
- **Seed accounts:** `search_seed_alice`, `search_seed_bob` and `search_seed_eve`, all with the password `SeedPass123`.
- **What it checks:** each search runs through the real controller. The script exits with code 1 if a search takes 1 s or more, misses results, or returns anything from another chat or a deleted message.
- **Where it runs:** it uses the database in `.env` and refuses to run when `NODE_ENV=production`.

### New endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/messages/search` | **Query:** `q`, `chatId` (omit to search all chats), `senderId`, `from`, `to` (ISO 8601; `to` is exclusive), `has` (`image`, `video`, `file` or `link`), `before` (cursor), `limit` (≤ 50).<br>**Returns** newest first: `{ id, chat_id, chat_display_name, sender_name, message_type, file_name, created_at, snippet: { text, highlights: [[start, end]] } }`.<br>**Errors:** `403` if `chatId` isn't your chat. `400` if there's no word and no filter.<br>**Rate limit:** 60/min per user. |
| GET | `/api/chats/:chatId/media` | **Query:** `type` (`media`, `files` or `links`), `before` or `after` (cursor), `limit` (≤ 60).<br>**Order:** `before` pages are newest first, `after` pages are oldest first.<br>**Returns:** links include `urls` and `snippet`; media and files include `upload_path`, `file_name`, `file_size` and `mime_type`.<br>**Errors:** members only (`403`).<br>**Rate limit:** 60/min per user. |
| GET | `/api/messages/upload-limits` | **Returns** `{ maxFileSize, allowedTypes }`, the values multer enforces. |
| GET | `/api/messages/chat/:chatId` (changed) | **New:** `after=<id>` (the next newer page) and `around=<id>` (a page centred on that message). Use at most one of `before`, `after` and `around`; a second one is `400`.<br>`pagination` now also has `hasNewer` / `newerCursor`. The default and `before` responses are unchanged.<br>The query is now validated (express-validator). |

No new Socket.IO events. Search and media are REST-only, and messages that arrive while you're viewing older history wait behind the jump button.

### Manual test checklist

1. [ ] Run the migration, start the server and sign in. Run `node scripts/seed-search-test.js`: every row says `ok`, and it ends with `PASSED`.
2. [ ] Sign in as `search_seed_alice` and open "Search seed: big chat". Header 🔍 → type `needle`. Results appear as you type (well under a second), with "needle" highlighted in each snippet.
3. [ ] Click a result from weeks ago. The chat opens at that message, which flashes. Scroll up and down: older and newer pages load. Click the ↓ button: you're back at the newest messages.
4. [ ] Sidebar 🔍 (all chats) → `secret plans`: "No messages found". Those messages are in a chat Alice isn't in.
5. [ ] Filters: Sender = Seed bob, Contains = Link, From/To dates. The results narrow down. **Clear filters** resets them. A To date before the From date shows a message.
6. [ ] Delete a message for yourself, and another for everyone. Neither is found anymore.
7. [ ] Chat info → **Shared media**: Media, Files and Links tabs, each with **Load more**. Files and Links → **Show in chat** jumps to the message. The same section appears in group info.
8. [ ] Click a photo in the chat. The lightbox opens. ←/→ move through the chat's photos and videos, and Esc closes it. **Download** saves the file. **Show in chat** closes the lightbox and highlights the message. On a phone, swiping left/right works.
9. [ ] Drag two images and a PDF onto the chat. The drop overlay shows, then the tray with previews. Remove one with ×. Type a caption and press Enter. The files upload with progress bars, then the text is sent.
10. [ ] Paste a screenshot into the composer. It lands in the tray as `pasted-<time>.png`.
11. [ ] Add a large video and press × while it uploads. The upload stops and no message appears.
12. [ ] Add an `.exe` (or a file over `MAX_FILE_SIZE`). It's refused with a message before anything uploads.
13. [ ] Type in chat A without sending, then open chat B. Chat A shows "**Draft:** …" in the list. Reopen A: the text is back. Send it: the draft label goes away. Reload the page: drafts are still there.
14. [ ] Settings → Chat → turn off **Press Enter to send**. Enter adds a line, Shift+Enter sends, and the hint changes. Ctrl+Enter sends in both modes. The @mention list still takes Enter while it's open.
15. [ ] Dark theme and a 360px-wide phone: the search panel, the filters (2 columns), the shared-media tabs, the tray and the lightbox fit without sideways scrolling.

### Tests

`cd backend && npm test` (525 tests, 48 more than before; all pass).
- `test/search.test.js` runs on both fake drivers. It covers:
  - Search terms can't carry FULLTEXT/tsquery syntax.
  - The SQL for each engine, including MySQL's LIKE fallback for words under 3 characters and stopwords.
  - Every search joins on your membership, excludes deleted-for-me, deleted-for-everyone and hidden chats, and binds every filter as a parameter.
  - A foreign `chatId` is `403` before any search query runs.
  - Snippets, highlight offsets and link extraction.
  - The media tabs and cursors.
  - `around`/`after` pages.
  - Validation, and that the new routes require auth.
- `test/phase7Frontend.test.js` runs the real `search.js` / `composer.js` in a sandbox. It covers:
  - Highlights are text nodes plus `<mark>`, so HTML in a message stays text.
  - Date handling.
  - The Enter setting.
  - Drafts per account and per chat.
  - The upload checks.
- **Live check on PostgreSQL 18**, in throwaway databases that were dropped afterwards:
  - The HEAD schema plus the migration, run twice, has the same `messages` columns and indexes as a fresh `schema_postgresql.sql`.
  - With 10,000 messages, every benchmark search took 2–12 ms. With 100,000 it took 4–180 ms, except a search for the very common word "the", which took about 775 ms.
  - No leaks while paging through every result.
  - The endpoints were also checked over HTTP against the running server with a real login.

### Known limitations

- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise the statements.
  - InnoDB doesn't index words shorter than `innodb_ft_min_token_size` (3) or its stopwords. FriChat matches those with `LIKE` instead, so they work but don't use the index.
  - MySQL `FULLTEXT` has no prefix matching inside words: "ploy" doesn't find "deploy" (PostgreSQL doesn't either).
- Results are ordered newest first, not by relevance.
- Search sees message text only, not file names.
- Very common words across a very large history are the slowest case: about 0.8 s at 100,000 messages on PostgreSQL.
- Drafts live in this browser only. They don't sync between devices, and signing out doesn't erase them. They're keyed per account.
- Files in the tray belong to the open chat. Switching chats drops queued files. A running upload finishes in the background but leaves the tray.
- Download in the lightbox fetches the file and saves it. If the uploads server doesn't allow that cross-origin fetch, the file opens in a new tab instead.
- The old `openImageModal` in `ui.js` is no longer used by messages, but it was left in place.
- The UI was checked by syntax checks and the sandbox tests, not in a real browser session. Please go through the checklist above.

---

## Phase 8: Polls, scheduled messages and reminders

Decide things together in a chat, send messages later, and get reminded about messages.

### What it does

- **Polls.** The 📊 button in the composer opens **Create a poll**. You can add:
  - A question and 2–12 options.
  - **Allow multiple answers**. If it's off, each person picks one option.
  - **Anonymous voting**. Everyone sees the counts, but nobody sees who voted for what.
  - An optional closing time: 1 hour, 24 hours, 3 days, 1 week, or a time you pick.

  The poll shows up in the chat as a message. Tap an option to vote. Tap it again to take your vote back. In a single-choice poll, tapping a different option moves your vote. Counts, percentages and the bars update live for everyone (`poll_updated`).
  - In polls that aren't anonymous, voter names show under each option. **View votes** shows the full list.
  - The person who created the poll can **Close poll** early. A poll with a closing time closes on its own.
  - The server enforces the rules: members only, no votes in closed or deleted polls, and one choice in single-choice polls. The database enforces them too, with `UNIQUE (option_id, user_id)` and `UNIQUE (poll_id, user_id, choice_slot)`. `choice_slot` is always 0 in single-choice polls. A vote sets your whole selection, so sending the same socket event again changes nothing.
  - Percentages are out of the people who voted. In multiple-choice polls they can add up to more than 100%.
  - Polls can't be forwarded or edited. You can reply to them, star them, delete them, set a reminder on them, and search for their question.
- **Scheduled send.** Type a message and press the 🕒 button next to Send. Pick a time with **In 1 hour**, **Tonight (20:00)** or **Tomorrow (09:00)**, or choose a date and time. Times are in your browser's timezone, and the dialog shows which one.
  - The composer, its draft and the reply bar clear, the same as when you send. If you were replying, the reply is kept.
  - A bar under the chat header shows "N scheduled messages in this chat · View".
  - The 🕒 button in the sidebar (next to ⭐) opens **Scheduled & reminders**. On the **Scheduled messages** tab you can **Edit** (text and time) or **Cancel**.
  - At its time, the server sends the message through the normal message path (`utils/messageDelivery.js`). That means @mentions, the chat moving to the top, un-archiving, read state, `new_message`, Web Push to members who aren't watching, and the link preview.
  - If you left the chat (or were removed), lost posting rights (announcement-only), or a block now applies, the message isn't sent. It's marked **Not sent** with the reason, you get an in-app notice (and a push if you have no visible tab), and it stays in the list until you **Dismiss** or **Reschedule** it.
- **Remind me.** Each message's ⋯ menu has **Remind me**. Pick **In 1 hour**, **Tonight**, **Tomorrow** or a time you choose. At that time you get:
  - An in-app notice (top right) with **View message**, which jumps to the message even if it's far back in the chat.
  - A Web Push if push is on and no FriChat tab is visible. The push respects do-not-disturb, and tapping it opens the chat at that message.

  Reminders are private. Setting a new time on the same message replaces the old reminder. Due reminders stay in **Scheduled & reminders → Reminders**, and the sidebar 🕒 shows a badge, until you dismiss them. If you're no longer in the chat, or the message was deleted for everyone, the reminder is dropped silently.

**Timezones.** The browser sends an ISO instant (UTC). The server refuses times without an offset. It turns the instant into "seconds from now" and stores `CURRENT_TIMESTAMP + n seconds`, so it never interprets a wall-clock time. On the way back it sends a UTC ISO time computed from "seconds until", and each browser shows it in its own timezone. A message scheduled for 09:00 in Berlin shows as 08:00 to a viewer in London.

**Restarts.** Everything lives in the database (`scheduled_messages`, `message_reminders`, `polls.closes_at`). The scheduler (`utils/scheduler.js`, every `SCHEDULER_TICK_SECONDS`) reads the database on each tick. After a restart, the first tick sends anything that came due while the server was down. Each row is claimed with a conditional `UPDATE ... WHERE status = 'pending'`, so overlapping ticks send it once. A row left in `sending` for more than 2 minutes (the server died mid-send) goes back to `pending`.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_polls_and_scheduling.sql
# PostgreSQL (safe to run more than once; run it with psql -f, not inside a transaction)
psql -U postgres -d frichat -f database/add_polls_and_scheduling_postgresql.sql
```

The migration adds:
- The `poll` value to `messages.message_type`.
- The tables `polls`, `poll_options`, `poll_votes`, `scheduled_messages` and `message_reminders`, with their indexes.

Fresh installs get the same objects from `schema.sql` / `schema_postgresql.sql`.

**New env variable** (optional, already in `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULER_TICK_SECONDS` | `15` | How often (5–300 s) scheduled messages, reminders and timed poll closing are checked. Things go out at most this long after their time. |

No new npm packages.

### New endpoints

All of them need a signed-in user and are rate limited per user.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/polls` | **Body:** `chatId`, `question` (≤ 300 characters), `options` (2–12, each ≤ 100 characters, distinct), `multipleChoice?`, `anonymous?`, `closesAt?` (ISO with an offset, in the future, ≤ 365 days away).<br>**Returns** the poll message (`message_type: 'poll'`, `poll: {...}`).<br>**Errors:** `403` if you're not a member or can't post. `400` for invalid input.<br>**Rate limit:** 10/min. |
| GET | `/api/polls/:pollId` | **Returns** `{ id, messageId, chatId, createdBy, question, multipleChoice, anonymous, closed, closesAt, closedAt, voterCount, options: [{ id, text, votes, percent, voters: [{ userId, name }] }], myVotes }`. `voters` is empty for anonymous polls.<br>**Errors:** `404` for non-members. |
| PUT | `/api/polls/:pollId/votes` | **Body:** `optionIds`, your whole selection (`[]` takes your vote back).<br>**Errors:** `400` for more than one option in a single-choice poll or an option from another poll. `404` for non-members. `409` if the poll is closed. `410` if it was deleted. |
| POST | `/api/polls/:pollId/close` | The creator only (`403` for anyone else). Closing an already closed poll just returns it. |
| GET | `/api/scheduled-messages?chatId=` | Your pending, sending and failed scheduled messages, soonest first: `{ id, chatId, content, replyToMessageId, status, failureReason, sentMessageId, sendAt }`. |
| POST | `/api/scheduled-messages` | **Body:** `chatId`, `content`, `sendAt` (ISO with an offset), `replyToMessageId?`.<br>The same posting rules as sending are checked now, and again when it's sent.<br>Up to 100 open per user (`409` above that). |
| PATCH | `/api/scheduled-messages/:scheduledId` | **Body:** `content?`, `sendAt?` (at least one). Pending or failed messages only (`409` once it's sending or sent). Rescheduling a failed message makes it pending again. |
| DELETE | `/api/scheduled-messages/:scheduledId` | Cancels a pending message, or dismisses a failed one. |
| GET | `/api/reminders?status=pending\|fired` | **Returns** `{ id, chatId, messageId, status, remindAt, firedAt, available, message: { senderName, messageType, content, fileName } }`. `message` is `null` once you can't see it any more. |
| POST | `/api/reminders` | **Body:** `messageId`, `remindAt`. The message must be in one of your chats and not deleted. Up to 200 pending per user. |
| DELETE | `/api/reminders/:reminderId` | Cancels a pending reminder, or dismisses a fired one. |

### New Socket.IO events

| Direction | Event | Payload / notes |
|---|---|---|
| client → server | `poll_vote` | `{ pollId, optionIds }`. Same rules as the REST vote (membership, closed, single choice). Rate limited (new `poll` group in `config/socketLimits.js`). Refusals come back as `error` with `event: 'poll_vote'`. |
| server → chat room | `poll_updated` | The poll state, without `myVotes`. |
| server → `user_<id>` | `poll_updated` | The same state, plus the voter's own `myVotes` (sent to the voter's tabs). |
| server → chat room | `new_message` | Also used for new polls (`message.poll`) and scheduled messages when they go out. |
| server → `user_<id>` | `scheduled_message_updated` | The scheduled message after a create, edit, cancel, send or failure (`status`, `failureReason`). |
| server → `user_<id>` | `reminder_updated` | A reminder was created, or removed (`status: 'deleted'`). |
| server → `user_<id>` | `reminder_due` | A reminder came due (the in-app notice). |

The push payloads have `type: 'reminder'` (with `chatId`, `messageId` and a `chat.html?chat=…&message=…` URL) or `type: 'scheduled_failed'`. The service worker passes `messageId` through to the open window. `CACHE_VERSION` is now `frichat-shell-v8`.

### Manual test checklist

Use two accounts (A and B) in a group, plus a direct chat.

1. [ ] Run the migration and restart the server. The log shows "Scheduled messages, reminders and polls checked every 15 s".
2. [ ] A: 📊 → question "Lunch?", options Pizza / Sushi / Salad, single choice → **Create poll**. The poll appears for A and B at the same time.
3. [ ] B taps Pizza. Both screens show 100% · 1 and B's name under Pizza. B taps Sushi: the vote moves (Pizza 0, Sushi 1). B taps Sushi again: the vote is taken back.
4. [ ] Double-click options quickly, and click from two of B's tabs at once. B never ends up with two votes.
5. [ ] A creates a multiple-choice, anonymous poll that closes in 1 hour. B picks two options. Both see the counts, nobody sees names, and the footer says "Closes today …".
6. [ ] A presses **Close poll**. Both see "Closed", and the options are disabled. B doesn't see a **Close poll** button on A's polls.
7. [ ] Create a poll with "Pick a time…" 2 minutes from now. Within 2 minutes plus the tick, it switches to "Closed" by itself.
8. [ ] Poll text with `<b>hi</b>` or `<img src=x onerror=alert(1)>` shows as plain text.
9. [ ] A types "scheduled hello" → 🕒 → **In 1 hour** (or a custom time 2 minutes away) → **Schedule**. The composer clears, a toast shows the time, and the bar under the header says "1 scheduled message in this chat".
10. [ ] Sidebar 🕒 → **Scheduled messages**: edit the text and set the time 1 minute from now → **Save**. At that time the message appears for A and B as a normal message. B gets a push if B's tab is hidden and push is on.
11. [ ] Schedule another one 2 minutes out, then **stop the server**. Start it again after the time has passed. The message is sent within one tick of startup.
12. [ ] Schedule a message as B for 2 minutes out, then have A remove B from the group (or B leaves). At that time the message is not sent. B gets an error toast and a push. The panel shows it as **Not sent** with the reason. **Dismiss** removes it.
13. [ ] Cancel a scheduled message. It is never sent.
14. [ ] On a message → ⋯ → **Remind me** → a custom time 1 minute away. At that time, a "⏰ Reminder" notice appears for that user only. **View message** jumps to the message, even if the chat has scrolled far past it. With the tab hidden and push on, a push arrives, and tapping it opens the chat at the message.
15. [ ] Reload after a reminder fired while you were away. The sidebar 🕒 shows a badge, and the reminder is listed on the **Reminders** tab until you dismiss it.
16. [ ] **Timezones:** set your OS (or the browser's DevTools → Sensors → Location → timezone) to another timezone, reload, and open the panel. Times shift by the zone difference, and the dialog names the new timezone. A message scheduled for 09:00 Berlin shows as 08:00 London.
17. [ ] Announcement-only group as a non-admin: the 📊 and 🕒 buttons are hidden along with the rest of the composer.
18. [ ] Dark theme and a 360 px wide phone: the composer fits (📎 📊 text 😀 🕒 ➤), the poll card, the dialogs, the panel and the reminder notice fit without sideways scrolling, and they are readable in sent and received bubbles.

### Tests

`cd backend && npm test`: 581 tests, 56 more than before, all passing.
- `test/phase8.test.js` (49 tests) runs on both fake drivers against in-memory tables that enforce the real unique keys. It covers:
  - **Time handling:** the same instant written in different offsets gives the same delay; no-offset, past and over-a-year times are refused; times go out as UTC ISO.
  - **Poll input:** cleaning and the 2–12 option rule.
  - **Single choice:** a vote moves, and a burst of 10 conflicting votes leaves one vote.
  - **Multiple choice:** the selection is set exactly.
  - **Refusals:** non-members, closed polls (including a closing time that passed before the scheduler ran), deleted polls and foreign options.
  - **Live updates:** the anonymous broadcast has no names, and the voter gets their own `myVotes`.
  - **Closing:** creator-only close and scheduled close.
  - **Poll creation** through the message path.
  - **`poll_vote` socket events through the real `server.js`:** repeats, a non-member and bad payloads.
  - **Scheduled messages:**
    - Sent at their time through the normal path.
    - Sent once when ticks overlap.
    - Still sent after a "restart" (fresh modules on the same data).
    - Stuck `sending` rows are recovered.
    - Discarded and notified after leaving the chat.
    - Owner-only edit and cancel, never after sending.
  - **Reminders:** they fire only to their owner and are cancelled after leaving the chat.
  - **Validation and routing:** the validation rules, and auth plus a rate limiter on every new router.
- `test/phase8Frontend.test.js` (7 tests) runs the real `polls.js` / `planner.js` in a sandbox. It covers:
  - Every text in the poll card is escaped, and bar widths are clamped numbers.
  - Anonymous and closed cards.
  - The selection logic.
  - `datetime-local` parsing in local time.
  - The presets (tonight until 19:30, tomorrow 09:00, month rollover).
  - Relative labels.
- **Live check on PostgreSQL 18**, in throwaway databases that were dropped afterwards:
  - The HEAD schema plus this migration, run twice, matches a fresh `schema_postgresql.sql` exactly: 533 columns, indexes, constraints and enums.
  - With Node in UTC+2 and the database session in `America/New_York`:
    - 30 concurrent single-choice votes left 1 row, and a direct second-vote `INSERT` was refused by the database.
    - Scheduled times came back as the same instant.
    - Two overlapping ticks sent a message once.
    - Leaving the chat discarded the message and notified the author.
    - A reminder fired, and a timed poll closed.
    - A message scheduled by one process was sent by a new process (a restart).
  - The real server ran against that database with real logins: 26 HTTP checks of every endpoint, including the authorization refusals. The server's own scheduler sent an edited scheduled message, skipped a cancelled one and fired a reminder.

### Known limitations

- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise the statements.
- **Attachments can't be scheduled** (text only, with an optional reply). The dialog says so when files are in the tray.
- **Timing:** messages and reminders go out up to `SCHEDULER_TICK_SECONDS` late (15 s by default). While the server is down they wait and go out right after startup, so they can be late by the length of the downtime.
- **Rare duplicate after a crash:** if the server dies after a scheduled message was stored but before it was marked sent, it is sent again about 2 minutes later.
- **Single server instance assumed**, like the rate limiters. Several instances would still each claim a row only once, but an instance stopped mid-send can be "recovered" by another.
- **Reminder pushes** respect do-not-disturb and quiet hours. The in-app notice and the badge still show.
- **Polls:** they can't be edited after creation. Votes from people who later leave the group still count.
- **The UI wasn't driven in a real browser session.** It was covered by syntax checks, the sandbox tests and the HTTP checks. Please go through the checklist above, especially 16 to 18.

---

## Phase 9: Profiles, privacy and message requests

Decide what other people see about you, and who can reach you.

### What it does

- **Profile** (Settings → Profile, or tap your name at the top of the sidebar):
  - **Photo.** JPEG, PNG or WebP, up to 5 MB. The server checks the file's first bytes (not its name or type), then sharp decodes it and writes a new 512×512 WebP, centre-cropped to a square. Nothing of the uploaded file is kept: no scripts, HTML, SVG, appended data or EXIF/GPS. The file gets a random name under `uploads/avatars/`, is served as `image/webp` with `nosniff`, and replaces (deletes) the old one. Without sharp, photo uploads are refused (`503`). Photos can't be set by URL any more: `PUT /api/auth/profile` now refuses `avatarUrl`.
  - **Display name** and **bio** (up to 160 characters, one line).
  - **Custom status**: an emoji and/or a short text (up to 80 characters), with **Clear after** 30 minutes, 1 hour, 4 hours, 24 hours, a week, or never. Suggestions fill the fields. An expired status is never sent by the server.
  - Photos and status show in the chat list, the chat header, group member lists, join requests, bans and user search. Clicking a name (message sender, member, the header of a direct chat) opens a **profile card** with photo, name, status, presence and bio, plus **Message** and **Block**.
- **Privacy** (Settings → Privacy). For **Last seen and online**, **Profile photo**, **Bio and status** and **Who can add me to groups**, pick **Everyone**, **My contacts** or **Nobody**.
  - "My contacts" means people you share a chat with. A direct chat that is still a message request doesn't count.
  - **Read receipts** off: your reads aren't stored as "read" or sent to anyone, and you don't see other people's reads either (they show as delivered).
  - **Typing indicator** off: nobody sees you typing.
  - **Everything is enforced on the server** (`utils/privacy.js`). Every API response that carries another user's photo, presence, last seen, bio or custom status is filtered for the person asking, and a hidden field is `null`. Socket events go only to people allowed to see them:
    - `user_status` reaches everyone, your contacts, or no one.
    - `user_profile_updated` goes to contacts only, filtered.
    - `messages_read` / `message_status_update` skip members with receipts off.
    - `user_typing` isn't sent at all when you turned typing off.
  - Message payloads no longer carry the sender's avatar, because they go to the whole chat room. The UI takes photos from the filtered member lists.
  - Making the photo audience stricter also renames the photo file, so a URL someone saved earlier stops working.
  - Someone you blocked sees nothing of these fields, whatever you picked.
  - "Who can add me to groups" applies when someone creates a group with you or adds you (`403 PRIVACY_GROUP_ADD`). You can still join by invite link.
- **Message requests.** When someone you share no chat with starts a direct chat, it lands in a **Message requests** section at the top of your chat list. The chat shows a bar with **Accept**, **Delete** and **Block**.
  - **Until you accept:** you can read but not reply or react (`403 REQUEST_PENDING`). Your reads and typing are not sent to the sender, and you don't count as contacts.
  - **Accept:** the chat becomes normal. Reads you already made are sent as read receipts, if you share them.
  - **Delete:** the chat disappears from your list. The sender isn't told.
  - **Block:** blocks the sender and removes the request. Reporting comes in phase 13.
  - Starting a chat with the sender yourself also accepts the request.
- **Settings** now has tabs: **Profile**, **Privacy**, **Notifications**, **Devices** (signed-in devices and password) and **Appearance**. The theme toggle moved from the sidebar into Appearance (**Dark mode**). Blocked users are under Privacy, and email is under Profile. The sidebar's settings icon is now a gear.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_profile_privacy_requests.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_profile_privacy_requests_postgresql.sql
```

The migration adds:
- To `users`: `bio`, `custom_status_text`, `custom_status_emoji` and `custom_status_expires_at`.
- The tables `privacy_settings` (no row means everything is visible to everyone, with receipts and typing on, the same as before) and `message_requests`.

Existing chats are not turned into requests. Fresh installs get the same objects from `schema.sql` / `schema_postgresql.sql`.

**New env variable** (optional, already in `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `PROFILE_AVATAR_MAX_BYTES` | `5242880` | Largest profile photo upload, in bytes. |

No new npm packages. `sharp` (already an optional dependency) is required for profile photo uploads. `npm install` in `backend/` installs it.

### New endpoints

All of them need a signed-in user and are rate limited.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users/me` | Your own profile with everything: `{ id, username, fullName, avatarUrl, bio, customStatus: { text, emoji, expiresAt } \| null, status, lastSeen, privacy }`. |
| PUT | `/api/users/me/profile` | **Body:** `displayName?` (≤ 100), `bio?` (≤ 160). `avatarUrl` is refused. **Rate limit:** 30/min. |
| POST | `/api/users/me/avatar` | Multipart field `avatar`. Replaces the old photo. **Errors:** `400` for a bad or oversized file, `503` without sharp. **Rate limit:** 10/min. |
| DELETE | `/api/users/me/avatar` | Removes your photo. |
| PUT | `/api/users/me/status` | **Body:** `emoji?`, `text?` (≤ 80, at least one of the two), `duration`: `30m` \| `1h` \| `4h` \| `1d` \| `1w` \| `never`. |
| DELETE | `/api/users/me/status` | Clears your status. |
| GET | `/api/users/me/privacy` | `{ lastSeen, photo, bio, groups, readReceipts, typingIndicators }`. |
| PUT | `/api/users/me/privacy` | Any of those fields. Audiences are `everyone` \| `contacts` \| `nobody`, switches are strict booleans. |
| GET | `/api/users/:userId` | The profile card as you may see it: `{ id, username, fullName, avatarUrl, bio, customStatus, status, lastSeen, isSelf, isContact, blockedByMe }`. Hidden fields are `null`. **Rate limit:** 60/min. |
| POST | `/api/chats/:chatId/request/accept` | Recipient only (`404` for anyone else, `409` if already decided). |
| POST | `/api/chats/:chatId/request/delete` | Recipient only. Hides the chat for the recipient. |
| POST | `/api/chats/:chatId/request/block` | Recipient only. Blocks the sender and hides the chat. |

**Changed:**
- `GET /api/chats`: each chat has `message_request: { status, incoming } | null`, and participants carry `customStatus`. PostgreSQL now returns the participant keys camelCase (`userId`, `fullName`, `avatarUrl`), the same as MySQL.
- `GET /api/chats/:chatId`: has `message_request`. Participants carry `last_seen` and `custom_status`. Hidden `status`, `last_seen` and `avatar_url` are `null` (they used to say "offline" for blockers).
- `POST /api/chats`: returns `data.messageRequest`.
- `PATCH /api/messages/:messageId/status`: now validated and rate limited. `status` must be `delivered` or `read`, it only moves forward, it doesn't apply to your own messages, and it is broadcast.
- `PUT /api/auth/profile`: only takes `fullName`.

### New and changed Socket.IO events

| Direction | Event | Payload / notes |
|---|---|---|
| server → `user_<id>` | `user_profile_updated` | `{ id, username, fullName, avatarUrl, customStatus, status }`, filtered as a contact may see it. Your own tabs get your full profile. |
| server → `user_<id>` | `privacy_settings_updated` | Your settings, for your other tabs. |
| server → `user_<id>` | `message_request_updated` | `{ chatId, status }`. The recipient gets accepted, deleted and blocked; the sender gets only accepted. |
| server → users | `user_status` | Now only to the people your last-seen setting allows. `status: null` means "no longer shared with you". |
| server → chat room | `messages_read`, `message_status_update` | Not sent for readers with receipts off, or for request recipients before they accept. Members with receipts off don't receive them. |
| client → server | `message_status` | Same rules as the REST route. Rate limited (new `receipt` group in `config/socketLimits.js`). |
| client → server | `typing` | Dropped when your typing indicator is off, or in a request you haven't accepted. |

`CACHE_VERSION` is now `frichat-shell-v10` (new `js/profile.js`).

### Manual test checklist

Use three accounts: A, B (shares a chat with A) and C (shares nothing with A).

1. [ ] Run the migration and restart the server. Settings shows the tabs Profile, Privacy, Notifications, Devices and Appearance. **Appearance → Dark mode** switches the theme and is remembered after a reload. The sidebar has no sun icon any more.
2. [ ] A: **Profile → Upload photo** with a wide JPEG. It shows as a square in the sidebar, in A's chat items for B, in B's chat header with A and in group member lists. Uploading again replaces it, and **Remove** brings back the initial.
3. [ ] Try uploading a `.svg`, or an `.html` file renamed to `.png`. Both are refused with "must be a JPEG, PNG or WebP image".
4. [ ] A: set display name and bio, **Save profile**. B sees the new name live in the chat list and on A's profile card (click A's name in a group message).
5. [ ] A: status 🎉 "Party", **Clear after 30 minutes**. B sees "🎉 Party" next to A in the chat list, in the header and on the card. Set it to 1 minute through the API (or wait) and check that it disappears without a reload within about a minute.
6. [ ] A: **Privacy →** all three audiences on **Nobody**. B reloads: no photo (initial only), no status, no "online / last seen", and no bio on the card. In DevTools → Network, check `GET /api/chats`, `GET /api/chats/<id>` and `GET /api/users/<A>`: there is no `uploads/avatars/...` path, bio or status text of A anywhere, and `status` / `last_seen` are `null`. In the WebSocket frames, A going offline and online sends B nothing.
7. [ ] A: **My contacts**. B (a contact) sees everything again. C, searching for A in **New chat**, sees no photo.
8. [ ] A: **Read receipts off**. B sends A a message and A reads it. B's tick never turns "read". B reads A's message: A sees no "read" tick either.
9. [ ] A: **Typing indicator off**. A types in the chat with B, and B sees no "is typing".
10. [ ] A: **Who can add me to groups → Nobody**. B creates a group with A: "One or more of these people don't allow you to add them to groups." Adding A to an existing group fails the same way. A can still join by invite link.
11. [ ] C starts a direct chat with A. C sees "Sent as a message request". A sees **Message requests · 1** at the top of the list. Opening it shows the bar (Accept / Delete / Block) and a locked composer. A reading it shows no "read" to C, and A's typing isn't sent.
12. [ ] A: **Accept**. The composer unlocks and C's ticks turn "read" (if A shares receipts). Repeat with a new account and **Delete**: the chat disappears for A, and C sees nothing change. Repeat with **Block**: the chat disappears and the user shows up under **Privacy → Blocked users**.
13. [ ] A phone-width window (360 px) in both themes: the tabs scroll sideways, the privacy rows stack, and the profile card, the request bar buttons and the status form fit without sideways scrolling.

### Tests

`cd backend && npm test`: 636 tests, 44 more than before, all passing.
- `test/phase9.test.js` (44 tests) runs on both fake drivers against an in-memory world of users, settings, chats, blocks and requests. It covers:
  - **"Nobody":** a leak scan of `GET /api/chats/:id`, `GET /api/users/:id` and user search for the hidden photo, bio, status and last seen.
  - **Audiences:** "My contacts" for a contact versus a pending requester, blockers, expired statuses, and legacy non-upload avatar URLs being dropped.
  - **Socket targeting:** presence for nobody, contacts and everyone, and profile updates going to contacts only.
  - **Read receipts:** off for the reader and for the viewer, `read` becoming `delivered`, and status reports that only move forward.
  - **Typing switch** and **group-add refusals**.
  - **Message requests:** created only for strangers, reply refused before accepting, receipts sent on accept, delete telling the sender nothing, block, and only one decision by the recipient.
  - **Validation rules.**
  - **Photo pipeline:** HTML, SVG and fake GIF are refused. A PNG with an appended `<script>` comes out as a clean 512×512 WebP without EXIF. Rename and delete never leave `uploads/avatars`.
  - **Frontend helpers** from the real `profile.js`: only server-made photo paths and escaped markup.
  - **The PostgreSQL chat list** with lowercased keys. The live check below found this leak, and it is fixed.
- Existing fakes learned the two new tables (no rows = defaults). Three assertions changed on purpose:
  - The chat list runs 7 constant queries instead of 4. There is still no N+1.
  - Participants carry `customStatus`.
  - A blocker's hidden status is `null` instead of `'offline'`.
- **Live check on the local PostgreSQL 18**, in two throwaway databases that were dropped afterwards (28/28):
  - The HEAD schema plus this migration, run twice, matches a fresh `schema_postgresql.sql` exactly: 237 columns, 90 indexes and 239 constraints.
  - The real server on that database with three real accounts covered:
    - Profile, status expiry, and the photo upload: a PNG with appended script came out as a 512×512 `image/webp` with `nosniff` and no script bytes.
    - The SVG refusal, and the rename after a stricter audience.
    - "Nobody" leaking nothing in 6 responses.
    - Group-add refusal, the request flow (send, reply refused, accept, double decision, wrong user), receipts staying off, contacts versus strangers, and block.
    - Auth and validation on the new routes.

### Known limitations

- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise the statements. The MySQL migration uses `ADD COLUMN` without `IF NOT EXISTS`, so run it once.
- **Display names are still HTML-escaped on write** (the legacy `sanitizeHtml` rule, kept for consistency with registration). A name like `Tom & Jerry` shows as `Tom &amp; Jerry`, as before. Bio and status are stored raw and rendered with `textContent`.
- **Read receipts in groups** use the existing single `messages.status` column, so "read" means "someone with receipts on read it". Turning receipts back on doesn't retroactively mark older reads.
- **Presence for non-contacts:** when you tighten "Last seen" from Everyone, connected non-contacts get `status: null` right away. Profile changes reach only contacts live; other viewers (for example a search result) see them on their next load.
- **Reporting** is not part of this phase (Block only).
- **Push notifications** still go out for messages in a pending request (so you notice it). The preview shows the sender's name, which is never a hidden field.
- **The UI wasn't driven in a real browser session.** It was covered by syntax checks, the sandbox tests and the live HTTP checks. Please go through the checklist above, especially 5, 6 and 13.

---

## Phase 10: Voice notes and disappearing messages

Record and play voice notes, and let a chat's new messages delete themselves after a while.

### What it does

- **Voice notes.** The mic button sits next to Send.
  - **Hold to record:** release to send, or slide left (or press Esc) to cancel.
  - **Click to record:** a recording bar opens with a timer, live level bars, **Cancel** (trash) and **Send**.
  - The browser records with `MediaRecorder` in the first format it supports: webm/opus (Chrome, Edge, Firefox), mp4/AAC (Safari) or ogg/opus (older Firefox). The limit is **5 minutes**: at 5:00 the note is sent automatically.
  - **Microphone problems** get a clear message: permission blocked, no microphone, microphone in use, no secure context (https or localhost), or a browser without `MediaRecorder`.
  - **Upload** goes through the normal pipeline (`POST /api/messages/upload` with the chat id), with the duration and a 48-bar waveform measured while recording. If the upload fails, the note lands in the upload tray and **Send** retries it.
  - **The player** shows play/pause, the waveform as a seek bar (a real range input, so keyboard, touch and screen readers can seek), the time, and **1× / 1.5× / 2×** speed (remembered per browser). Only one voice note plays at a time.
  - **Played state:** the first time someone else plays your note, the server records it and your mic icon turns blue. Like read receipts, a listener with read receipts off is never reported as having played it, and you don't see plays while your own receipts are off. Notes you haven't played yet show a dot.
- **Disappearing messages:** chat menu (⋮) → **Disappearing messages**, or the clock in the header.
  - The timers are **Off, 24 hours, 7 days or 90 days**. Either person can change it in a direct chat (not while blocked or in an unaccepted request). In a group, only admins can.
  - Every change posts a **notice in the chat**, e.g. "Bob turned on disappearing messages. New messages will disappear 7 days after they're sent." The notice itself never disappears, and it can't be replied to, reacted to, starred or forwarded.
  - Messages sent **after** the change get an `expires_at`, computed inside the INSERT from the chat's timer on the database clock. This covers every send path: socket, REST, file upload, forward, scheduled messages and polls. Earlier messages keep what they had. Forwarded copies follow the **target** chat's timer.
  - **The scheduler** (every `SCHEDULER_TICK_SECONDS`) deletes expired messages from the database, so their reactions, stars, mentions, pins, polls, reminders and plays go too (cascades). It then deletes their `files` rows and the files on disk, unless a forwarded copy still uses that file. Open clients remove the messages live (`messages_expired`).
  - Until the sweep runs, expired messages are already left out of message pages, search and the chat list. Clients also hide them locally the moment their time is up.
  - A clock shows next to the chat's name in the chat list and in the header, and a small clock in the footer of each message that will disappear (hover for when).
  - The dialog says plainly that **people can still copy, screenshot, forward or save** messages before they disappear.
- **Push notifications** for a chat with disappearing messages on, or for a message that will disappear, say only **"New message"**: no text and no poll question. Reminder pushes for such a message hide its text too. Timer-change notices send no push.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_voice_notes_and_disappearing.sql
# PostgreSQL (safe to run more than once; use psql -f, which autocommits the ALTER TYPE)
psql -U postgres -d frichat -f database/add_voice_notes_and_disappearing_postgresql.sql
```

The migration adds:
- `voice` and `system` to the `message_type` enum.
- `messages.expires_at` (indexed), `chats.disappearing_seconds`, and `files.duration_ms` and `files.waveform`.
- The table `voice_note_plays`.

Nothing existing changes: every chat starts with the timer off. Fresh installs get the same from `schema.sql` / `schema_postgresql.sql`.

**Run the migration before starting the new server.** Without it, message pages and the scheduler fail on the missing `expires_at` column.

**New env variables** (optional, already in `backend/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_AUDIO_TYPES` | `audio/webm,audio/ogg,audio/mp4,audio/mpeg,audio/aac` | Audio types the upload accepts. Codec parameters (`;codecs=opus`) are ignored. |
| `MAX_AUDIO_FILE_SIZE` | `10485760` (10 MB) | Largest audio upload. It is never above `MAX_FILE_SIZE`. A 5-minute note is about 1–2 MB as webm/opus, up to ~5 MB as Safari's AAC. |

No new npm packages. Audio is stored under `uploads/audio/`.

### New endpoints

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/chats/:chatId/disappearing` | **Body:** `{ seconds: 0 \| 86400 \| 604800 \| 7776000 }`. **Who:** members of a direct chat, admins of a group. **Errors:** `400` for another value, `403` for a non-member, a non-admin (`ADMIN_ONLY`), a block or an unaccepted request. Posts the notice and returns `{ chatId, seconds, changed }`; the same value again returns `changed: false` and posts nothing. **Rate limit:** 30/min (group actions). |

**Changed:**
- `POST /api/messages/upload` takes the optional fields `voiceDurationMs` (1 – 303000) and `voiceWaveform` (up to 64 comma-separated levels 0–100). It accepts the audio types above, with their own size cap. A refused upload no longer leaves its file on disk.
- `GET /api/messages/upload-limits` also returns `maxAudioFileSize` and `audioTypes`.
- Messages now carry:
  - `expires_at` (UTC ISO or `null`).
  - On voice notes: `duration_ms` and `waveform` (an array). Also `voice_played` on your own notes and `played_by_me` on other people's.
- `GET /api/chats` and `GET /api/chats/:chatId` carry `disappearing_seconds`. The second one also carries `can_change_disappearing`.
- `message_type` can be `voice` or `system`. `POST /api/messages` accepts `messageType: 'voice'` with a `fileId`.

### New Socket.IO events

| Direction | Event | Payload / notes |
|---|---|---|
| client → server | `voice_played` | `{ messageId }`. You must be a member of the message's chat, and it must be someone else's voice note. Recorded once. Rate limited (`receipt` group). |
| server → `user_<senderId>` | `voice_note_played` | `{ messageId, chatId, userId }`. Sent only on the first play, when both people share read receipts and there is no block. |
| server → `chat_<id>` | `chat_disappearing_updated` | `{ chatId, seconds, changedBy }`. Sent before the notice's `new_message`. |
| server → `chat_<id>` | `messages_expired` | `{ chatId, messageIds }`. Sent after the scheduler deleted them. |

`CACHE_VERSION` is now `frichat-shell-v12` (new `js/voice.js` and `js/disappearing.js`).

### Manual test checklist

Use two accounts, A and B, in a direct chat. Add a group where A is admin and B is a member. Test in **Chrome, Firefox and Safari** (desktop and/or iPhone). The microphone needs `http://localhost` or https.

1. [ ] Run the migration and restart. The composer shows a mic button. A **clicks** it, and the browser asks for the microphone. **Block** it: you see "Microphone access is blocked…". Allow it in the site settings and try again.
2. [ ] A clicks the mic, speaks for ~10 s, and presses **Send**. The timer counted up and the level bars moved. B sees a voice note with a waveform, a duration of about 0:10 and an unplayed dot.
3. [ ] A **holds** the mic, speaks, and releases: the note is sent. Hold again, slide left past the hint (it turns red) and release: nothing is sent. Hold and press **Esc**: cancelled.
4. [ ] B plays it: play/pause works, dragging on the waveform seeks, and **1×** cycles through 1.5× and 2×. B starts a second note while the first plays: the first stops. A's mic icon on that note turns blue live, and still after a reload.
5. [ ] B turns **read receipts off** (Settings → Privacy) and plays another note from A. A's icon stays grey.
6. [ ] Record in **Safari** and play it in Chrome and Firefox. Record in Chrome/Firefox and play it in Safari. Check the duration and that seeking works.
7. [ ] Record for 5 minutes (or set `CONFIG.VOICE_MAX_SECONDS` lower in DevTools). The note is sent automatically at the limit.
8. [ ] In the **group**, B opens ⋮ → **Disappearing messages**: the options are disabled, with "Only group admins can change this." A sets **24 hours** and saves. Both see the notice and a clock in the header and the chat list. The dialog shows the copy/screenshot warning.
9. [ ] In the **direct chat**, B sets **7 days**. A sends a text, a photo and a voice note: each footer shows a small clock, and hovering it shows when. Messages from before the change don't have one.
10. [ ] **Expiry.** In the database, set the new messages' `expires_at` to the past:
    - MySQL: `UPDATE messages SET expires_at = NOW() - INTERVAL 1 SECOND WHERE chat_id = <id> AND expires_at IS NOT NULL;`
    - PostgreSQL: `... = CURRENT_TIMESTAMP - INTERVAL '1 second' ...`

    Within `SCHEDULER_TICK_SECONDS` (15 s) they disappear for both A and B without a reload. The rows are gone from `messages`, their `files` rows are gone, and the photo and the audio file are gone from `backend/uploads/images` and `backend/uploads/audio`. The notice and the older messages stay.
11. [ ] **Forwarded copy.** Forward a disappearing photo to a chat with the timer off, then let the original expire. The copy and its file stay.
12. [ ] **Push.** Close B's tab with push enabled and have A send "secret" in the disappearing chat. The notification says "New message", not "secret". With the timer **Off**, it shows the text again.
13. [ ] A sets the timer to **Off**. The notice says it was turned off, the clocks go away, and new messages don't expire.
14. [ ] A **360 px** wide window, in both themes: the composer fits (attach, poll, text box, emoji, schedule, mic, send), and the recording bar, the voice player and the dialog don't scroll sideways.

### Tests

`cd backend && npm test`: **699 tests**, 63 more than before, all passing.
- **`test/phase10.test.js`** (50 tests) runs on both fake drivers. It covers:
  - **Timer rules:** valid values only, refusing non-members, group non-admins and blocked direct chats. An allowed change writes the notice (without `expires_at`) and emits `chat_disappearing_updated` before `new_message`. The same value again is a no-op, and 0 is stored as NULL.
  - **The sweep:**
    - It deletes rows, file rows and **the files on disk**, while a file that a forwarded copy still uses stays.
    - It never unlinks a path outside the uploads folder.
    - It emits `messages_expired` per chat.
    - The scheduler runs it.
  - **Inserts:** every message INSERT in the server carries `expires_at`. The SQL fragment has the right shape for each engine. Pages, search and the chat list skip expired rows.
  - **Shaping:** `expires_at` is an ISO time, and waveforms are parsed.
  - **Voice plays:** non-members, wrong ids and non-voice messages are refused. A play counts only once. Read receipts are respected both ways, and nothing is recorded across a block.
  - **Push:** previews hide text for disappearing chats and messages, voice notes get a label, system notices send no push (checked with real VAPID keys), and reminder pushes hide the text.
  - **Uploads:** the audio allowlist, codec parameters being stripped, the audio cap staying ≤ `MAX_FILE_SIZE`, audio becoming `voice`, the waveform and duration rules, and refused uploads being removed from disk. Plus the route and socket-event wiring.
- **`test/phase10Frontend.test.js`** (13 tests) loads the real `voice.js` and `disappearing.js`. It covers:
  - The recorder format choice for Chrome/Firefox, Safari and older Firefox, and the uploaded type.
  - Waveform compression, time formatting and the microphone error texts.
  - Player markup that holds only numbers (an injected id or level can't add HTML).
  - Notices with escaped names.
  - Expired messages leaving the thread, with quotes turning into "Original message deleted".
  - The page wiring.
- **Existing fakes** learned the new SQL shapes: the reply check reads `message_type`, the reaction lookup skips notices, the push preview reads `disappearing_seconds`, and the delivery INSERT has `expires_at`. No assertions changed.
- **Live check on the local PostgreSQL 18**, in two throwaway databases that were dropped afterwards:
  - **Schema:** the HEAD schema plus this migration, run **twice**, matches a fresh `schema_postgresql.sql` column for column on `messages`, `chats`, `files` and `voice_note_plays`, with the same enum.
  - **Real backend code on that database:**
    - Timer rules, the notice, and `expires_at` about 24 h ahead on the DB clock.
    - Plays.
    - The sweep, which deleted 4 messages and the voice file **from disk** while keeping the file of a forwarded copy. Reactions, stars and plays cascaded.
    - The chat list and message page queries.
  - **The real server over HTTP** with real sessions:
    - The timer endpoint (401/400/403/200).
    - Upload of `audio/webm;codecs=opus`: stored as `audio/webm` under `uploads/audio`, with duration and waveform.
    - A bad waveform, a 15-minute duration, an 11 MB note and a non-member upload refused, with nothing left on disk.
    - Voice notes sent with an expiry through both upload paths.
    - Notices refused for star, forward and reply, and left out of search.
- **Screenshots** (headless Edge, real `style.css` and chat.html markup) at 360 px in light and dark: the thread with notices and voice notes, the composer, both recording modes and the dialog. At 1100 px: the thread and composer. A wrapping placeholder at 360 px was found and fixed.

### Known limitations

- **Real browsers with a real microphone were not tested.** Recording and playback in Chrome, Firefox and Safari is the acceptance criterion, and it needs the checklist above (items 1–7, especially 6). The format choice and the player were tested in the sandbox, and the upload over real HTTP.
- **Safari and webm.** Notes recorded in Chrome or Firefox are webm/opus. Current Safari plays webm/opus, but older Safari / iOS versions may not, and then the player shows "This voice note can't be played in this browser". Safari's own recordings (mp4/AAC) play everywhere. A server-side transcode (ffmpeg) would remove this; it isn't part of this phase.
- **Chrome's webm files carry no duration or seek index.** The player uses the duration measured while recording, so time and seek bar are right. Seeking far into a long note can still be slower or less exact than in an mp4.
- **Duration and waveform come from the recording browser.** The server checks their range and the file size but doesn't decode the audio, so a modified client could send a wrong waveform.
- **The first hold triggers the permission prompt.** Releasing while it's open doesn't send anything: recording carries on in click mode, and you finish with Send or Cancel.
- **What "disappear" can't reach:**
  - Copies people made (screenshots, downloads, forwards to other chats, which follow their own chat's timer).
  - Notifications already shown.
  - Files the browser cached after viewing.
  - Database backups (`database/backup_db`).

  The dialog says this.
- **Timing.** Deletion happens up to `SCHEDULER_TICK_SECONDS` after `expires_at`, up to 200 messages per tick. Until then the API and the clients already hide them.
- **Group "played"** means at least one other member (who shares read receipts) played it.
- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise the statements. The MySQL migration uses `ADD COLUMN` without `IF NOT EXISTS`, so run it once.

---

## Phase 11: Voice and video calls (1:1)

Call the other person in a direct chat, with voice or video. Media goes peer to peer over WebRTC; the server only relays the signaling (Socket.IO) and keeps the history. Group calls are out of scope.

### What it does

- **Starting a call.** A direct chat's header has a **phone** and a **camera** button. Calls are refused (with a message) in groups, in chats you're not in, when either person blocked the other, and until a message request is accepted.
- **Ringing.** The other person's tabs all show an **incoming-call modal** with the caller's name and photo, **Accept** and **Decline**, and a ringtone (generated with Web Audio, no sound files). During **do-not-disturb or quiet hours** it rings silently and says so. The caller hears a ringback tone.
- **One call per user.** Calling someone who is already in a call (or being rung) gets **busy** ("Bob is on another call"). You can't start a second call yourself.
- **30 seconds** without an answer ends the call as **missed**. Accepting on one tab stops the others ringing.
- **In the call:** a full-screen view with the remote video, your own camera as picture-in-picture (mirrored), **mute**, **camera on/off** (video calls), **share screen** (desktop browsers only), **hang up**, and a call timer. Without remote video it shows the other person's photo and the timer.
- **Camera and microphone errors** end the attempt with a clear message: access blocked, no device, device in use by another app, an unanswered permission prompt (**20 s timeout**), or an insecure page (not https/localhost). A video call whose **camera** is missing or busy carries on with audio only. Every wait has a timeout (invite 10 s, ringing 30 s + 5 s safety, connecting 32 s), so the UI never hangs.
- **Connection drops.** If the connection goes to `disconnected` (for 2.5 s) or `failed`, the caller does **one ICE restart** with fresh ICE/TURN credentials. If it isn't connected again within **12 s**, the call ends with "Call ended: the connection was lost." If the **socket** drops mid-call, the server keeps the call for **15 s**, and the page rebinds it with `call_sync` when it reconnects.
- **History.** Every attempt is a row in the new `calls` table, and a **notice** is posted in the chat, worded for each person: "Missed video call" (red) / "Video call, no answer", "Voice call, 4:12", "You declined a voice call" / "Voice call declined", "Voice call, busy". Notices follow the chat's disappearing-messages timer and send no message push.
- **Calls panel** (phone button next to the starred/planner buttons in the sidebar): recent calls with direction, status, duration and time, **voice and video call-back buttons**, and "Load more". Clicking a row opens the chat. It refreshes live when a call ends.
- **Push for incoming calls** (when no FriChat tab is visible, never during DND): "Incoming video call: Alice is calling you". It stays on screen until handled where the platform allows, expires after 30 s at the push service, and is replaced by "Missed video call" if nobody answers. Clicking it opens the chat; the page fetches the ringing call (`call_sync`) and shows the Accept/Decline modal.

#### What a service worker can and can't do for calls

A web push can only show a **notification**. It can't ring continuously, show a full-screen answer screen, or keep a call alive with the page closed.
- **Desktop Chrome/Edge/Firefox:** the notification shows while the browser runs (Chrome/Edge can keep running in the background). `requireInteraction` keeps it until clicked in Chrome/Edge; Firefox and macOS may hide it sooner.
- **Android Chrome:** the notification arrives with the browser closed and vibrates. Tapping opens FriChat, which shows the modal if the call is still ringing.
- **iOS/iPadOS Safari (16.4+):** push works **only for the installed app** (Add to Home Screen). One notification sound, no continuous ring, and `requireInteraction` is ignored.
- Accept/Decline buttons in the notification itself aren't offered: answering needs the page for camera/microphone access anyway.

### Requirements

- **HTTPS is required** for camera and microphone (browsers block `getUserMedia` on plain http). `http://localhost` is the only exception, which is enough for testing on one machine. To test on a phone or a second device, serve the frontend and backend over https (a reverse proxy like Caddy/nginx, or a tunnel such as ngrok / cloudflared) and set `CONFIG.API_BASE_URL` / `SOCKET_URL` and `CORS_ORIGIN` to match.
- **Test on two different browsers or devices.** Two tabs of the same browser share one camera, and many browsers won't give it to both.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_calls.sql
# PostgreSQL (safe to run more than once)
psql -U postgres -d frichat -f database/add_calls_postgresql.sql
```

The migration adds one table, `calls` (`chat_id`, `caller_id`, `callee_id`, `call_type` voice/video, `status`, `started_at`, `answered_at`, `ended_at`, `end_reason`), with indexes on caller, callee and chat. Nothing existing changes. Fresh installs get it from `schema.sql` / `schema_postgresql.sql`. Run it before starting the new server: without the table, every invite fails.

**New env variables** (all optional, in `backend/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `STUN_URLS` | Google's public STUN | Comma-separated `stun:` URLs. |
| `TURN_URL` | (none: no TURN) | Comma-separated `turn:` / `turns:` URLs, e.g. `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349`. |
| `TURN_SECRET` | (none) | The coturn `static-auth-secret`. The server hands out credentials valid for `TURN_TTL` seconds: username `<expiry>:<userId>`, password `base64(HMAC-SHA1(secret, username))`. The secret never reaches the browser. |
| `TURN_TTL` | `21600` (6 h) | Lifetime of those credentials, clamped to 600–86400 s. |
| `TURN_USERNAME`, `TURN_PASSWORD` | (none) | Fixed credentials, for a hosted TURN service that doesn't use the REST scheme. Used only when `TURN_SECRET` is empty. |

No new npm packages.

#### TURN: why and how

STUN is enough when at least one side has a reachable address. Behind symmetric NAT, carrier-grade NAT (mobile data) or strict company firewalls, calls only connect through a **TURN relay**. Without TURN, expect some calls to stay on "Connecting…" and then end with "the connection was lost".

**Running coturn** (Ubuntu/Debian, on a server with a public IP):

```bash
sudo apt install coturn
sudo nano /etc/turnserver.conf
sudo systemctl enable --now coturn
```

```ini
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<long random string, same as TURN_SECRET>
realm=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
total-quota=100
no-multicast-peers
# never relay into private networks
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# behind NAT (e.g. a cloud VM): external-ip=<public IP>/<private IP>
```

Open **3478 udp+tcp**, **5349 tcp**, and the relay range **49152–65535 udp** in the firewall. Then in `backend/.env`:

```
TURN_URL=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349
TURN_SECRET=<the same static-auth-secret>
```

Docker alternative: `docker run -d --network=host coturn/coturn -n --use-auth-secret --static-auth-secret=<secret> --realm=turn.example.com`.

**Hosted TURN** (Metered, Twilio, Cloudflare, Xirsys…): put their TURN URLs in `TURN_URL`. If they give you a REST-API shared secret (coturn-compatible), use `TURN_SECRET`; if they give fixed credentials, use `TURN_USERNAME` and `TURN_PASSWORD`. Services that mint credentials through their own API call (e.g. Twilio's tokens) would need a small change in `backend/utils/turn.js`.

**Checking it:** open `chrome://webrtc-internals` during a call, or the WebRTC "Trickle ICE" sample page with the username/password from `GET /api/calls/ice-servers`. A `relay` candidate means TURN works.

### New endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/calls/ice-servers` | **Auth required.** `{ iceServers, ttl, turn }` for `RTCPeerConnection`, with fresh TURN credentials for this user. `Cache-Control: no-store`. Fetched before every call and every ICE restart. **Rate limit:** 30/min per user (shared with the history). |
| GET | `/api/calls?limit=&before=` | **Auth required.** Your calls, newest first: `{ id, chatId, type, status, endReason, direction, startedAt, answeredAt, endedAt, durationSeconds, otherUser }` plus `pagination { hasMore, nextBefore }`. `limit` 1–100 (default 30), `before` a call id. Only chats you're still in. The other person's photo follows their privacy setting. |

**Changed:** messages with `message_type: 'system'` can now have the content `call:<voice|video>:<status>:<seconds>`. Clients turn the code into text; nothing user-written is in it.

### New Socket.IO events

Every client event is checked on the server. The invite is checked against the chat (direct, both members, no block, request accepted). The others are checked against the call: you must be its caller or callee, and for offer/answer/candidates, the **socket** that is in the call. Rate limits: the `call` group (invite/accept/reject/cancel/hangup/sync, burst 8 per socket) and the `callSignal` group (offer/answer/candidates, burst 120, 20/s, silent).

| Direction | Event | Payload / notes |
|---|---|---|
| client → server | `call_invite` | `{ chatId, type: 'voice' \| 'video' }` |
| server → caller | `call_ringing` | `{ callId, chatId, type, calleeId, ringTimeoutMs }` |
| server → `user_<callee>` | `call_invite` | `{ callId, chatId, type, caller: { id, username, fullName, avatarUrl }, silent, expiresAt }`. `silent` means the callee's DND is on. |
| server → caller | `call_busy` | `{ callId, chatId, type, calleeId }` |
| client → server | `call_accept` / `call_reject` | `{ callId }`. Callee only. |
| server → caller socket | `call_accept` / `call_reject` | `{ callId }` |
| client → server | `call_cancel` | `{ callId }`. Caller only, while ringing. |
| server → users | `call_cancel` | `{ callId, reason: 'cancelled' \| 'declined' \| 'answered_elsewhere' }` |
| server → both | `call_timeout` | `{ callId }` after 30 s without an answer |
| both ways | `call_offer` / `call_answer` | `{ callId, sdp: { type, sdp }, iceRestart? }`. SDP up to 30 KB, relayed only to the other side's socket. |
| both ways | `call_ice_candidate` | `{ callId, candidate }`, cleaned to `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment`. |
| client → server | `call_hangup` | `{ callId, reason?: 'hangup' \| 'connection_failed' \| 'media_error' }`. While ringing it cancels (caller) or declines (callee). |
| server → other side | `call_hangup` | `{ callId, reason, by }`. `reason: 'connection_lost'` when a socket didn't come back within 15 s. |
| client → server | `call_sync` | `{ callId }` after a reconnect (rebinds the call to the new socket), or `{}` (re-sends a ringing invite). |
| server → socket | `call_sync` | `{ callId, active, otherDevice? }` |
| server → other side | `call_peer_reconnected` | `{ callId }`. The caller then restarts ICE if needed. |
| server → socket | `call_error` | `{ event, code, message, callId? }`. Codes: `INVALID`, `ALREADY_IN_CALL`, `NOT_A_MEMBER`, `NOT_DIRECT`, `BLOCKED`, `REQUEST_PENDING`, `NOT_FOUND`, `ALREADY_ANSWERED`, `OTHER_DEVICE`, `CALL_ERROR`. |
| server → both users | `call_log_updated` | `{ callId }` when a call ends (refreshes the Calls panel). |

The call notice arrives as a normal `new_message` in the chat room. `CACHE_VERSION` is now `frichat-shell-v14` (new `js/calls.js`).

### Manual test checklist

Use accounts A and B in a direct chat, on **two different browsers or devices** (e.g. Chrome and Firefox, or a laptop and a phone). Use `http://localhost` on one machine, or https for anything else. Have a third account, C, in a direct chat with B.

1. [ ] Run the migration and restart. A direct chat's header shows a phone and a camera button; a group chat's doesn't.
2. [ ] A clicks the **camera**. The browser asks for camera and microphone. **Block** it: "Access to your camera and microphone was blocked…", and the call screen closes. Allow it and try again.
3. [ ] A calls B (voice). A sees "Ringing…" and hears the ringback. B sees the modal with A's name and photo and hears the ringtone. B **Declines**: A sees "B declined the call." A's chat shows "Voice call declined", B's shows "You declined a voice call".
4. [ ] A calls B (video); B **Accepts**. Both see the other's video full screen and their own in the corner, and the timer counts. Check **mute** (the other side hears nothing), **camera off** (your preview disappears, the other side sees black) and **hang up**. The notice reads "Video call, m:ss" for both, with the right duration.
5. [ ] **Voice call:** the screen shows the photo and the timer, with no camera button. Audio flows both ways.
6. [ ] **Missed:** A calls and B does nothing for 30 s. A sees "No answer". B's modal closes with "Missed call from A", and B's chat shows a red "Missed voice call" and an unread badge.
7. [ ] **Busy:** while A and B are in a call, C calls B. C sees "B is on another call", B is not interrupted, and B's chat with C shows a missed call.
8. [ ] **Two tabs for B:** both ring. Accepting in one closes the other's modal.
9. [ ] **Do-not-disturb:** B turns DND on and A calls. B's modal appears with "Do not disturb is on: ringing silently", and no sound plays.
10. [ ] **Blocked / request:** B blocks A, and A tries to call: "You can't call this user." Unblock. In a message request that isn't accepted yet: "Calls are available once the message request is accepted."
11. [ ] **No camera:** on a machine without a camera (or with the camera in use by another app), start a video call. It continues as audio only, with a message.
12. [ ] **Insecure page:** open the frontend over plain http on a LAN IP (not localhost) and click call: "Calls need a secure connection…".
13. [ ] **Connection drop:** during a call, turn off Wi-Fi on one device for about 5 s and back on. You see "Reconnecting…", then the timer resumes. Turn it off for 30 s: the call ends on both sides with "the connection was lost".
14. [ ] **Screen sharing** (desktop): click the screen button and pick a window. The other side sees it instead of your camera (also in a voice call). Stop with the button or the browser's "Stop sharing" bar: the camera comes back. On a phone the button isn't shown.
15. [ ] **Push:** enable push for B, close B's FriChat tabs, and have A call B. B gets "Incoming video call: A is calling you". Click it within 30 s: FriChat opens and the Accept/Decline modal appears. Let it time out instead: the notification turns into "Missed video call".
16. [ ] **Calls panel:** the phone button in the sidebar lists the calls above, with status, duration and direction; missed ones are red. The call-back buttons start a voice or video call; clicking a row opens the chat.
17. [ ] **TURN:** with `TURN_URL` and `TURN_SECRET` set, `GET /api/calls/ice-servers` returns a `turn:` entry with `<expiry>:<id>` as the username. Call from a phone on mobile data to a laptop on Wi-Fi. If the direct path fails, `chrome://webrtc-internals` shows a `relay` candidate pair.
18. [ ] **Layout:** at 360 px wide, in light and dark themes, the header buttons fit, the incoming card and call controls fit without sideways scrolling, and the self-view doesn't cover the controls.

### Tests

`cd backend && npm test`: **779 tests**, all passing (49 new).
- **`test/phase11.test.js`** (38 tests):
  - **TURN:** the coturn credential format checked against an independent HMAC, the secret never in the response, TTL clamping, default and custom STUN, hosted fixed credentials, and `TURN_URL` without credentials ignored.
  - **Who may call**, on both fake drivers: direct members only; groups and non-members refused; blocks either way; unaccepted requests on either side; bound parameters only.
  - **State machine** (fake store, io and clock): every callee tab rings; DND rings silently; invalid, non-member and blocked invites leave nothing behind; busy and one call per user; accepting on one tab cancels the others; offer/answer/candidates flow only between the two bound sockets (another tab, an outsider, wrong types, oversized SDP and malformed candidates are refused); reject, cancel, timeout and hangup store the right status, notice and pushes; a 4:12 duration; failed connections; the 15 s grace with `call_sync` rebinding; the caller disconnecting during the invite.
  - **Routes:** auth first, rate limited, `no-store` ICE servers, history paging, validation, direction and duration.
- **`test/phase11Frontend.test.js`** (11 tests) loads the real `calls.js` and `disappearing.js`: notice wording for caller and callee, durations, every camera/microphone error text, the HTTPS message, the permission-prompt timeout stopping a late stream, the audio-only fallback (and no fallback after a refusal), page/socket/service-worker wiring, and no `innerHTML` with anything but fixed icons.
- `test/pageScripts.test.js` now treats `calls.js` as a wrapped feature module (no global name leaks).
- **Live check on the local PostgreSQL 18**, in a throwaway database that was dropped afterwards: `schema_postgresql.sql` plus the migration (idempotent), the real server with real sessions, and three real Socket.IO clients. Checked: TURN credentials over HTTP; a refused non-member invite; ring, busy for a third caller, accept, offer/answer/candidate relay, an outsider's offer refused, and hang up after 2 s (`call:video:completed:2` notice, `calls` row completed with timestamps); cancel; a blocked call; the history endpoint and its validation.

### Known limitations

- **Real WebRTC media wasn't tested** (no camera, microphone or second device here). Signaling was tested end to end. Audio/video, screen sharing, ICE restart and TURN relaying need the checklist above on two real devices.
- **Live calls are held in server memory.** A server restart ends every call (both sides then see "the connection was lost" after the reconnect timeout). Running several server instances would need a shared store (e.g. the Redis adapter plus shared call state).
- **Only the caller restarts ICE.** If only the callee's side fails, the callee waits for the caller's restart (12 s) and otherwise ends the call. This avoids both sides sending offers at the same time.
- **Blocking during a call** doesn't end the call in progress; it blocks new ones.
- **Camera off sends black frames** rather than showing your photo to the other side.
- **Ringtone and autoplay.** Browsers may keep Web Audio silent until you have clicked or typed on the page once. A tab opened fresh (e.g. from the call notification) shows the modal but may not ring; phones also vibrate.
- **Hosted TURN with per-request API tokens** (e.g. Twilio's) isn't built in; see the TURN section.
- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise the statements. The MySQL migration uses `CREATE TABLE IF NOT EXISTS`, so running it twice is harmless.

## Phase 12: Events, shared lists and birthdays

Planning tools for families and teams, in any chat (groups and direct chats).

### What it does

- **Events.** Chat options (⋮) → **New event**: title, start and end (your local time, sent as an ISO instant), location, description, and reminders (**1 day before**, **1 hour before**, **when it starts**). The event appears in the chat as a **card** with the time in each viewer's own timezone (plus "18:00 in Europe/Berlin" when it was planned in another zone), the place, **Going / Maybe / Can't go** buttons, live counts and the first names going. The creator is "going" automatically.
- **Answers are live.** Every member's card, the Events tab and the details dialog update as soon as anyone answers (Socket.IO, with a REST fallback). Clicking your current answer takes it back. Cancelled and ended events can't be answered.
- **Details dialog** (card → **Details**): everything above, the description, everyone's names per answer, **Add to calendar (.ics)**, **Show in chat**, and for the creator **Edit** and **Cancel event**.
- **Edits and cancellations** are for the creator only. Members get a system notice in the chat ("Ana changed the time and place of “Dinner”", "Ana cancelled “Dinner”"); clicking it opens the event. Changing only the reminder choices posts nothing. Moving the start re-schedules every reminder for the new time.
- **Reminders** go to members who answered **going or maybe** (and are still in the chat), as an in-app notice and a Web Push when push is enabled (DND and quiet hours respected). Each fires **once**: the scheduler claims a row (`pending → fired`) before sending, so overlapping ticks and restarts can't double-send. A reminder whose time has already passed when the event is created or moved is stored as `skipped` and never fires late; cancelling an event cancels its pending reminders.
- **Events & lists in chat info.** Group info and a direct chat's profile card have an **Events & lists** section with **Events** (upcoming, plus past events) and **Lists** tabs. Also reachable from chat options → **Events & lists**.
- **My events** (calendar button in the sidebar): upcoming or past events across all your chats, grouped by day, filterable to "I'm going" / "Maybe".
- **.ics download**: UTC times, a stable `UID`, `SEQUENCE` = number of edits (re-importing updates the copy in your calendar), `STATUS:CANCELLED` for cancelled events.
- **Shared lists.** Lists tab → type a name → **Create** (posts "Ana created the list “Groceries”"). In the list dialog every member can **add**, **tick**, **edit** (✎: text and due date) and **remove** (×) items. Ticked items move to a collapsible **Completed** section with "✓ Bob · today 14:02". If two people tick the same item, the first one keeps the credit. All changes reach every member's open list live. Renaming or deleting a whole list is for its creator or a group admin.
- **Due dates** on items (clock button when adding, or ✎): the person who set the date gets a reminder (in-app + push) when it comes due, once, unless the item is done by then. Overdue items show in red.
- **Birthdays.** Settings → Profile → **Birthday**: day and month, year optional. The **year is never shown to anyone else**. Settings → Privacy → **Birthday** sets who sees it (default **My contacts**). Profile cards show "🎂 7 November" when allowed. In **groups**, members see a small banner on the day ("🎂 It's Bob's birthday today") with **Wish happy birthday**, which sends "Happy birthday @bob! 🎂🎉" through the normal send path. "Today" is the viewer's local date. 29 February birthdays show on 28 February in other years. The banner can be dismissed for the day. "Nobody" (or a block) hides the banner too.

### Setup

```bash
# MySQL (run once)
mysql -u root -p frichat < database/add_events_lists_birthdays.sql
# PostgreSQL (safe to run more than once; use psql -f, which autocommits the ALTER TYPE)
psql -U postgres -d frichat -f database/add_events_lists_birthdays_postgresql.sql
```

The migration adds `'event'` to `message_type`; the tables `chat_events`, `event_rsvps` (primary key `(event_id, user_id)`: one answer per member), `event_reminders` (unique `(event_id, offset_seconds)`), `chat_lists` and `chat_list_items`; the columns `users.birthday_day`, `birthday_month`, `birthday_year`; and `privacy_settings.birthday_audience` (default `'contacts'`). Existing rows are untouched. Fresh installs get all of it from `schema.sql` / `schema_postgresql.sql`. Run it before starting the new server: without it, the scheduler logs an error for the two new jobs every tick, and profile endpoints fail on the missing columns.

**No new env variables and no new npm packages.** The jobs run on the existing scheduler tick (`SCHEDULER_TICK_SECONDS`, default 15 s), so reminders are on time to within one tick. The service worker cache is now `frichat-shell-v15` (new `js/events.js` and `js/lists.js`).

### New endpoints

All need auth and are rate limited per user.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/events` | `{ chatId, title, startsAt, endsAt, description?, location?, timezone?, reminders? }`. Times are ISO 8601 **with an offset**; start in the future, end after start, at most 31 days long, within 730 days. `reminders` ⊆ `['start','1h','1d']`. Posting rules as for messages (members; admins only in announcement-only groups). Returns the card message (`message.event`). 15/min. |
| GET | `/api/events?chatId=&scope=upcoming\|past` | One chat's events (members only, else 403), or **without `chatId`** "My events" across your chats. Each event has `counts`, `rsvps { going, maybe, declined: [{ userId, name }] }`, `reminders`, `myRsvp`, `startsAt`, `endsAt`, `timezone`, `status`, `started`, `ended`, `revision`. 60/min. |
| GET | `/api/events/:eventId` | Members only (404 otherwise). |
| GET | `/api/events/:eventId/ics` | `text/calendar` attachment. Members only. |
| PATCH | `/api/events/:eventId` | Creator only (403). Send only what changes. Posts `event_updated:<id>:<fields>` unless only `reminders` changed. 409 when cancelled, or when moving an event that has ended. |
| POST | `/api/events/:eventId/cancel` | Creator only. Posts `event_cancelled:<id>`. Cancelling twice is a no-op. |
| PUT | `/api/events/:eventId/rsvp` | `{ response: 'going' \| 'maybe' \| 'declined' \| null }`. Members only; 409 for cancelled/ended events. |
| GET | `/api/lists?chatId=` | The chat's lists with `counts { total, done }`. Members only. |
| POST | `/api/lists` | `{ chatId, name }` (≤ 100 chars, ≤ 50 lists per chat). Posts `list_created:<id>`. 10/min. |
| GET | `/api/lists/:listId` | The list with `items [{ id, text, done, doneBy { userId, name }, doneAt, dueAt, createdBy }]`. |
| PATCH / DELETE | `/api/lists/:listId` | Rename `{ name }` / delete. Creator or group admin. |
| POST | `/api/lists/:listId/items` | `{ text, dueAt? }` (≤ 300 chars, ≤ 200 items). |
| PATCH | `/api/lists/items/:itemId` | Any of `{ text, dueAt (null clears), done }`. |
| DELETE | `/api/lists/items/:itemId` | |
| PUT / DELETE | `/api/users/me/birthday` | `{ day, month, year? }` (a real date; 29 Feb without a year is fine). |
| GET | `/api/chats/:chatId/birthdays?date=YYYY-MM-DD` | Members of a **group** with a birthday on that date (the viewer's local date, within ±1 day of today), filtered by their privacy setting and blocks. `[]` for direct chats. |

**Changed:** `GET/PUT /api/users/me/privacy` and `GET /api/users/me` include `birthday` (the audience); `GET /api/users/me` and `GET /api/users/:userId` include `birthday` (`{ day, month }`, plus `year` for yourself only, or `null`). Message pages put `event` on `event` messages and `event_ref` / `list_ref` on the new notices. Events can't be forwarded.

### New Socket.IO events

Rate limit group `plan` (burst 20 per socket, 40 per user). Every client event checks that you're a member of the chat the event/list/item belongs to, with the same functions as the REST routes; refusals come back as `error` with `event` set.

| Direction | Event | Payload |
|---|---|---|
| client → server | `event_rsvp` | `{ eventId, response: 'going' \| 'maybe' \| 'declined' \| null }` |
| server → `chat_<id>` | `event_updated` | The event (no `myRsvp`; clients find themselves in `rsvps`) after an answer, edit or cancel. |
| server → `user_<id>` | `event_reminder` | `{ event, reminder: 'start' \| '1h' \| '1d', text }` |
| client → server | `list_item_add` | `{ listId, text, dueAt? }` |
| client → server | `list_item_update` | `{ itemId, text?, dueAt?, done? }` |
| client → server | `list_item_remove` | `{ itemId }` |
| server → `chat_<id>` | `list_updated` | The whole list with items, after any change. |
| server → `chat_<id>` | `list_deleted` | `{ listId, chatId }` |
| server → `user_<id>` | `list_item_due` | `{ itemId, listId, chatId, listName, text }` to whoever set the due date |

New cards and notices arrive as normal `new_message` events.

### Manual test checklist

Use accounts A and B in a group (A admin), C in a direct chat with A, and D who is in neither. Two browsers side by side.

1. [ ] Run the migration and restart; the server log shows no scheduler errors.
2. [ ] A: ⋮ → **New event**, "Dinner", start in 3 minutes, end in 1 hour, reminders **when it starts** and **1 day before**. The card appears for A and B at once; A's **Going** is selected; counts "1 going · 0 maybe · 0 can't go".
3. [ ] B clicks **Maybe**. A's card shows "1 maybe" without reloading. B clicks **Maybe** again: the answer is taken back on both screens.
4. [ ] B answers Maybe again. **Details** shows A under Going and B under Maybe.
5. [ ] **Add to calendar**: the `.ics` opens in your calendar app at the right local time.
6. [ ] B opens Details: no Edit/Cancel. A edits the location: both see "A changed the place of “Dinner”"; clicking the notice opens the event.
7. [ ] After 3 minutes (+ up to 15 s) A and B each get **one** "Dinner is starting now" notice (and a push if enabled and the tab is hidden). The 1-day reminder never fires (it was already past).
8. [ ] A cancels: the card shows "Cancelled", the buttons are disabled, a notice appears, and the .ics link is gone.
9. [ ] **Timezones:** set B's system timezone to another zone and reload: the card shows B's local time plus "… in <A's zone>".
10. [ ] **My events** (calendar button in the sidebar) lists events from the group and the direct chat with A; the filters and Upcoming/Past work.
11. [ ] Group info → **Events & lists**: both tabs work. In the direct chat, the header (profile card) shows the same section.
12. [ ] **Lists:** A creates "Groceries" (notice appears). B adds "Milk" and "Bread": A's open list shows them live. A ticks Milk: B sees it move to **Completed** with "✓ A". Edit an item's text, remove one; both screens follow.
13. [ ] Add an item with a due date 2 minutes ahead: only the person who set it gets "Due in “Groceries”: …" once. Tick an item before its due time: no reminder.
14. [ ] B (not the creator, not admin) sees no Rename/Delete on A's list; A can delete it and B's open list closes with "This list was deleted".
15. [ ] **Birthdays:** B sets today's day and month. A opens the group: the banner says it's B's birthday; **Wish happy birthday** sends the message with an @mention and the button disappears. A's profile card for B shows the day and month, never the year. B sets Privacy → Birthday → Nobody: after reopening the chat, A sees no banner and no birthday on the card.
16. [ ] **Outsider:** as D, `GET /api/events/<id>`, `/api/events/<id>/ics`, `/api/lists/<id>` return 404 and `/api/lists?chatId=<group>` / `/api/chats/<group>/birthdays?date=…` return 403.
17. [ ] **Layout:** at 360 px, light and dark themes: the card, the event form (start/end stack), the list dialog and the birthday banner fit without sideways scrolling.

### Tests

`cd backend && npm test`: **826 tests**, all passing (47 new).
- **`test/phase12.test.js`** (39 tests), on both fake drivers with tables that enforce the real keys: event input cleaning, timezone-proof times and limits; RSVPs (members only, racing/repeated events keep one answer, live room updates with names, cancelled/ended refused); creator-only edit/cancel with the right notices, reminders re-scheduled on a new start; reminders once to going/maybe members only, overlapping ticks, a fresh "restarted" instance, cancelled and late reminders skipped; history, notices (never leaking another chat's event) and My events; lists (members only, live updates, first ticker keeps credit, rename/delete rights, due reminders once to the setter, done items and leavers skipped); socket events for non-members; `.ics` escaping, folding and injection; birthday dates, the banner's privacy, blocks and 29 February; validation and that every route is authenticated and rate limited.
- **`test/phase12Frontend.test.js`** (8 tests) loads the real `events.js`: the card escapes all user text, derives the viewer's answer from the name lists, disables closed events, shows the planned timezone; notice wording and links; page/service-worker/socket wiring; no `innerHTML` with user text in `events.js` or `lists.js`.
- `test/pageScripts.test.js` now loads `events.js` and `lists.js` as wrapped feature modules; `test/phase9.test.js`'s fake database answers the new birthday lookup ("not set").
- **Live check on the local PostgreSQL**, in throwaway databases (not the app's): the previous schema plus the migration twice, and a fresh `schema_postgresql.sql`, give identical columns. Then the real server and three real Socket.IO clients (two members and an outsider) ran 47 checks: event card, live RSVP, outsider refused on every REST and socket path, .ics, creator-only edit and its notice, My events, history, lists live with tick attribution, due reminder, birthdays and privacy, reminders fired exactly once, cancel, validation.

### Known limitations

- **The UI wasn't clicked through in a browser here.** The scripts load together (page-scripts test), the card rendering and wording are unit tested, and the server side was tested live, but the dialogs, layout at 360 px and dark theme need the checklist above.
- **MySQL wasn't run against a live server** (none is installed here). Both fake drivers exercise every statement; the MySQL migration's `ALTER TABLE ... ADD COLUMN` lines fail if run twice (they're not idempotent in MySQL), so run it once.
- **No recurring events** and no all-day events; an event needs an end time.
- **Due-date reminders go only to whoever set the date**, not to everyone in the chat (there's no "assignee").
- **Reminder timing** depends on the scheduler tick (default 15 s).
- **Deleting an event's card** (delete for everyone, or disappearing messages) keeps the event in the Events tab and My events; it's not cancelled.
- **Birthday banners** are for groups only (in a direct chat the birthday is on the profile card). The "wished" and "dismissed" state is remembered per browser (localStorage), not per account.
- **Times in "My events"** are grouped by the start day in your timezone; a multi-day event shows under its first day only.

---

**Enjoy the new features! 🎉**
