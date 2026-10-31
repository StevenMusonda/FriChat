/**
 * The packages the security audit moved, exercised for real rather than stubbed: the mailer through
 * the real nodemailer SMTP client against a stub server on a local port, avatars through the real
 * sharp on JPEG and PNG, and express.json() against a request that used to crash the process.
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { setupFakeDb } = require('./helpers/fakeDb');

const BACKEND = path.join(__dirname, '..');
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Just enough SMTP to take a message. Refuses recipients at the "refused" domain.
 */
function startSmtpStub() {
    const stub = { messages: [], authLines: [], port: null, server: null };

    stub.server = net.createServer((socket) => {
        let pending = '';
        let inData = false;
        let data = '';
        let envelope = { from: null, to: [] };

        socket.on('error', () => {});
        socket.write('220 stub ESMTP\r\n');
        socket.on('data', (chunk) => {
            pending += chunk.toString('utf8');
            while (true) {
                if (inData) {
                    const end = pending.indexOf('\r\n.\r\n');
                    if (end === -1) return;
                    data += pending.slice(0, end);
                    pending = pending.slice(end + 5);
                    stub.messages.push({ ...envelope, data });
                    inData = false;
                    data = '';
                    envelope = { from: null, to: [] };
                    socket.write('250 queued\r\n');
                    continue;
                }

                const lineEnd = pending.indexOf('\r\n');
                if (lineEnd === -1) return;
                const line = pending.slice(0, lineEnd);
                pending = pending.slice(lineEnd + 2);

                if (/^EHLO /i.test(line)) socket.write('250-stub\r\n250 AUTH PLAIN\r\n');
                else if (/^AUTH /i.test(line)) {
                    stub.authLines.push(line);
                    socket.write('235 ok\r\n');
                } else if (/^MAIL FROM:/i.test(line)) {
                    envelope.from = /<(.*?)>/.exec(line)[1];
                    socket.write('250 ok\r\n');
                } else if (/^RCPT TO:/i.test(line)) {
                    const to = /<(.*?)>/.exec(line)[1];
                    if (to.endsWith('@refused.example.test')) {
                        socket.write('550 no such user\r\n');
                    } else {
                        envelope.to.push(to);
                        socket.write('250 ok\r\n');
                    }
                } else if (/^DATA/i.test(line)) {
                    inData = true;
                    socket.write('354 go\r\n');
                } else if (/^QUIT/i.test(line)) {
                    socket.end('221 bye\r\n');
                    return;
                } else socket.write('250 ok\r\n');
            }
        });
    });

    return new Promise((resolve) => {
        stub.server.listen(0, '127.0.0.1', () => {
            stub.port = stub.server.address().port;
            resolve(stub);
        });
    });
}

