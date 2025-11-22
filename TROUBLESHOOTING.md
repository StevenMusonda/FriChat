# FriChat Troubleshooting Guide

## Chat Messages Not Showing/Sending

### Issue: Messages not appearing or reaching other users

**Symptoms:**
- Messages don't appear in chat window
- Other user doesn't receive messages
- Chat list doesn't update

**Solution Steps:**

### Step 1: Restart Backend Server

The most common issue is that the backend server needs to be restarted after configuration changes.

1. **Stop the backend server** (Ctrl+C in the terminal where it's running)

2. **Restart the server:**
   ```powershell
   cd c:\xampp\htdocs\FriChat\backend
   npm start
   ```

3. You should see:
   ```
   ╔═══════════════════════════════════════╗
   ║         FriChat Server Started        ║
   ╠═══════════════════════════════════════╣
   ║  Port: 3000                           ║
   ║  Environment: development             ║
   ║  Database: mysql                      ║
   ╚═══════════════════════════════════════╝
   ✓ MySQL Database connected successfully
   ```

### Step 2: Verify CORS Configuration

Check that your `backend\.env` file has the correct CORS origin:

```env
CORS_ORIGIN=http://localhost
```

**NOT** `http://localhost:8080` if you're accessing the app via `http://localhost/FriChat`

### Step 3: Check WebSocket Connection

1. Open browser DevTools (F12)
2. Go to **Console** tab
3. Look for these messages:
   - ✅ `WebSocket connected`
   - ✅ `User [ID] authenticated and joined chats`

**If you see connection errors:**
- Verify backend is running on port 3000
- Check that `frontend/js/config.js` has correct URL:
  ```javascript
  SOCKET_URL: 'http://localhost:3000'
  ```

### Step 4: Test Message Sending

1. **Open two browser windows/tabs**
2. Login with different accounts in each
3. Create a chat between them
4. Send a message from one window

**In browser console, you should see:**
- Sender window: Message being sent via WebSocket
- Receiver window: `New message received:` log

### Step 5: Clear Cache and Reload

Sometimes browser cache causes issues:

1. **Hard refresh:** Press `Ctrl + Shift + R` or `Ctrl + F5`
2. **Or clear cache:**
   - Press F12
   - Right-click the refresh button
   - Select "Empty Cache and Hard Reload"

### Step 6: Check Network Tab

1. Open DevTools (F12)
2. Go to **Network** tab
3. Filter by **WS** (WebSocket)
4. You should see a WebSocket connection to `localhost:3000`
5. Click on it to see messages being sent/received

### Step 7: Verify Database

Check if messages are being saved to database:

```sql
SELECT * FROM messages ORDER BY created_at DESC LIMIT 10;
```

If messages are in the database but not showing, it's a WebSocket issue.

## Common Issues

### Issue: "CONFIG is not defined"

**Solution:** Ensure `config.js` is loaded before other scripts in HTML files:

```html
<script src="js/config.js"></script>
<script src="js/auth.js"></script>
<!-- other scripts -->
```

### Issue: CORS errors

**Symptoms:**
```
Access to fetch at 'http://localhost:3000/api/...' has been blocked by CORS policy
```

**Solution:**
1. Update `backend\.env`:
   ```env
   CORS_ORIGIN=http://localhost
   ```
2. Restart backend server
3. Clear browser cache

### Issue: WebSocket won't connect

**Check these:**

1. **Backend is running:**
   ```powershell
   cd c:\xampp\htdocs\FriChat\backend
   npm start
   ```

2. **Port 3000 is available:**
   ```powershell
   netstat -ano | findstr :3000
   ```

3. **Firewall isn't blocking:**
   - Temporarily disable firewall to test
   - Add exception for Node.js if needed

### Issue: Messages send but don't appear immediately

**This is normal behavior if:**
- Using API fallback instead of WebSocket
- Page needs manual refresh to see messages

**Solution:**
- Ensure WebSocket is connected (see Step 3 above)
- Check browser console for WebSocket errors

## Debug Checklist

Use this checklist to systematically debug chat issues:

- [ ] Backend server is running (port 3000)
- [ ] MySQL database is running
- [ ] Apache is running (if using XAMPP)
- [ ] CORS_ORIGIN in `.env` matches frontend URL
- [ ] Backend server was restarted after changing `.env`
- [ ] Browser cache was cleared
- [ ] WebSocket connection shows "connected" in console
- [ ] No errors in browser console
- [ ] No errors in backend terminal
- [ ] User is authenticated (check localStorage)
- [ ] Both users are members of the chat
- [ ] Network tab shows WebSocket connection

## Testing WebSocket

### Quick Test Script

Open browser console and run:

```javascript
// Check if CONFIG is loaded
console.log('CONFIG:', CONFIG);

// Check if socket is connected
console.log('Socket connected:', socket?.connected);

// Check current user
console.log('Current user:', getCurrentUser());

// Check current chat
console.log('Current chat ID:', currentChatId);

// Try to send a test message manually
if (socket && socket.connected && currentChatId) {
    socket.emit('send_message', {
        chatId: currentChatId,
        senderId: getCurrentUser().userId,
        messageType: 'text',
        content: 'Test message'
    });
}
```

### Backend WebSocket Test

Check backend logs when:
1. User logs in - should see "User X authenticated"
2. User opens chat - should see "User X joined chat Y"
3. User sends message - should see message being sent

## Still Not Working?

If messages still don't work after all steps:

1. **Check both browser consoles** (sender and receiver)
2. **Check backend terminal** for errors
3. **Verify database** has messages table with correct schema
4. **Test with sample data** users (alice_wonder, bob_builder)
5. **Try incognito/private window** to rule out extension issues

## Contact

If you've tried everything and it still doesn't work, gather this info:

- Backend console output
- Browser console errors (both sender and receiver)
- Network tab showing WebSocket connection
- Database query: `SELECT * FROM messages LIMIT 5`
- Backend `.env` file (hide sensitive data)
- Frontend `config.js` file
