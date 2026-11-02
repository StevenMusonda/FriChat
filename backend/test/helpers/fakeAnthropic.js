/**
 * A local stand-in for the Anthropic Messages API, so tests drive the real SDK over HTTP. The SDK
 * reads ANTHROPIC_BASE_URL. Every request is kept for assertions; `reply` decides each response.
 */

const http = require('http');

function fakeAnthropic() {
    const fake = {
        requests: [],
        // (body) => { status?, json } or a plain string of reply text
        reply: () => '- Ana moved the meeting to Friday\n- Ben asked for the report',
        server: null,
        url: null
    };

    fake.server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            fake.requests.push({ url: req.url, headers: req.headers, body });
            const answer = await fake.reply(body);
            if (typeof answer === 'string') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_test',
                    type: 'message',
                    role: 'assistant',
                    model: body.model,
                    content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: answer }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 120, output_tokens: 30 }
                }));
                return;
            }
            res.writeHead(answer.status || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(answer.json));
        });
    });

    fake.start = () => new Promise((resolve) => {
        fake.server.listen(0, '127.0.0.1', () => {
            fake.url = `http://127.0.0.1:${fake.server.address().port}`;
            resolve(fake);
        });
    });
    fake.stop = () => new Promise(resolve => fake.server.close(resolve));

    return fake;
}

module.exports = { fakeAnthropic };