function decodeQuotedPrintable(text) {
    return text
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

describe('mailer through the real nodemailer SMTP client', () => {
    const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'];
    let stub;
    let savedEnv;

    function loadMailer(env) {
        Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(stub.port) }, env);
        delete require.cache[require.resolve('../utils/mailer')];
        return require('../utils/mailer');
    }

    before(async () => {
        savedEnv = Object.fromEntries(SMTP_ENV.map(name => [name, process.env[name]]));
        stub = await startSmtpStub();
    });

    beforeEach(() => {
        SMTP_ENV.forEach((name) => { delete process.env[name]; });
        stub.messages.length = 0;
        stub.authLines.length = 0;
    });

    after(() => {
        stub.server.close();
        SMTP_ENV.forEach((name) => {
            if (savedEnv[name] === undefined) delete process.env[name];
            else process.env[name] = savedEnv[name];
        });
        delete require.cache[require.resolve('../utils/mailer')];
    });

    test('a password reset arrives with the MAIL_FROM display name, the link and escaped HTML', async () => {
        const mailer = loadMailer({ SMTP_USER: 'relay', SMTP_PASSWORD: 'secret', MAIL_FROM: 'FriChat <no-reply@example.test>' });
        await mailer.sendPasswordResetEmail('alice@example.test', '<b>alice</b>', 'https://chat.example.test/reset/abc123', 30);

        assert.equal(stub.messages.length, 1);
        const [message] = stub.messages;
        assert.equal(message.from, 'no-reply@example.test');
        assert.deepEqual(message.to, ['alice@example.test']);

        const decoded = decodeQuotedPrintable(message.data);
        assert.match(decoded, /^From: FriChat <no-reply@example\.test>$/m);
        assert.match(decoded, /^To: alice@example\.test$/m);
        assert.match(decoded, /^Subject: Reset your FriChat password$/m);
        assert.match(decoded, /multipart\/alternative/);
        assert.match(decoded, /href="https:\/\/chat\.example\.test\/reset\/abc123"/);
        assert.ok(decoded.includes('&lt;b&gt;alice&lt;/b&gt;'), 'the username is escaped in the HTML part');

        assert.equal(stub.authLines.length, 1);
        assert.equal(Buffer.from(stub.authLines[0].split(' ')[2], 'base64').toString(), '\0relay\0secret');
    });

    test('verification and security emails go out; without SMTP_USER no AUTH is sent and the sender is MAIL_FROM', async () => {
        const mailer = loadMailer({ MAIL_FROM: 'no-reply@example.test' });
        await mailer.sendVerificationEmail('bob@example.test', 'bob', 'https://chat.example.test/verify/xyz', 24);
        await mailer.sendSecurityEmail('bob@example.test', 'bob', 'New sign-in', ['A new device signed in.', 'Was this you?']);

        assert.equal(stub.authLines.length, 0);
        assert.equal(stub.messages.length, 2);
        assert.match(stub.messages[0].data, /^Subject: Verify your FriChat email address$/m);
        assert.match(stub.messages[1].data, /^Subject: New sign-in$/m);
        assert.ok(decodeQuotedPrintable(stub.messages[1].data).includes('<p>Was this you?</p>'));
    });

    test('a line break in a subject can\'t add a header or a recipient', async () => {
        const mailer = loadMailer({ MAIL_FROM: 'no-reply@example.test' });
        await mailer.sendSecurityEmail('carol@example.test', 'carol', 'Hello\r\nBcc: evil@example.test', ['Body']);

        assert.deepEqual(stub.messages[0].to, ['carol@example.test']);
        assert.doesNotMatch(stub.messages[0].data, /^Bcc:/mi);
    });

    test('a refused recipient rejects, so callers see the failure', async () => {
        const mailer = loadMailer({ MAIL_FROM: 'no-reply@example.test' });
        await assert.rejects(
            mailer.sendMail({ to: 'nobody@refused.example.test', subject: 'x', text: 'y' }),
            (error) => error.code === 'EENVELOPE' && error.responseCode === 550
        );
        assert.equal(stub.messages.length, 0);
    });

    test('without SMTP_HOST nothing is sent and the mail is logged', async () => {
        delete require.cache[require.resolve('../utils/mailer')];
        const mailer = require('../utils/mailer');
        const log = console.log;
        const lines = [];
        console.log = (line) => lines.push(line);
        try {
            await mailer.sendMail({ to: 'a@example.test', subject: 'Hi', text: 'Body' });
        } finally {
            console.log = log;
        }
        assert.equal(stub.messages.length, 0);
        assert.match(lines.join('\n'), /SMTP not configured/);
    });
});

