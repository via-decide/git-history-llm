/**
 * @file core/budget.js
 * @description Advanced rate limiting, token budget enforcement, and cost tracking system
 * for the Git History LLM pipeline. Prevents cost overruns, tracks token usage across 
 * summarization and retry cycles, and manages API rate limits (TPM/RPM) to ensure 
 * system stability during large-scale repository processing.
 * 
 * @module core/budget
 */

const EventEmitter = require('events');
const { promisify } = require('util');

const sleep = promisify(setTimeout);

/**
 * Custom error thrown when the maximum token or cost budget for a run is exceeded.
 * Catching this error should trigger a graceful halt of the pipeline.
 */
class BudgetExhaustedError extends Error {
    /**
     * @param {string} message - Error description
     * @param {Object} stats - Current usage statistics at the time of exhaustion
     */
    constructor(message, stats) {
        super(message);
        this.name = 'BudgetExhaustedError';
        this.stats = stats;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Custom error thrown when rate limits are strictly exceeded and waiting is disabled,
 * or when maximum backoff time is reached.
 */
class RateLimitExceededError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RateLimitExceededError';
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Custom error for when maximum retry attempts for a single operation are exceeded.
 */
class MaxRetriesExceededError extends Error {
    constructor(message, operationId) {
        super(message);
        this.name = 'MaxRetriesExceededError';
        this.operationId = operationId;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Known model pricing for accurate cost tracking. 
 * Prices are per 1,000 tokens (USD).
 * @constant {Object.<string, {input: number, output: number}>}
 */
const MODEL_PRICING = {
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'gemini-1.5-pro': { input: 0.0035, output: 0.0105 },
    'gemini-1.5-flash': { input: 0.00035, output: 0.00105 },
    'claude-3-opus': { input: 0.015, output: 0.075 },
    'claude-3-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    'default': { input: 0.001, output: 0.002 }
};

/**
 * Default configuration for the BudgetManager.
 */
const DEFAULT_CONFIG = {
    maxTokens: 50000,            // Absolute max tokens allowed per run
    maxCostUsd: 5.00,            // Absolute max cost in USD allowed per run
    tpmLimit: 40000,             // Tokens Per Minute limit (Rate Limit)
    rpmLimit: 200,               // Requests Per Minute limit (Rate Limit)
    maxRetriesPerOp: 3,          // Maximum retries allowed per summarization operation
    enforceStrictLimits: false,  // If true, fails immediately on rate limit instead of waiting
    defaultModel: 'default'      // Default model for cost calculations
};

/**
 * BudgetManager handles token accounting, cost estimation, and rate limiting.
 * It ensures the Git History LLM pipeline stays within safe operational boundaries.
 * 
 * @class BudgetManager
 * @extends EventEmitter
 */
class BudgetManager extends EventEmitter {
    /**
     * Initialize the Budget Manager with specific constraints.
     * @param {Partial<typeof DEFAULT_CONFIG>} config - User provided configuration overrides
     */
    constructor(config = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Global Run State
        this.state = {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.0,
            totalRequests: 0,
            totalRetries: 0,
            isHalted: false,
            haltReason: null,
            startTime: Date.now()
        };

        // Sliding Window State for Rate Limiting (1 minute window)
        this.window = {
            tokens: [],   // Array of { timestamp, count }
            requests: []  // Array of timestamps
        };

        // Retry Tracking per operation
        this.operationRetries = new Map();

        // Lock mechanism for rate limit queueing
        this._rateLimitLock = Promise.resolve();
    }

    /**
     * Calculates the cost of a request based on the model used.
     * 
     * @param {number} inputTokens - Tokens sent in the prompt
     * @param {number} outputTokens - Tokens received in the completion
     * @param {string} [model] - The model identifier
     * @returns {number} The estimated cost in USD
     * @private
     */
    _calculateCost(inputTokens, outputTokens, model = this.config.defaultModel) {
        const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
        const inputCost = (inputTokens / 1000) * pricing.input;
        const outputCost = (outputTokens / 1000) * pricing.output;
        return inputCost + outputCost;
    }

    /**
     * Cleans up sliding window histories older than 60 seconds.
     * @private
     */
    _pruneWindow() {
        const oneMinuteAgo = Date.now() - 60000;
        
        // Prune tokens
        while (this.window.tokens.length > 0 && this.window.tokens[0].timestamp < oneMinuteAgo) {
            this.window.tokens.shift();
        }

        // Prune requests
        while (this.window.requests.length > 0 && this.window.requests[0] < oneMinuteAgo) {
            this.window.requests.shift();
        }
    }

    /**
     * Calculates current Tokens Per Minute (TPM) and Requests Per Minute (RPM).
     * @returns {{ currentTpm: number, currentRpm: number }}
     * @private
     */
    _getCurrentRates() {
        this._pruneWindow();
        const currentTpm = this.window.tokens.reduce((sum, entry) => sum + entry.count, 0);
        const currentRpm = this.window.requests.length;
        return { currentTpm, currentRpm };
    }

    /**
     * Internal implementation of the rate limit acquisition.
     * @param {number} estimatedTokens - Tokens expected to be consumed
     * @returns {Promise<void>}
     * @private
     */
    async _acquireRateLimit(estimatedTokens) {
        if (this.state.isHalted) {
            throw new BudgetExhaustedError(`Pipeline halted: ${this.state.haltReason}`, this.getStats());
        }

        let rates = this._getCurrentRates();
        
        while (
            rates.currentTpm + estimatedTokens > this.config.tpmLimit || 
            rates.currentRpm + 1 > this.config.rpmLimit
        ) {
            if (this.config.enforceStrictLimits) {
                throw new RateLimitExceededError(
                    `Rate limit exceeded. TPM: ${rates.currentTpm}/${this.config.tpmLimit}, RPM: ${rates.currentRpm}/${this.config.rpmLimit}`
                );
            }

            // Calculate wait time: Find the oldest entry that needs to expire to make room
            this.emit('rateLimitWait', {
                estimatedTokens,
                currentTpm: rates.currentTpm,
                currentRpm: rates.currentRpm,
                message: 'Approaching rate limits, throttling request...'
            });

            // Sleep in short bursts until the window clears enough space
            await sleep(1000);
            rates = this._getCurrentRates();
        }

        // Record the request in the window preemptively
        const now = Date.now();
        this.window.requests.push(now);
        this.window.tokens.push({ timestamp: now, count: estimatedTokens });
    }

    /**
     * Pauses execution until rate limits (TPM and RPM) allow for the next request.
     * Uses a queueing mechanism to prevent concurrent requests from bursting past the limit.
     * 
     * @param {number} estimatedTokens - A rough estimate of tokens (input + expected output)
     * @returns {Promise<void>} Resolves when the request is clear to proceed
     */
    async enforceRateLimit(estimatedTokens = 1000) {
        // Chain promises to ensure sequential evaluation of rate limits
        const acquire = this._rateLimitLock.then(() => this._acquireRateLimit(estimatedTokens));
        this._rateLimitLock = acquire.catch(() => {}); // Prevent unhandled rejections in the lock chain
        return acquire;
    }

    /**
     * Records actual token usage after an LLM call completes.
     * Updates global state and checks if the maximum budget has been exhausted.
     * 
     * @param {number} inputTokens - Actual tokens sent
     * @param {number} outputTokens - Actual tokens received
     * @param {string} [model] - Model used for the request
     * @throws {BudgetExhaustedError} If the max token or cost budget is exceeded
     */
    recordUsage(inputTokens, outputTokens, model = this.config.defaultModel) {
        if (this.state.isHalted) {
            throw new BudgetExhaustedError(`Cannot record usage. Pipeline halted: ${this.state.haltReason}`, this.getStats());
        }

        const totalTokensForRequest = inputTokens + outputTokens;
        const costUsd = this._calculateCost(inputTokens, outputTokens, model);

        // Update global state
        this.state.inputTokens += inputTokens;
        this.state.outputTokens += outputTokens;
        this.state.totalTokens += totalTokensForRequest;
        this.state.totalCostUsd += costUsd;
        this.state.totalRequests += 1;

        // Emit usage event for logging/monitoring telemetry
        this.emit('usageRecorded', {
            inputTokens,
            outputTokens,
            totalTokensForRequest,
            costUsd,
            model,
            currentTotalTokens: this.state.totalTokens,
            currentTotalCost: this.state.totalCostUsd
        });

        // Check for budget exhaustion
        if (this.state.totalTokens >= this.config.maxTokens) {
            this.haltPipeline(`Max token budget exceeded: ${this.state.totalTokens} / ${this.config.maxTokens} tokens`);
        }

        if (this.state.totalCostUsd >= this.config.maxCostUsd) {
            this.haltPipeline(`Max cost budget exceeded: $${this.state.totalCostUsd.toFixed(4)} / $${this.config.maxCostUsd.toFixed(4)}`);
        }
    }

    /**
     * Tracks a retry attempt for a specific operation (e.g., a specific commit summarization).
     * 
     * @param {string} operationId - Unique identifier for the operation being retried
     * @throws {MaxRetriesExceededError} If the operation has exceeded allowed retries
     */
    trackRetry(operationId) {
        const currentRetries = this.operationRetries.get(operationId) || 0;
        const newRetries = currentRetries + 1;
        
        this.state.totalRetries += 1;
        this.operationRetries.set(operationId, newRetries);

        this.emit('retryTracked', {
            operationId,
            attempt: newRetries,
            maxAllowed: this.config.maxRetriesPerOp
        });

        if (newRetries > this.config.maxRetriesPerOp) {
            throw new MaxRetriesExceededError(
                `Operation ${operationId} exceeded maximum retries (${this.config.maxRetriesPerOp})`,
                operationId
            );
        }
    }

    /**
     * Clears the retry counter for a specific operation upon success.
     * 
     * @param {string} operationId - Unique identifier for the operation
     */
    clearRetry(operationId) {
        this.operationRetries.delete(operationId);
    }

    /**
     * Forcefully halts the pipeline, preventing any further rate limit acquisitions or token consumption.
     * 
     * @param {string} reason - The reason for halting the pipeline
     * @throws {BudgetExhaustedError} Always throws to interrupt the current call stack
     */
    haltPipeline(reason) {
        this.state.isHalted = true;
        this.state.haltReason = reason;
        
        this.emit('pipelineHalted', {
            reason,
            stats: this.getStats()
        });

        throw new BudgetExhaustedError(reason, this.getStats());
    }

    /**
     * Checks if the pipeline is currently halted due to budget exhaustion.
     * 
     * @returns {boolean} True if halted, false otherwise
     */
    isHalted() {
        return this.state.isHalted;
    }

    /**
     * Returns the current usage statistics and limits.
     * 
     * @returns {Object} Comprehensive statistics object
     */
    getStats() {
        const rates = this._getCurrentRates();
        const runDurationMs = Date.now() - this.state.startTime;
        
        return {
            config: {
                maxTokens: this.config.maxTokens,
                maxCostUsd: this.config.maxCostUsd,
                tpmLimit: this.config.tpmLimit,
                rpmLimit: this.config.rpmLimit
            },
            usage: {
                totalTokens: this.state.totalTokens,
                inputTokens: this.state.inputTokens,
                outputTokens: this.state.outputTokens,
                totalCostUsd: Number(this.state.totalCostUsd.toFixed(6)),
                totalRequests: this.state.totalRequests,
                totalRetries: this.state.totalRetries
            },
            currentRates: {
                tpm: rates.currentTpm,
                rpm: rates.currentRpm
            },
            health: {
                isHalted: this.state.isHalted,
                haltReason: this.state.haltReason,
                runDurationSeconds: Math.floor(runDurationMs / 1000),
                tokenBudgetRemaining: Math.max(0, this.config.maxTokens - this.state.totalTokens),
                costBudgetRemainingUsd: Math.max(0, this.config.maxCostUsd - this.state.totalCostUsd)
            }
        };
    }

    /**
     * Resets the budget manager state. Useful for long-running daemons or testing.
     * Retains configuration but clears all usage histories and un-halts the pipeline.
     */
    reset() {
        this.state = {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.0,
            totalRequests: 0,
            totalRetries: 0,
            isHalted: false,
            haltReason: null,
            startTime: Date.now()
        };
        this.window = { tokens: [], requests: [] };
        this.operationRetries.clear();
        this._rateLimitLock = Promise.resolve();
        
        this.emit('budgetReset');
    }
}

module.exports = {
    BudgetManager,
    BudgetExhaustedError,
    RateLimitExceededError,
    MaxRetriesExceededError,
    MODEL_PRICING,
    DEFAULT_CONFIG
};