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

**Enjoy the new features! 🎉**