describe('avatars through the real sharp', () => {
    let tmp;
    let savedUploadPath;
    let avatars;
    let groupAvatars;

    // Left half red, right half blue, tagged to display turned 90 degrees clockwise
    const rotatedJpeg = () => sharp({ create: { width: 640, height: 480, channels: 3, background: '#ff0000' } })
        .composite([{
            input: { create: { width: 320, height: 480, channels: 3, background: '#0000ff' } },
            left: 320,
            top: 0
        }])
        .withExif({ IFD0: { Copyright: 'private-marker' } })
        .withMetadata({ orientation: 6 })
        .jpeg({ quality: 90 })
        .toBuffer();

    const translucentPng = () => sharp({ create: { width: 300, height: 120, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.5 } } })
        .png()
        .toBuffer();

    const storedFile = (avatarUrl) => fs.readFileSync(path.join(tmp, avatarUrl.replace(/^uploads\//, '')));

    before(() => {
        savedUploadPath = process.env.UPLOAD_PATH;
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frichat-sharp-'));
        process.env.UPLOAD_PATH = tmp;
        const fake = setupFakeDb('postgresql', () => []);
        avatars = fake.load('utils/avatars.js');
        groupAvatars = fake.load('utils/groupAvatar.js');
    });

    after(() => {
        if (savedUploadPath === undefined) delete process.env.UPLOAD_PATH;
        else process.env.UPLOAD_PATH = savedUploadPath;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('a JPEG becomes a 512x512 WebP, turned by its EXIF orientation, with the EXIF gone', async () => {
        const jpeg = await rotatedJpeg();
        assert.ok(jpeg.includes(Buffer.from('private-marker')), 'the sample carries the marker');

        const saved = await avatars.saveUserAvatar(jpeg);
        assert.match(saved.avatarUrl, /^uploads\/avatars\/[a-f0-9]{32}\.webp$/);

        const bytes = storedFile(saved.avatarUrl);
        assert.ok(!bytes.includes(Buffer.from('private-marker')));
        const meta = await sharp(bytes).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
        assert.equal(meta.exif, undefined);

        // Turned clockwise, the red left half is now on top
        const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const pixel = (x, y) => data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels);
        const [topRed, , topBlue] = pixel(256, 100);
        const [bottomRed, , bottomBlue] = pixel(256, 412);
        assert.ok(topRed > 200 && topBlue < 60, `top is red, got ${topRed},${topBlue}`);
        assert.ok(bottomBlue > 200 && bottomRed < 60, `bottom is blue, got ${bottomRed},${bottomBlue}`);
    });

    test('a translucent PNG becomes a 512x512 WebP and keeps its transparency', async () => {
        const saved = await avatars.saveUserAvatar(await translucentPng());
        const meta = await sharp(storedFile(saved.avatarUrl)).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['webp', 512, 512, true]);
    });

    test('group avatars: JPEG and PNG both become 256x256 WebP', async () => {
        for (const sample of [await rotatedJpeg(), await translucentPng()]) {
            const saved = await groupAvatars.saveGroupAvatar(sample);
            assert.equal(saved.resized, true);
            const meta = await sharp(storedFile(saved.avatarUrl)).metadata();
            assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 256, 256]);
        }
    });

    test('a CMYK JPEG, four channels from a print workflow, is still accepted', async () => {
        const cmyk = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } })
            .toColourspace('cmyk')
            .jpeg()
            .toBuffer();
        assert.equal((await sharp(cmyk).metadata()).space, 'cmyk');

        const saved = await avatars.saveUserAvatar(cmyk);
        assert.ok(saved.avatarUrl, JSON.stringify(saved));
    });

    test('over the pixel limit, or undecodable behind a valid signature, is refused and nothing is stored', async () => {
        const dir = path.join(tmp, 'avatars');
        const storedBefore = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;

        const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#000000' } }).png().toBuffer();
        const garbage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x41)]);

        for (const sample of [huge, garbage]) {
            assert.equal((await avatars.saveUserAvatar(sample)).status, 400);
            assert.ok((await groupAvatars.saveGroupAvatar(sample)).error);
        }
        assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, storedBefore);
    });
});

describe('Express body parsing', () => {
    // The parsers from server.js, in a process of their own: the bug takes the process down
    const SERVER = `
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));
        app.post('/echo', (req, res) => res.json(req.body));
        app.get('/alive', (req, res) => res.send('yes'));
        const server = app.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
    `;
    let child;
    let exitCode;
    let port;

    beforeEach(async () => {
        exitCode = null;
        child = spawn(process.execPath, ['-e', SERVER], { cwd: BACKEND, stdio: ['ignore', 'pipe', 'ignore'] });
        child.on('exit', (code) => { exitCode = code; });
        port = await new Promise((resolve) => {
            child.stdout.once('data', (chunk) => resolve(Number(/PORT (\d+)/.exec(chunk)[1])));
        });
    });

    afterEach(() => { child.kill(); });

    test('trailing bytes after a gzip body don\'t crash the server (GHSA-27r3-jxmh-p828)', async () => {
        const frame = zlib.gzipSync('{"a":1}');
        const padding = Buffer.alloc(4);
        const junk = Buffer.alloc(16, 0x41);

        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
        await new Promise(resolve => socket.once('connect', resolve));
        socket.write('POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
            + `Content-Encoding: gzip\r\nContent-Length: ${frame.length + padding.length + junk.length}\r\n\r\n`);
        socket.write(Buffer.concat([frame, padding]));
        await wait(150);
        socket.write(junk);
        await wait(250);
        socket.destroy();

        assert.equal(exitCode, null, 'the server process is still running');
        assert.equal(await (await fetch(`http://127.0.0.1:${port}/alive`)).text(), 'yes');
    });

    test('plain JSON, gzip JSON, deflate JSON and urlencoded bodies still parse', async () => {
        const post = async (body, headers) => (await fetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', body, headers })).json();
        const json = { 'content-type': 'application/json' };

        assert.deepEqual(await post('{"a":1}', json), { a: 1 });
        assert.deepEqual(await post(zlib.gzipSync('{"a":2}'), { ...json, 'content-encoding': 'gzip' }), { a: 2 });
        assert.deepEqual(await post(zlib.deflateSync('{"a":3}'), { ...json, 'content-encoding': 'deflate' }), { a: 3 });
        assert.deepEqual(await post('a=4&b[c]=5', { 'content-type': 'application/x-www-form-urlencoded' }), { a: '4', b: { c: '5' } });
    });
});
