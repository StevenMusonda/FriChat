# FriChat - Quick Reference Card

## 🚀 Quick Start

```bash
# 1. Setup Database
mysql -u root -p
CREATE DATABASE frichat;
USE frichat;
SOURCE database/schema.sql;
SOURCE database/sample_data.sql;

# 2. Install & Run Backend
cd backend
npm install
npm start

# 3. Open Frontend
http://localhost/FriChat
```

## 📁 Project Structure

```
FriChat/
├── backend/          # Node.js server
│   ├── config/       # Database config
│   ├── controllers/  # Business logic
│   ├── middleware/   # Auth, upload, etc.
│   ├── routes/       # API routes
│   ├── utils/        # Helper functions
│   └── server.js     # Main entry point
├── frontend/         # Client application
│   ├── css/          # Styles
│   ├── js/           # JavaScript modules
│   └── *.html        # Pages
└── database/         # SQL schemas
```

## 🔑 Environment Variables

```env
# Backend (.env)
PORT=3000
DB_TYPE=mysql
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=frichat
JWT_SECRET=your_secret_key
CORS_ORIGIN=http://localhost:8080
```

## 📡 API Endpoints

### Auth
```
POST   /api/auth/register     # Register user
POST   /api/auth/login        # Login user
POST   /api/auth/logout       # Logout user
GET    /api/auth/profile      # Get profile
PUT    /api/auth/profile      # Update profile
```

### Chats
```
GET    /api/chats                        # Get all chats
GET    /api/chats/:id                    # Get chat by ID
POST   /api/chats                        # Create chat
POST   /api/chats/:id/members            # Add member
DELETE /api/chats/:id/members/:userId    # Remove member
GET    /api/chats/search/users?query=    # Search users
```

### Messages
```
GET    /api/messages/chat/:chatId          # Get messages
POST   /api/messages                       # Send message
POST   /api/messages/upload                # Upload file
PATCH  /api/messages/:id/status            # Update status
POST   /api/messages/:id/reactions         # Add reaction
DELETE /api/messages/:id/reactions         # Remove reaction
```

## 🔌 WebSocket Events

### Emit (Client → Server)
```javascript
socket.emit('authenticate', { userId });
socket.emit('join_chat', { chatId, userId });
socket.emit('send_message', { chatId, senderId, messageType, content });
socket.emit('message_status', { messageId, status, userId });
socket.emit('add_reaction', { messageId, userId, emoji });
socket.emit('remove_reaction', { messageId, userId, emoji });
socket.emit('typing', { chatId, userId, username, isTyping });
```

### Listen (Server → Client)
```javascript
socket.on('new_message', (message) => {});
socket.on('message_status_update', (data) => {});
socket.on('reaction_added', (data) => {});
socket.on('reaction_removed', (data) => {});
socket.on('user_typing', (data) => {});
socket.on('user_status', (data) => {});
```

## 💾 Database Tables

```sql
users              # User accounts
chats              # Chat rooms
group_members      # Participants
messages           # All messages
files              # File metadata
message_reactions  # Emoji reactions
```

## 🎨 Frontend Modules

```javascript
// config.js - Configuration
CONFIG.API_BASE_URL
CONFIG.SOCKET_URL
CONFIG.ENDPOINTS

// auth.js - Authentication
login(username, password)
register(username, email, password, fullName)
logout()
getCurrentUser()
isAuthenticated()

// chat.js - Chat management
loadChats()
openChat(chatId)
createChat(chatType, chatName, participantIds)
searchUsers(query)

// messages.js - Messages
loadMessages(chatId)
sendTextMessage(chatId, content)
uploadFile(chatId, file)
toggleReaction(messageId, emoji)

// websocket.js - WebSocket
initializeWebSocket()
joinChat(chatId)
sendMessageViaSocket(chatId, messageType, content)
updateMessageStatusViaSocket(messageId, status)

// ui.js - UI interactions
initializeUI()
showNotification(message, type)
showLoading() / hideLoading()
```

## 🎯 Common Tasks

### Add a New API Endpoint
1. Create route in `backend/routes/`
2. Add controller method in `backend/controllers/`
3. Add validation in `backend/utils/validation.js`
4. Update frontend `js/config.js` with endpoint
5. Create frontend function to call endpoint

### Add a New Message Type
1. Update `message_type` enum in database schema
2. Add validation in `backend/utils/validation.js`
3. Update `messageController.js` to handle type
4. Add rendering logic in `frontend/js/messages.js`
5. Update UI to support new type

### Add a New WebSocket Event
1. Add event handler in `backend/server.js`
2. Add emit function in `frontend/js/websocket.js`
3. Register listener in `frontend/chat.html`
4. Update UI based on event

## 🐛 Debugging

### Backend
```bash
# Check logs
npm start

# Enable debug mode
NODE_ENV=development npm start
```

### Frontend
```javascript
// Browser console
console.log(getCurrentUser());
console.log(CONFIG);
console.log(socket);

// Check localStorage
localStorage.getItem('authToken');
localStorage.getItem('userData');
```

### Database
```sql
-- Check tables
SHOW TABLES;

-- View users
SELECT * FROM users;

-- View messages
SELECT * FROM message_details;

-- Check connections
SHOW PROCESSLIST;
```

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| Can't connect to DB | Check MySQL is running, verify credentials |
| Port 3000 in use | Change PORT in .env or kill process |
| CORS error | Update CORS_ORIGIN in .env |
| WebSocket won't connect | Check backend is running, verify SOCKET_URL |
| File upload fails | Check uploads directory exists, verify file size |
| Token expired | Login again, check JWT_EXPIRES_IN |

## 📊 Test Users

```
Username: alice_wonder   | Password: password123
Username: bob_builder    | Password: password123
Username: charlie_choco  | Password: password123
Username: diana_prince   | Password: password123
Username: eve_online     | Password: password123
```

## 🔐 Security Checklist

- [ ] Change JWT_SECRET in production
- [ ] Use HTTPS in production
- [ ] Set strong database password
- [ ] Configure firewall rules
- [ ] Enable rate limiting
- [ ] Review file upload limits
- [ ] Update CORS_ORIGIN for production
- [ ] Enable production logging

## 📦 Deployment

```bash
# Production build
cd backend
npm install --production
NODE_ENV=production npm start

# With PM2
pm2 start server.js --name frichat
pm2 save
pm2 startup
```

## 📚 Resources

- README.md - Complete documentation
- SETUP_GUIDE.md - Setup instructions
- FEATURES.md - Feature documentation
- PROJECT_SUMMARY.md - Project overview

## 🎓 Learning Path

1. **Beginner**: Study frontend HTML/CSS/JS
2. **Intermediate**: Understand backend API
3. **Advanced**: Explore WebSocket implementation
4. **Expert**: Optimize and scale

## 💡 Tips

- Use browser DevTools for debugging
- Check console for errors
- Test with multiple browsers/devices
- Use Postman for API testing
- Monitor database queries
- Keep dependencies updated
- Read error messages carefully
- Test edge cases

---

**Quick Reference v1.0** - FriChat Development Team
