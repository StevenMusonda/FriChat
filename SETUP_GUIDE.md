# FriChat Setup Guide

## Quick Start (5 Minutes)

### 1. Database Setup (2 minutes)

**For MySQL:**
```bash
# Start MySQL (if using XAMPP, start MySQL from control panel)
# Open MySQL command line or phpMyAdmin

# Create database
CREATE DATABASE frichat;

# Import schema
mysql -u root -p frichat < database/schema.sql

# Optional: Import sample data
mysql -u root -p frichat < database/sample_data.sql
```

**For PostgreSQL:**
```bash
# Start PostgreSQL service
# Open psql command line

# Create database
CREATE DATABASE frichat;

# Import schema
psql -U postgres -d frichat -f database/schema_postgresql.sql

# Optional: Import sample data
psql -U postgres -d frichat -f database/sample_data.sql
```

### 2. Backend Setup (2 minutes)

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Copy environment file
copy .env.example .env

# Edit .env and configure:
# - Database credentials
# - JWT secret (change to a random string)
# - Port (default 3000)

# Start server
npm start
```

You should see:
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

### 3. Frontend Setup (1 minute)

**Option A: Using XAMPP (Recommended)**
1. Ensure Apache is running in XAMPP Control Panel
2. Open browser: `http://localhost/FriChat`

**Option B: Direct file access**
1. Open `frontend/login.html` in your browser
2. Update `frontend/js/config.js` if needed:
```javascript
const CONFIG = {
    API_BASE_URL: 'http://localhost:3000/api',
    SOCKET_URL: 'http://localhost:3000',
};
```

### 4. Test the Application

**Using Sample Data:**
1. Go to login page
2. Use credentials:
   - Username: `alice_wonder`
   - Password: `password123`
3. Start chatting!

**Creating New Account:**
1. Click "Sign up" on login page
2. Fill in registration form
3. Start chatting!

## Detailed Configuration

### Environment Variables (.env)

```env
# Server Configuration
PORT=3000                    # Backend server port
NODE_ENV=development        # Environment (development/production)

# Database Configuration
DB_TYPE=mysql               # Database type (mysql/postgresql)
DB_HOST=localhost           # Database host
DB_PORT=3306                # Database port (3306 for MySQL, 5432 for PostgreSQL)
DB_USER=root                # Database username
DB_PASSWORD=                # Database password (empty for XAMPP MySQL by default)
DB_NAME=frichat             # Database name

# JWT Configuration
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
JWT_EXPIRES_IN=7d           # Token expiration (7 days)

# File Upload Configuration
MAX_FILE_SIZE=104857600     # 100MB in bytes
UPLOAD_PATH=./uploads       # Upload directory

# Allowed File Types
ALLOWED_IMAGE_TYPES=image/jpeg,image/png,image/gif,image/webp
ALLOWED_VIDEO_TYPES=video/mp4,video/webm,video/quicktime
ALLOWED_FILE_TYPES=application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip,application/x-zip-compressed

# CORS Configuration
CORS_ORIGIN=http://localhost:8080   # Frontend URL
```

### Frontend Configuration (frontend/js/config.js)

```javascript
const CONFIG = {
    API_BASE_URL: 'http://localhost:3000/api',  // Backend API URL
    SOCKET_URL: 'http://localhost:3000',        // WebSocket URL
    
    // ... rest of configuration
};
```

## Common Issues & Solutions

### Issue: "Database connection failed"
**Solution:**
- Check if MySQL/PostgreSQL is running
- Verify credentials in `.env`
- Ensure database `frichat` exists
- Check if schema is imported

### Issue: "Port 3000 already in use"
**Solution:**
- Change PORT in `.env` to another port (e.g., 3001)
- Or stop the process using port 3000

### Issue: "CORS error in browser console"
**Solution:**
- Update CORS_ORIGIN in backend `.env`
- Restart backend server
- Clear browser cache

