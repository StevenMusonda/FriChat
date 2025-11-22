# FriChat - Real-Time Chat Application

A full-stack, real-time chat web application built with HTML, CSS, JavaScript, Node.js, Express, Socket.IO, and SQL (MySQL/PostgreSQL).

## Features

### 🔐 User Authentication
- Secure user registration and login
- Password hashing with bcrypt
- JWT-based authentication
- Session management

### 💬 Real-Time Messaging
- Instant message delivery via WebSocket (Socket.IO)
- Support for multiple message types:
  - Text messages
  - Images (JPEG, PNG, GIF, WebP)
  - Videos (MP4, WebM, up to 6 minutes)
  - Files (PDF, DOCX, ZIP, etc.)
- Message status indicators (sent, delivered, read)
- Emoji reactions on messages
- Typing indicators

### 👥 Group Chats
- Create group chats with multiple participants
- Admin controls (add/remove members)
- Direct messaging (1-on-1 chats)
- Real-time message broadcasting

### 🎨 Modern UI
- Clean, responsive design
- Light and dark theme support
- Modern messenger-like layout
- File upload previews
- Emoji picker
- Mobile-responsive

### 🔒 Security
- Input validation and sanitization
- XSS protection
- SQL injection prevention
- File type restrictions
- Secure file uploads
- Access control on chats

## Project Structure

```
FriChat/
├── backend/
│   ├── config/
│   │   └── database.js          # Database configuration
│   ├── controllers/
│   │   ├── authController.js    # Authentication logic
│   │   ├── chatController.js    # Chat management
│   │   └── messageController.js # Message handling
│   ├── middleware/
│   │   ├── auth.js              # JWT authentication
│   │   └── upload.js            # File upload handling
│   ├── routes/
│   │   ├── auth.js              # Auth routes
│   │   ├── chats.js             # Chat routes
│   │   └── messages.js          # Message routes
│   ├── utils/
│   │   └── validation.js        # Input validation
│   ├── uploads/                 # File storage directory
│   ├── server.js                # Main server file
│   ├── package.json             # Dependencies
│   └── .env.example             # Environment variables template
├── frontend/
│   ├── css/
│   │   └── style.css            # Application styles
│   ├── js/
│   │   ├── config.js            # API configuration
│   │   ├── auth.js              # Authentication module
│   │   ├── chat.js              # Chat management
│   │   ├── messages.js          # Message handling
│   │   ├── websocket.js         # WebSocket connection
│   │   └── ui.js                # UI interactions
│   ├── login.html               # Login page
│   ├── signup.html              # Registration page
│   └── chat.html                # Main chat interface
├── database/
│   ├── schema.sql               # MySQL schema
│   ├── schema_postgresql.sql   # PostgreSQL schema
│   └── sample_data.sql          # Test data
├── index.html                   # Entry point
└── README.md                    # This file
```

## Installation & Setup

### Prerequisites

- **Node.js** (v14 or higher)
- **npm** or **yarn**
- **MySQL** (5.7+) or **PostgreSQL** (10+)
- **XAMPP** (optional, for local development with Apache)

### Step 1: Clone or Extract the Project

If you're reading this, you probably already have the project files. If not:

```bash
cd c:\xampp\htdocs\FriChat
```

### Step 2: Database Setup

#### For MySQL:

1. Create a database:
```sql
CREATE DATABASE frichat;
```

2. Import the schema:
```bash
mysql -u root -p frichat < database/schema.sql
```

3. (Optional) Import sample data:
```bash
mysql -u root -p frichat < database/sample_data.sql
```

#### For PostgreSQL:

1. Create a database:
```sql
CREATE DATABASE frichat;
```

2. Import the schema:
```bash
psql -U postgres -d frichat -f database/schema_postgresql.sql
```

3. (Optional) Import sample data:
```bash
psql -U postgres -d frichat -f database/sample_data.sql
```

### Step 3: Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file from example:
```bash
copy .env.example .env
```

4. Edit `.env` file with your configuration:
```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Database Configuration (MySQL)
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=frichat

# Or for PostgreSQL:
# DB_TYPE=postgresql
# DB_HOST=localhost
# DB_PORT=5432
# DB_USER=postgres
# DB_PASSWORD=your_password
# DB_NAME=frichat

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
JWT_EXPIRES_IN=7d

# File Upload Configuration
MAX_FILE_SIZE=104857600
UPLOAD_PATH=./uploads

# CORS Configuration
CORS_ORIGIN=http://localhost:8080
```

5. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

The server should start on `http://localhost:3000`

### Step 4: Frontend Setup

The frontend is already configured to work with the backend.

1. If using XAMPP, make sure Apache is running
2. Open your browser and navigate to:
   - `http://localhost/FriChat` (if using XAMPP)
   - Or open `frontend/login.html` directly in your browser

3. Update API endpoints if needed in `frontend/js/config.js`:
```javascript
const CONFIG = {
    API_BASE_URL: 'http://localhost:3000/api',
    SOCKET_URL: 'http://localhost:3000',
    // ...
};
```

## Usage

### Creating an Account

1. Navigate to the signup page
2. Enter your details:
   - Username (3-50 characters, letters, numbers, underscore only)
   - Email
   - Full Name (optional)
   - Password (minimum 6 characters)
3. Click "Sign Up"

### Logging In

1. Navigate to the login page
2. Enter your username or email and password
3. Click "Login"

