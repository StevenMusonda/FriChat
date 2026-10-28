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

**Enjoy the new features! 🎉**
