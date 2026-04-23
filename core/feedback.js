/**
 * @fileoverview Feedback loop and performance scoring system for Git History LLM.
 * Continuously evaluates system quality, computes execution scores, and detects
 * degradation trends over time without manual inspection.
 * 
 * This module enables self-monitoring capabilities, ensuring long-term reliability
 * of the Git History LLM pipelines by tracking determinism, confidence, retries,
 * and fallback usage.
 * 
 * @module core/feedback
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * @typedef {Object} ExecutionMetrics
 * @property {string} [executionId] - Optional unique identifier for the execution.
 * @property {boolean|number} determinismSuccess - Whether the LLM output was deterministic (1.0 or true) or not (0.0 or false).
 * @property {number} confidenceScore - The confidence score of the generated output (0.0 to 1.0).
 * @property {number} retryCount - Number of retries required to get a valid output.
 * @property {boolean} fallbackUsage - Whether a fallback mechanism (e.g., simpler prompt, smaller model) was used.
 * @property {Object} [metadata] - Additional context about the execution (e.g., commit hash, prompt type).
 * @property {number} [timestamp] - Epoch timestamp of the execution.
 */

/**
 * @typedef {Object} ScoringWeights
 * @property {number} determinism - Weight for determinism success (default: 0.4).
 * @property {number} confidence - Weight for confidence score (default: 0.6).
 * @property {number} retryPenalty - Penalty per retry (default: 0.1).
 * @property {number} fallbackPenalty - Penalty if fallback was used (default: 0.2).
 */

/**
 * @typedef {Object} FeedbackConfig
 * @property {string} [storagePath] - Path to store the feedback history JSON file.
 * @property {number} [historyLimit] - Maximum number of executions to keep in history.
 * @property {number} [degradationWindow] - Number of recent executions to analyze for degradation trends.
 * @property {number} [degradationThreshold] - The slope threshold below which a trend is considered degrading.
 * @property {ScoringWeights} [weights] - Custom scoring weights and penalties.
 */

/**
 * Utility class for statistical calculations, specifically linear regression
 * for trend analysis over a time series of scores.
 */
class StatsUtil {
    /**
     * Calculates the slope of the best-fit line using simple linear regression.
     * A negative slope indicates a downward trend (degradation).
     * 
     * @param {number[]} yValues - The array of scores (y-axis).
     * @returns {number} The slope of the regression line.
     */
    static calculateLinearRegressionSlope(yValues) {
        const n = yValues.length;
        if (n < 2) return 0;

        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumXX = 0;

        for (let i = 0; i < n; i++) {
            const x = i; // Time proxy
            const y = yValues[i];
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }

        const denominator = (n * sumXX) - (sumX * sumX);
        if (denominator === 0) return 0;

        const slope = ((n * sumXY) - (sumX * sumY)) / denominator;
        return slope;
    }

    /**
     * Calculates the Simple Moving Average (SMA) of an array of numbers.
     * 
     * @param {number[]} values - The array of numerical values.
     * @param {number} period - The moving average period.
     * @returns {number[]} Array of SMA values.
     */
    static calculateSMA(values, period) {
        if (values.length < period || period <= 0) return [];
        const sma = [];
        let windowSum = 0;

        for (let i = 0; i < period; i++) {
            windowSum += values[i];
        }
        sma.push(windowSum / period);

        for (let i = period; i < values.length; i++) {
            windowSum += values[i] - values[i - period];
            sma.push(windowSum / period);
        }

        return sma;
    }
}

/**
 * Manages the persistence and retrieval of execution metrics.
 * Ensures that the system can track performance across multiple runs.
 */
class MetricsStore {
    /**
     * @param {string} storagePath - Absolute or relative path to the storage file.
     * @param {number} limit - Maximum number of records to retain.
     */
    constructor(storagePath, limit = 1000) {
        this.storagePath = path.resolve(storagePath);
        this.limit = limit;
        this.cache = null;
        this._ensureDirectoryExists();
    }

