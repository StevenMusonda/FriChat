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

Status codes: an expired edit window returns `400` and a forward to a chat you're not in returns `404`, both on purpose. The frontend's `apiRequest` logs the user out on any `403`, and both cases can happen during normal use.

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

- Deleting a message for everyone still isn't broadcast live (as before Phase 3), so quotes of it only switch to *Original message deleted* on the next load
- A reply rejected on the socket path (for example, the original was deleted while the reply bar was open) comes back as a socket `error` event, which the frontend doesn't display yet. The message isn't sent.
- The sidebar preview shows a forwarded or edited last message as plain text, with no label
- Rate limits are per IP and in memory (same as Phase 2)

---

**Enjoy the new features! 🎉**
