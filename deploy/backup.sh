#!/usr/bin/env bash
# Nightly backup of the FriChat database and uploaded files. Keeps the last 14 days.
# Install:  sudo cp deploy/backup.sh /usr/local/sbin/frichat-backup && sudo chmod 700 /usr/local/sbin/frichat-backup
# Schedule: sudo crontab -e   and add:   30 2 * * * /usr/local/sbin/frichat-backup
# Run as root. Also copy the backups OFF this server (Hetzner Storage Box, rsync to another machine, ...),
# and keep a copy of backend/.env (especially TOTP_ENCRYPTION_KEY and JWT_SECRET) somewhere safe, apart from them.
set -euo pipefail

APP_DIR=/var/www/frichat/backend
BACKUP_DIR=/var/backups/frichat
DB_NAME=frichat
STAMP=$(date +%F_%H%M)

umask 077
mkdir -p "$BACKUP_DIR"

# Database (as the postgres system user, so no password is needed)
sudo -u postgres pg_dump --no-owner "$DB_NAME" | gzip > "$BACKUP_DIR/db_$STAMP.sql.gz"

# Uploaded files, plus the private folders (data exports, report evidence, quarantine)
tar -czf "$BACKUP_DIR/files_$STAMP.tar.gz" -C "$APP_DIR" uploads private

# Delete backups older than 14 days
find "$BACKUP_DIR" -type f \( -name 'db_*.sql.gz' -o -name 'files_*.tar.gz' \) -mtime +14 -delete

echo "Backup written to $BACKUP_DIR ($STAMP)"