### Sample Users (if you imported sample data)

All sample users have the password: `password123`

- Username: `alice_wonder`, Email: `alice@example.com`
- Username: `bob_builder`, Email: `bob@example.com`
- Username: `charlie_choco`, Email: `charlie@example.com`
- Username: `diana_prince`, Email: `diana@example.com`
- Username: `eve_online`, Email: `eve@example.com`

### Starting a Chat

1. Click the "New Chat" button (message icon in sidebar)
2. Choose chat type:
   - **Direct Chat**: One-on-one conversation
   - **Group Chat**: Multiple participants (requires a group name)
3. Search for users and select them
4. Click "Create Chat"

### Sending Messages

1. Select a chat from the sidebar
2. Type your message in the input field at the bottom
3. Press Enter or click the send button

### Sending Files

1. Click the attach button (paperclip icon)
2. Select one or more files:
   - Images: JPEG, PNG, GIF, WebP
   - Videos: MP4, WebM (up to 6 minutes recommended)
   - Documents: PDF, DOCX, ZIP, etc.
3. Files will be uploaded and sent automatically

### Adding Reactions

1. Hover over a message
2. Click the emoji button in the message footer
3. Select an emoji from the picker
4. Click again to remove your reaction

### Theme Toggle

Click the sun/moon icon in the sidebar header to switch between light and dark themes.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user (requires auth)
- `GET /api/auth/profile` - Get user profile (requires auth)
- `PUT /api/auth/profile` - Update user profile (requires auth)

### Chats
- `GET /api/chats` - Get all user chats (requires auth)
- `GET /api/chats/:chatId` - Get chat details (requires auth)
- `POST /api/chats` - Create new chat (requires auth)
- `POST /api/chats/:chatId/members` - Add member to group (requires auth)
- `DELETE /api/chats/:chatId/members/:userId` - Remove member (requires auth)
- `GET /api/chats/search/users` - Search users (requires auth)

### Messages
- `GET /api/messages/chat/:chatId` - Get messages for chat (requires auth)
- `POST /api/messages` - Send text message (requires auth)
- `POST /api/messages/upload` - Upload file message (requires auth)
- `PATCH /api/messages/:messageId/status` - Update message status (requires auth)
- `POST /api/messages/:messageId/reactions` - Add reaction (requires auth)
- `DELETE /api/messages/:messageId/reactions` - Remove reaction (requires auth)

## WebSocket Events

### Client to Server
- `authenticate` - Authenticate user with WebSocket
- `join_chat` - Join a chat room
- `send_message` - Send a message
- `message_status` - Update message status
- `add_reaction` - Add reaction to message
- `remove_reaction` - Remove reaction from message
- `typing` - Send typing indicator

### Server to Client
- `new_message` - Receive new message
- `message_status_update` - Message status changed
- `reaction_added` - Reaction added to message
- `reaction_removed` - Reaction removed from message
- `user_typing` - User is typing
- `user_status` - User status changed (online/offline)

## Troubleshooting

### Backend won't start
- Check if the port 3000 is already in use
- Verify database credentials in `.env`
- Ensure database is running
- Check if all npm packages are installed

### Database connection errors
- Verify database is running
- Check credentials in `.env`
- Ensure database exists
- Check if schema is imported correctly

### Frontend can't connect to backend
- Verify backend server is running
- Check CORS settings in backend `.env`
- Update API URLs in `frontend/js/config.js`
- Check browser console for errors

### File uploads failing
- Check MAX_FILE_SIZE in `.env`
- Verify `uploads` directory exists and is writable
- Check file type restrictions
- Ensure file doesn't exceed size limit

### WebSocket not connecting
- Verify backend server is running
- Check SOCKET_URL in `frontend/js/config.js`
- Check browser console for WebSocket errors
- Verify firewall isn't blocking WebSocket connections

## Security Notes

### Important Security Considerations:

1. **Change JWT Secret**: Update `JWT_SECRET` in `.env` with a strong, random value
2. **Use HTTPS**: In production, always use HTTPS
3. **Secure Database**: Use strong database passwords
4. **Environment Variables**: Never commit `.env` file to version control
5. **File Uploads**: Validate file types and sizes on both client and server
6. **Input Validation**: All user inputs are validated and sanitized
7. **SQL Injection**: Prepared statements are used throughout
8. **XSS Protection**: HTML is escaped in message content

## Development

### Running in Development Mode

Backend with auto-reload:
```bash
cd backend
npm run dev
```

### Project Dependencies

#### Backend:
- express - Web framework
- socket.io - WebSocket library
- mysql2 / pg - Database drivers
- bcryptjs - Password hashing
- jsonwebtoken - JWT authentication
- multer - File upload handling
- cors - CORS middleware
- dotenv - Environment variables
- helmet - Security headers
- express-validator - Input validation

#### Frontend:
- Socket.IO client (CDN)
- Vanilla JavaScript (no framework)
- CSS3 with CSS variables

## Performance Optimization

- Messages are paginated (50 per load)
- File uploads are validated before sending
- WebSocket for real-time communication reduces server load
- CSS variables for efficient theming
- Lazy loading of chat messages
- Optimized database queries with indexes

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers (iOS Safari 14+, Chrome Android 90+)

## License

This project is provided as-is for educational and personal use.

## Support

For issues, questions, or contributions, please refer to the project documentation or contact the development team.

---

**FriChat** - Built with ❤️ using modern web technologies
