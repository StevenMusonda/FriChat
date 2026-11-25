# Deploying FriChat on a Hetzner server (frichat.online)

One server runs everything: PostgreSQL (already installed), the Node backend (systemd), and Caddy, which serves the
frontend files, forwards `/api`, `/socket.io` and `/uploads` to Node, and handles HTTPS.

```
Browser --https--> Caddy :443 --+--> /api, /socket.io, /uploads --> Node :3000 --> PostgreSQL :5432 (localhost)
                                +--> everything else --> /var/www/frichat/frontend (static files)
```

Run the commands on the server over SSH. `$` lines are shell commands.

## 1. DNS and firewall

1. At your domain registrar, add an **A record** `frichat.online` -> your server's IPv4 address (and an **AAAA** record for IPv6 if you use it). Wait until `ping frichat.online` shows the server's IP.
2. Open only SSH, HTTP and HTTPS. If you use Hetzner's Cloud Firewall, allow TCP 22, 80, 443 (add UDP/TCP 3478 later only if you run coturn). On the server:
   ```
   $ sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
   ```
   Port 3000 (Node) and 5432 (PostgreSQL) must NOT be open to the internet.

## 2. Check what already runs on this server

The server has a hostname of its own (`igbv-server`), so make sure nothing else uses ports 80/443:

```
$ sudo ss -ltnp | grep -E ':(80|443)\s'
$ node --version        # FriChat needs Node 20 or newer (you use 22 locally)
```

- Nothing on 80/443: use Caddy (step 7A).
- nginx already there (the case on igbv-server): keep it and add FriChat as one more site, with `deploy/nginx-frichat.conf` (step 7B). Don't install Caddy then.

## 3. Install Node 22 next to the old Node

FriChat needs Node 20 or newer. This server has Node 12, and other things on it may depend on that, so do NOT upgrade the system Node. Install Node 22 in its own folder; only FriChat uses it:

```
$ sudo apt install -y git xz-utils curl
$ ARCH=$( [ "$(uname -m)" = aarch64 ] && echo arm64 || echo x64 )
$ cd /tmp
$ FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep "linux-$ARCH.tar.xz" | awk '{print $2}')
$ curl -fsSLO https://nodejs.org/dist/latest-v22.x/$FILE
$ sudo mkdir -p /opt/node22 && sudo tar -xJf $FILE -C /opt/node22 --strip-components=1
$ /opt/node22/bin/node --version        # should print v22.x.x
```

From here on, every `node` / `npm` command for FriChat is run with `PATH=/opt/node22/bin:/usr/bin:/bin` in front, as shown in the steps below (`sudo -u frichat env PATH=... npm ...`). `node --version` on its own still shows the old Node 12; that is fine.

## 4. Put the code on the server

Create an unprivileged user and the folder, then copy the project in:

```
$ sudo adduser --system --group --home /var/www/frichat frichat
$ sudo mkdir -p /var/www/frichat && sudo chown frichat:frichat /var/www/frichat
```

Option A, from GitHub (use your own repository URL; for a private repo use a deploy key or token):
```
$ sudo -u frichat git clone https://github.com/YOUR_USER/YOUR_REPO.git /var/www/frichat
```
Option B, from your Windows PC (PowerShell, in the folder that contains `FriChat`; skips node_modules and your local .env):
```
scp -r FriChat\backend FriChat\frontend FriChat\database FriChat\deploy root@SERVER_IP:/tmp/frichat-upload/
```
then on the server: `sudo cp -r /tmp/frichat-upload/* /var/www/frichat/ && sudo chown -R frichat:frichat /var/www/frichat`
and delete `/var/www/frichat/backend/node_modules` and `.env` if they came along.

Install the dependencies (there is no lockfile in git, so `npm install`):
```
$ cd /var/www/frichat/backend && sudo -u frichat env PATH=/opt/node22/bin:/usr/bin:/bin npm install --omit=dev
```
`sharp` (image re-encoding, avatars) is an optional dependency; check `sudo -u frichat env PATH=/opt/node22/bin:/usr/bin:/bin node -e "require('sharp')"` prints nothing.
Without it, photo uploads and profile photos are refused.

