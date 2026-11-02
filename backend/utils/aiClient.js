/**
 * The one place that talks to the Anthropic API. The SDK is loaded on the first request, so a server
 * without an API key never touches it.
 *
 * Errors are logged by kind only: no text from a request or a reply reaches the logs.
 */

const {
    aiApiKey,
    aiModel,
    REQUEST_TIMEOUT_MS,
    REQUEST_MAX_RETRIES
} = require('../config/ai');

/**
 * Thrown for every failed call; `apiError` is what the user gets to see
 */
class AiRequestError extends Error {
    constructor(status, code, message) {
        super(message);
        this.apiError = { status, code, message };
    }
}

/**
 * Which failure this is, most specific first. A timeout is also a connection error.
 */
function describeFailure(error, Anthropic) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
        return new AiRequestError(504, 'AI_TIMEOUT', 'The AI service took too long. Please try again.');
    }
    if (error instanceof Anthropic.APIConnectionError) {
        return new AiRequestError(503, 'AI_UNAVAILABLE', 'The AI service can\'t be reached right now.');
    }
    if (error instanceof Anthropic.RateLimitError) {
        return new AiRequestError(503, 'AI_BUSY', 'The AI service is busy. Please try again in a minute.');
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        console.error('AI request refused: check ANTHROPIC_API_KEY');
        return new AiRequestError(503, 'AI_UNAVAILABLE', 'The AI service isn\'t available right now.');
    }
    if (error instanceof Anthropic.APIError) {
        return new AiRequestError(502, 'AI_UNAVAILABLE', 'The AI service isn\'t available right now.');
    }
    return new AiRequestError(502, 'AI_UNAVAILABLE', 'The AI service isn\'t available right now.');
}

/**
 * Send one system prompt and one user turn. Haiku 5.5 thinks by default and thinking counts towards
 * max_tokens, so low effort keeps these short jobs short (see config/ai.js for the output budgets).
 * @returns {Promise<{ text, inputTokens, outputTokens, stopReason }>}
 * @throws {AiRequestError}
 */
async function complete({ system, text, maxTokens }) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    // apiKey and authToken are explicit: the SDK would otherwise also pick up other local credentials,
    // and the only switch for these features is ANTHROPIC_API_KEY
    const client = new Anthropic({
        apiKey: aiApiKey(),
        authToken: null,
        timeout: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES
    });

    let response;
    try {
        response = await client.messages.create({
            model: aiModel(),
            max_tokens: maxTokens,
            output_config: { effort: 'low' },
            system,
            messages: [{ role: 'user', content: text }]
        });
    } catch (error) {
        const failure = describeFailure(error, Anthropic);
        console.error(`AI request failed: ${failure.apiError.code} (status ${error.status || 'none'})`);
        throw failure;
    }

    return {
        text: response.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        inputTokens: Number(response.usage && response.usage.input_tokens) || 0,
        outputTokens: Number(response.usage && response.usage.output_tokens) || 0,
        stopReason: response.stop_reason
    };
}

module.exports = { AiRequestError, complete };