    /**
     * Ensures the directory for the storage file exists.
     * @private
     */
    _ensureDirectoryExists() {
        const dir = path.dirname(this.storagePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Loads the metrics history from the filesystem.
     * @returns {Array<Object>} The array of historical execution records.
     */
    load() {
        if (this.cache) return this.cache;
        
        if (!fs.existsSync(this.storagePath)) {
            this.cache = [];
            return this.cache;
        }

        try {
            const data = fs.readFileSync(this.storagePath, 'utf-8');
            this.cache = JSON.parse(data);
            if (!Array.isArray(this.cache)) {
                this.cache = [];
            }
        } catch (error) {
            console.error(`[MetricsStore] Failed to load metrics from ${this.storagePath}:`, error.message);
            this.cache = [];
        }

        return this.cache;
    }

    /**
     * Saves a new record to the store, enforcing the size limit.
     * @param {Object} record - The execution record to save.
     */
    saveRecord(record) {
        const history = this.load();
        history.push(record);

        // Enforce history limit by removing oldest records
        if (history.length > this.limit) {
            history.splice(0, history.length - this.limit);
        }

        try {
            // Atomic write using a temporary file to prevent corruption
            const tempPath = `${this.storagePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(history, null, 2), 'utf-8');
            fs.renameSync(tempPath, this.storagePath);
            this.cache = history;
        } catch (error) {
            console.error(`[MetricsStore] Failed to save metrics to ${this.storagePath}:`, error.message);
        }
    }

    /**
     * Retrieves the most recent N records.
     * @param {number} count - Number of records to retrieve.
     * @returns {Array<Object>}
     */
    getRecent(count) {
        const history = this.load();
        return history.slice(-count);
    }

    /**
     * Clears all stored metrics.
     */
    clear() {
        this.cache = [];
        if (fs.existsSync(this.storagePath)) {
            fs.unlinkSync(this.storagePath);
        }
    }
}

/**
 * Core Feedback System for Git History LLM.
 * Emits events: 'execution_scored', 'degradation_detected', 'performance_recovered'
 */
class FeedbackLoop extends EventEmitter {
    /**
     * Initializes the FeedbackLoop with configuration.
     * @param {FeedbackConfig} [config={}] 
     */
    constructor(config = {}) {
        super();
        
        const defaultConfig = {
            storagePath: path.join(process.cwd(), '.git-history-llm', 'feedback-metrics.json'),
            historyLimit: 5000,
            degradationWindow: 50,      // Analyze the last 50 executions for trends
            degradationThreshold: -0.005, // Slope threshold for alerting
            weights: {
                determinism: 0.4,
                confidence: 0.6,
                retryPenalty: 0.1,
                fallbackPenalty: 0.2
            }
        };

        this.config = { ...defaultConfig, ...config };
        this.config.weights = { ...defaultConfig.weights, ...(config.weights || {}) };
        
        this.store = new MetricsStore(this.config.storagePath, this.config.historyLimit);
        this.isDegradedState = false;
    }

    /**
     * Computes the performance score (0.0 to 1.0) for a single execution based on metrics.
     * 
     * Formula:
     * Base Score = (Determinism * W_det) + (Confidence * W_conf)
     * Penalty = (Retries * W_retry) + (Fallback ? W_fallback : 0)
     * Final Score = clamp(Base Score - Penalty, 0.0, 1.0)
     * 
     * @param {ExecutionMetrics} metrics - The raw metrics from an LLM execution.
     * @returns {number} The calculated score from 0.0 to 1.0.
     */
    computeScore(metrics) {
        const { weights } = this.config;

        // Normalize determinism to 0.0 or 1.0
        let determinismVal = 0;
        if (typeof metrics.determinismSuccess === 'boolean') {
            determinismVal = metrics.determinismSuccess ? 1.0 : 0.0;
        } else if (typeof metrics.determinismSuccess === 'number') {
            determinismVal = Math.max(0, Math.min(1, metrics.determinismSuccess));
        }

        // Normalize confidence
        const confidenceVal = Math.max(0, Math.min(1, metrics.confidenceScore || 0));

        // Base positive score
        let score = (determinismVal * weights.determinism) + (confidenceVal * weights.confidence);

        // Apply penalties
        const retryCount = Math.max(0, parseInt(metrics.retryCount, 10) || 0);
        const retryPenalty = retryCount * weights.retryPenalty;
        
        const fallbackPenalty = metrics.fallbackUsage ? weights.fallbackPenalty : 0;

        score -= (retryPenalty + fallbackPenalty);

        // Clamp between 0.0 and 1.0
        return Math.max(0.0, Math.min(1.0, score));
    }

    /**
     * Records a new execution, computes its score, saves it, and evaluates system health.
     * 
     * @param {ExecutionMetrics} metrics - The metrics gathered from the recent execution.
     * @returns {Object} The complete record including the computed score.
     */
    recordExecution(metrics) {
        this._validateMetrics(metrics);

        const score = this.computeScore(metrics);
        const record = {
            id: metrics.executionId || crypto.randomUUID(),
            timestamp: metrics.timestamp || Date.now(),
            metrics: {
                determinismSuccess: metrics.determinismSuccess,
                confidenceScore: metrics.confidenceScore,
                retryCount: metrics.retryCount,
                fallbackUsage: metrics.fallbackUsage
            },
            metadata: metrics.metadata || {},
            score: parseFloat(score.toFixed(4))
        };

        this.store.saveRecord(record);
        
        this.emit('execution_scored', record);

        // Run continuous evaluation asynchronously to avoid blocking the main thread
        setImmediate(() => this.evaluateSystemHealth());

        return record;
    }

    /**
     * Validates the incoming metrics object to ensure required fields are present.
     * @param {ExecutionMetrics} metrics 
     * @private
     */
    _validateMetrics(metrics) {
        if (!metrics || typeof metrics !== 'object') {
            throw new Error('Invalid metrics object provided to FeedbackLoop.');
        }
        if (metrics.confidenceScore === undefined) {
            console.warn('[FeedbackLoop] Warning: confidenceScore is missing, defaulting to 0.0');
        }
        if (metrics.determinismSuccess === undefined) {
            console.warn('[FeedbackLoop] Warning: determinismSuccess is missing, defaulting to false');
        }
    }

    /**
     * Evaluates the recent history of scores to detect degradation trends.
     * Uses linear regression over the configured degradation window.
     * Emits alerts if the system crosses thresholds.
     */
    evaluateSystemHealth() {
        const recentRecords = this.store.getRecent(this.config.degradationWindow);
        
        // Need a minimum number of records to establish a meaningful trend
        const minRecordsForTrend = Math.min(10, this.config.degradationWindow);
        if (recentRecords.length < minRecordsForTrend) {
            return; // Not enough data
        }

        const scores = recentRecords.map(r => r.score);
        const slope = StatsUtil.calculateLinearRegressionSlope(scores);
        const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;

        const healthReport = {
            windowSize: scores.length,
            averageScore: parseFloat(averageScore.toFixed(4)),
            trendSlope: parseFloat(slope.toFixed(6)),
            timestamp: Date.now()
        };

        // Detect Degradation
        if (slope < this.config.degradationThreshold) {
            if (!this.isDegradedState) {
                this.isDegradedState = true;
                this.emit('degradation_detected', {
                    message: 'System performance degradation detected over recent executions.',
                    details: healthReport
                });
            }
        } else if (slope > 0 && averageScore > 0.8) {
            // Recovered
            if (this.isDegradedState) {
                this.isDegradedState = false;
                this.emit('performance_recovered', {
                    message: 'System performance has recovered.',
                    details: healthReport
                });
            }
        }
    }

    /**
     * Generates a comprehensive performance report based on historical data.
     * Useful for CI/CD integration or monitoring dashboards.
     * 
     * @returns {Object} Structured report containing averages, trends, and error rates.
     */
    generateReport() {
        const history = this.store.load();
        if (history.length === 0) {
            return { status: 'NO_DATA', message: 'No execution history available.' };
        }

        const totalExecutions = history.length;
        const recentHistory = this.store.getRecent(this.config.degradationWindow);
        
        const calculateAverages = (records) => {
            if (records.length === 0) return null;
            const sums = records.reduce((acc, curr) => ({
                score: acc.score + curr.score,
                confidence: acc.confidence + curr.metrics.confidenceScore,
                retries: acc.retries + curr.metrics.retryCount,
                fallbacks: acc.fallbacks + (curr.metrics.fallbackUsage ? 1 : 0),
                determinism: acc.determinism + (curr.metrics.determinismSuccess ? 1 : 0)
            }), { score: 0, confidence: 0, retries: 0, fallbacks: 0, determinism: 0 });

            return {
                averageScore: sums.score / records.length,
                averageConfidence: sums.confidence / records.length,
                averageRetries: sums.retries / records.length,
                fallbackRate: sums.fallbacks / records.length,
                determinismRate: sums.determinism / records.length
            };
        };

        const globalStats = calculateAverages(history);
        const recentStats = calculateAverages(recentHistory);
        
        const recentScores = recentHistory.map(r => r.score);
        const trendSlope = StatsUtil.calculateLinearRegressionSlope(recentScores);

        let systemHealth = 'HEALTHY';
        if (trendSlope < this.config.degradationThreshold) systemHealth = 'DEGRADING';
        if (recentStats.averageScore < 0.5) systemHealth = 'CRITICAL';

        return {
            systemHealth,
            totalExecutions,
            analyzedAt: new Date().toISOString(),
            trend: {
                slope: parseFloat(trendSlope.toFixed(6)),
                description: trendSlope < 0 ? 'Declining' : 'Improving'
            },
            metrics: {
                global: globalStats,
                recent: recentStats
            }
        };
    }
}

// Export the class and utilities for external usage
module.exports = {
    FeedbackLoop,
    MetricsStore,
    StatsUtil
};