### Issue: "Cannot find module"
**Solution:**
```bash
cd backend
rm -rf node_modules
npm install
```

### Issue: "File upload fails"
**Solution:**
- Check if `backend/uploads` directory exists
- Verify MAX_FILE_SIZE in `.env`
- Check file type is allowed
- Ensure directory has write permissions

### Issue: "WebSocket won't connect"
**Solution:**
- Verify backend is running
- Check SOCKET_URL in `frontend/js/config.js`
- Look for errors in browser console
- Check if firewall is blocking WebSocket

## Testing Checklist

- [ ] Backend server starts without errors
- [ ] Database connection successful
- [ ] Can register new user
- [ ] Can login with credentials
- [ ] Can create direct chat
- [ ] Can create group chat
- [ ] Can send text message
- [ ] Can upload image
- [ ] Can upload video
- [ ] Can upload file
- [ ] Can add emoji reaction
- [ ] Can see typing indicator
- [ ] Can see message status (sent/delivered/read)
- [ ] Theme toggle works
- [ ] Can logout
- [ ] WebSocket reconnects after disconnect

## Production Deployment

### Security Checklist for Production:

1. **Environment Variables:**
   - [ ] Change JWT_SECRET to strong random value
   - [ ] Set NODE_ENV=production
   - [ ] Use strong database password
   - [ ] Update CORS_ORIGIN to production domain

2. **HTTPS:**
   - [ ] Configure SSL certificate
   - [ ] Update all URLs to use HTTPS
   - [ ] Enable secure cookies

3. **Database:**
   - [ ] Regular backups
   - [ ] Secure credentials
   - [ ] Limit database user permissions

4. **File Uploads:**
   - [ ] Configure proper file size limits
   - [ ] Validate file types strictly
   - [ ] Consider cloud storage (AWS S3, etc.)

5. **Server:**
   - [ ] Use process manager (PM2, Forever)
   - [ ] Set up logging
   - [ ] Configure rate limiting
   - [ ] Enable compression

### Recommended Production Stack:

- **Web Server:** Nginx (reverse proxy)
- **Process Manager:** PM2
- **Database:** MySQL 8+ or PostgreSQL 13+
- **SSL:** Let's Encrypt
- **Hosting:** VPS (DigitalOcean, Linode, AWS EC2)

### PM2 Setup:

```bash
# Install PM2
npm install -g pm2

# Start backend with PM2
cd backend
pm2 start server.js --name frichat-backend

# Save PM2 configuration
pm2 save

# Setup PM2 startup script
pm2 startup
```

## Advanced Configuration

### Custom Port:

**Backend (.env):**
```env
PORT=8000
```

**Frontend (js/config.js):**
```javascript
API_BASE_URL: 'http://localhost:8000/api'
SOCKET_URL: 'http://localhost:8000'
```

### Multiple Instances:

Run multiple backend instances behind a load balancer for high availability.

### Database Optimization:

```sql
-- Add indexes for better performance (already included in schema)
-- Monitor slow queries
-- Regular maintenance and optimization
```

## Development Tips

### Hot Reload:

```bash
# Backend with nodemon
cd backend
npm run dev
```

### Debugging:

**Backend:**
```bash
# Enable debug logs
NODE_ENV=development npm start
```

**Frontend:**
- Open browser DevTools (F12)
- Check Console tab for JavaScript errors
- Check Network tab for API requests
- Check Application tab for localStorage

### Database Reset:

```bash
# Drop and recreate database
DROP DATABASE frichat;
CREATE DATABASE frichat;

# Re-import schema
mysql -u root -p frichat < database/schema.sql
mysql -u root -p frichat < database/sample_data.sql
```

## Need Help?

1. Check the main README.md for detailed documentation
2. Review error messages in console/terminal
3. Check browser DevTools console
4. Verify all configuration files
5. Ensure all dependencies are installed

---

**Happy Chatting with FriChat! 🎉**