## 5. Database

PostgreSQL 14 is already running on localhost. Create a separate user and database; this does not touch any other database on the server:

```
$ sudo -u postgres psql -c "CREATE USER frichat WITH PASSWORD 'CHOOSE_A_STRONG_PASSWORD';"
$ sudo -u postgres psql -c "CREATE DATABASE frichat OWNER frichat;"
$ cd /var/www/frichat
$ PGPASSWORD='CHOOSE_A_STRONG_PASSWORD' psql -h localhost -U frichat -d frichat -f database/schema_postgresql.sql
```

Loading the schema as the `frichat` user makes it the owner of every table, so no extra GRANTs are needed.

**Warning:** `schema_postgresql.sql` starts with `DROP TABLE IF EXISTS ...` for every table. Run it once, on this brand-new empty `frichat` database, and never again on a database with real data (later updates use the small migration files, step 10).

`schema_postgresql.sql` already contains everything the `add_*_postgresql.sql` migrations create, so a new server needs only that one file. Do NOT load `sample_data.sql` in production.
(If you get a "database frichat already exists" error, someone created it earlier: `sudo -u postgres psql -l` to look.)

## 6. Configure `.env`

```
$ sudo -u frichat cp /var/www/frichat/deploy/env.production.example /var/www/frichat/backend/.env
$ sudo -u frichat nano /var/www/frichat/backend/.env
```

Fill in every `CHANGE_ME`:

- `DB_PASSWORD`: the password from step 5.
- `JWT_SECRET`: `openssl rand -base64 48`
- `TOTP_ENCRYPTION_KEY`: `/opt/node22/bin/node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- SMTP settings (see the note in the file; without them signup verification and password resets don't reach users).
- Push keys: `cd /var/www/frichat/backend && sudo -u frichat env PATH=/opt/node22/bin:/usr/bin:/bin npm run vapid:generate`, paste both keys. Never regenerate them later.

If you use Brevo for email: add the server's public IPv4 address (`curl -4 ifconfig.me`) under Brevo > Security > Authorised IPs, and authenticate the domain (Brevo > Senders, Domains > Domains), or Brevo rejects the login with `525 Unauthorized IP address`.

Then lock the file down: `sudo chmod 600 /var/www/frichat/backend/.env`.

## 7. Start the backend and the web server

Backend:
```
$ sudo cp /var/www/frichat/deploy/frichat.service /etc/systemd/system/frichat.service
$ sudo systemctl daemon-reload && sudo systemctl enable --now frichat
$ sudo systemctl status frichat          # should say active (running)
$ curl http://127.0.0.1:3000/api/health  # {"success":true,...}
```
If it fails, read `journalctl -u frichat -n 50 --no-pager` (usually a wrong `.env` value or a database login error).

### 7A. Caddy (only if nothing else uses ports 80/443)
```
$ sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
$ sudo apt update && sudo apt install -y caddy
$ sudo cp /var/www/frichat/deploy/Caddyfile /etc/caddy/Caddyfile
$ sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
$ sudo chmod o+x /var/www/frichat && sudo chmod -R o+rX /var/www/frichat/frontend   # Caddy must be able to read the pages
$ sudo systemctl reload caddy
```
(7A) Caddy requests the HTTPS certificate on its own the first time someone opens the site (DNS from step 1 must already point here).

### 7B. nginx (this server: nginx already runs on port 80)

FriChat is added as one more site. Your existing sites are not changed, because nginx picks the site by its `server_name`.

```
$ sudo apt install -y certbot python3-certbot-nginx
$ sudo chmod o+x /var/www/frichat && sudo chmod -R o+rX /var/www/frichat/frontend   # nginx must be able to read the pages
$ sudo cp /var/www/frichat/deploy/nginx-frichat.conf /etc/nginx/sites-available/frichat
$ sudo ln -s /etc/nginx/sites-available/frichat /etc/nginx/sites-enabled/frichat
$ sudo nginx -t                          # must say "syntax is ok" and "test is successful"
$ sudo systemctl reload nginx
$ sudo certbot --nginx -d frichat.online # answer the questions; choose to redirect HTTP to HTTPS
```
The DNS A record from step 1 must already point to the server, or certbot fails. If `nginx -t` shows an error, fix it before reloading; your other sites keep running until you reload.
After certbot, `sudo nginx -t && sudo systemctl reload nginx` once more.


## 8. Check that it works

1. `curl https://frichat.online/api/health` returns `{"success":true,...}`.
2. Open https://frichat.online/ in a browser, sign up, log in. The padlock is shown; no mixed-content errors in the browser console.
3. Send a message from two browsers (or one normal and one private window): it appears instantly in both (WebSocket works).
4. Upload a photo and a short video: they show in the chat.
5. From your own computer (not the server), `curl -m 5 http://SERVER_IP:3000/api/health` must fail or time out (port 3000 closed).
6. Make yourself an admin: `cd /var/www/frichat/backend && sudo -u frichat env PATH=/opt/node22/bin:/usr/bin:/bin node scripts/set-admin.js YOUR_USERNAME`
7. Request a password reset with a real email address and check that the mail arrives.

## 9. Backups (do this the same day)

```
$ sudo cp /var/www/frichat/deploy/backup.sh /usr/local/sbin/frichat-backup && sudo chmod 700 /usr/local/sbin/frichat-backup
$ sudo /usr/local/sbin/frichat-backup            # test run
$ sudo crontab -e                                # add:  30 2 * * * /usr/local/sbin/frichat-backup
```
Also turn on Hetzner server backups/snapshots, copy `/var/backups/frichat` off the server regularly, and keep a copy of `backend/.env` somewhere safe (lose `TOTP_ENCRYPTION_KEY` and everyone's authenticator codes stop working).

## 10. Updating later

```
$ cd /var/www/frichat && sudo -u frichat git pull
$ cd backend && sudo -u frichat env PATH=/opt/node22/bin:/usr/bin:/bin npm install --omit=dev
# run any new database migration listed in FEATURES_SETUP.md for that release, e.g.
$ PGPASSWORD='YOUR_DB_PASSWORD' psql -h localhost -U frichat -d frichat -f /var/www/frichat/database/NEW_MIGRATION_postgresql.sql
$ sudo systemctl restart frichat
```
Frontend changes need no restart (Caddy serves the files straight from disk). Bump `CACHE_VERSION` in `frontend/sw.js` when you change HTML/CSS/JS so installed apps pick up the new files.

## 11. Optional: calls on mobile networks (coturn)

Calls work with the public STUN server on most connections. For users behind strict NAT or mobile data, run coturn on this server and set `TURN_URL` and `TURN_SECRET` in `.env`; the steps are in `FEATURES_SETUP.md`, Phase 11. Open TCP+UDP 3478 and the relay port range in the firewall, and restart `frichat` afterwards.

## Common problems

| Symptom | Cause |
| --- | --- |
| Page loads but login fails with a network error | `CORS_ORIGIN` isn't exactly `https://frichat.online`, or `frontend/js/config.js` wasn't updated (it must use the page's own origin) |
| Chat opens but messages only appear after a reload | WebSocket blocked: `/socket.io/*` isn't forwarded to Node (check the Caddyfile or the nginx `Upgrade` headers) |
| Everyone shares one rate limit / device list shows 127.0.0.1 | `TRUST_PROXY=1` missing in `.env` |
| Large video upload fails | proxy body-size limit (`client_max_body_size` in nginx; the Caddyfile already allows 110 MB) |
| "Calls need a secure connection" | the site is being opened over http, or the certificate isn't issued yet |
| No verification / reset emails | SMTP not set, or the provider blocks the sender; check `journalctl -u frichat`. Log says `525 5.7.1 Unauthorized IP address`: Brevo blocks unknown IPs, add the server's public IPv4 (`curl -4 ifconfig.me`) under Brevo > Security > Authorised IPs |
| `502 Bad Gateway` | the backend isn't running: `systemctl status frichat` |
