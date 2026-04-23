/**
 * @fileoverview Confidence scoring and gating engine for LLM-generated commit summaries.
 * 
 * This module is responsible for computing a rigorous confidence score (0.0 to 1.0) 
 * for LLM outputs based on schema completeness, determinism metrics, length sanity, 
 * and diff coverage heuristics. It acts as a gatekeeper to prevent low-quality, 
 * hallucinated, or malformed insights from entering Zayvora pipelines or the 
 * Git History LLM storage arrays.
 * 
 * @module core/scoring
 * @version 3.0.0-beast
 */

/**
 * Standard configuration for the Confidence Scorer.
 * Defines weights for the final score calculation and thresholds for gating.
 * Weights should sum up to exactly 1.0.
 */
const DEFAULT_SCORING_CONFIG = {
    weights: {
        schema: 0.35,        // Heaviest weight: If it doesn't match the schema, it's useless for pipelines
        diffCoverage: 0.35,  // High weight: Ensures the summary is actually grounded in the code changes
        determinism: 0.20,   // Medium weight: Rewards stable/consistent LLM generation
        length: 0.10         // Lower weight: Basic sanity check to catch anomalies
    },
    thresholds: {
        gatekeeperAccept: 0.75, // Minimum score to be accepted into the system
        diffKeywordTopN: 15,    // Number of top keywords to extract from diff for coverage
        lengthOptimalMin: 50,   // Minimum optimal characters in a summary
        lengthOptimalMax: 1000, // Maximum optimal characters in a summary
        lengthAbsoluteMax: 3000 // Absolute maximum before severe penalties are applied
    }
};

/**
 * Common English and programming stopwords to filter out during diff tokenization.
 * This ensures the diff coverage heuristic focuses on domain-specific nouns and verbs.
 */
const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 
    'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 
    'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with', 'const', 'let', 'var',
    'function', 'return', 'import', 'export', 'class', 'interface', 'public', 'private',
    'protected', 'static', 'void', 'null', 'undefined', 'true', 'false', 'if', 'else',
    'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw',
    'new', 'this', 'super', 'typeof', 'instanceof', 'from', 'require', 'module', 'exports'
]);

/**
 * @typedef {Object} ScoringResult
 * @property {number} totalScore - The final computed confidence score [0.0 - 1.0]
 * @property {boolean} accepted - Whether the score meets the configured gatekeeper threshold
 * @property {Object} breakdown - Detailed breakdown of individual component scores
 * @property {number} breakdown.schemaScore - Score for schema completeness [0.0 - 1.0]
 * @property {number} breakdown.diffCoverageScore - Score for code diff coverage [0.0 - 1.0]
 * @property {number} breakdown.determinismScore - Score for LLM determinism [0.0 - 1.0]
 * @property {number} breakdown.lengthScore - Score for length sanity [0.0 - 1.0]
 * @property {string[]} reasons - Human-readable explanations for penalties or low scores
 * @property {Object} metadata - Additional context used during evaluation
 */

export class ConfidenceScorer {
    /**
     * Initializes the ConfidenceScorer with optional custom configuration.
     * @param {Object} [config] - Optional configuration overrides.
     */
    constructor(config = {}) {
        this.config = {
            weights: { ...DEFAULT_SCORING_CONFIG.weights, ...(config.weights || {}) },
            thresholds: { ...DEFAULT_SCORING_CONFIG.thresholds, ...(config.thresholds || {}) }
        };

        // Validate weights sum to 1.0 (with small epsilon for floating point errors)
        const totalWeight = Object.values(this.config.weights).reduce((a, b) => a + b, 0);
        if (Math.abs(totalWeight - 1.0) > 0.001) {
            throw new Error(`Scoring weights must sum to 1.0. Current sum: ${totalWeight}`);
        }
    }

    /**
     * Main entry point to evaluate an LLM-generated commit summary and determine if it should be accepted.
     * 
     * @param {Object|string} llmOutput - The structured JSON object or raw string returned by the LLM.
     * @param {string} gitDiff - The raw git diff string associated with the commit.
     * @param {boolean} isDeterministic - Flag indicating if multiple LLM passes yielded the same result (temperature=0 stability).
     * @param {Object} expectedSchema - An object mapping expected keys to their expected JavaScript types (e.g., { title: 'string', impact: 'number' }).
     * @returns {ScoringResult} The comprehensive scoring report.
     */
    evaluate(llmOutput, gitDiff, isDeterministic, expectedSchema = null) {
        const reasons = [];
        
        // 1. Evaluate Schema Completeness
        const { score: schemaScore, missingFields, typeMismatches } = this._evaluateSchema(llmOutput, expectedSchema);
        if (missingFields.length > 0) reasons.push(`Missing expected schema fields: ${missingFields.join(', ')}`);
        if (typeMismatches.length > 0) reasons.push(`Schema type mismatches detected: ${typeMismatches.join(', ')}`);

        // Extract text representation of the summary for text-based heuristics
        const summaryText = typeof llmOutput === 'object' ? JSON.stringify(llmOutput) : String(llmOutput);

        // 2. Evaluate Diff Coverage (Groundedness)
        const { score: diffCoverageScore, missingKeywords } = this._evaluateDiffCoverage(summaryText, gitDiff);
        if (diffCoverageScore < 0.5) reasons.push(`Low diff coverage. Summary may be hallucinated or too generic. Missing key terms like: ${missingKeywords.slice(0, 3).join(', ')}`);

        // 3. Evaluate Determinism
        const determinismScore = isDeterministic ? 1.0 : 0.0;
        if (!isDeterministic) reasons.push('Output flagged as non-deterministic (high variance between LLM passes).');

        // 4. Evaluate Length Sanity
        const { score: lengthScore, feedback: lengthFeedback } = this._evaluateLength(summaryText);
        if (lengthFeedback) reasons.push(lengthFeedback);

        // Calculate weighted total score
        const totalScore = this._normalizeScore(
            (schemaScore * this.config.weights.schema) +
            (diffCoverageScore * this.config.weights.diffCoverage) +
            (determinismScore * this.config.weights.determinism) +
            (lengthScore * this.config.weights.length)
        );

        const accepted = totalScore >= this.config.thresholds.gatekeeperAccept;

        if (!accepted) {
            reasons.unshift(`Total score (${totalScore.toFixed(2)}) fell below the acceptance threshold (${this.config.thresholds.gatekeeperAccept}).`);
        }

        return {
            totalScore: Number(totalScore.toFixed(4)),
            accepted,
            breakdown: {
                schemaScore: Number(schemaScore.toFixed(4)),
                diffCoverageScore: Number(diffCoverageScore.toFixed(4)),
                determinismScore: Number(determinismScore.toFixed(4)),
                lengthScore: Number(lengthScore.toFixed(4))
            },
            reasons,
            metadata: {
                summaryLength: summaryText.length,
                diffLength: gitDiff ? gitDiff.length : 0
            }
        };
    }

    /**
     * Evaluates if the LLM output strictly adheres to the expected JSON schema.
     * 
     * @private
     * @param {Object|string} output - The LLM output to check.
     * @param {Object} schema - Key-value map of expected fields and their typeof strings.
     * @returns {Object} Schema evaluation metrics.
     */
    _evaluateSchema(output, schema) {
        if (!schema || Object.keys(schema).length === 0) {
            // If no strict schema is enforced, but output is valid JSON/Object, give it a pass.
            return { score: typeof output === 'object' ? 1.0 : 0.5, missingFields: [], typeMismatches: [] };
        }

        if (typeof output !== 'object' || output === null) {
            return { score: 0.0, missingFields: Object.keys(schema), typeMismatches: [] };
        }

        let matchedFields = 0;
        const totalFields = Object.keys(schema).length;
        const missingFields = [];
        const typeMismatches = [];

        for (const [key, expectedType] of Object.entries(schema)) {
            if (!(key in output)) {
                missingFields.push(key);
                continue;
            }

            const actualType = Array.isArray(output[key]) ? 'array' : typeof output[key];
            if (actualType !== expectedType && expectedType !== 'any') {
                typeMismatches.push(`${key} (expected ${expectedType}, got ${actualType})`);
                // Partial penalty for type mismatch vs completely missing
                matchedFields += 0.5; 
            } else {
                matchedFields += 1.0;
            }
        }

        const rawScore = matchedFields / totalFields;
        return {
            score: this._normalizeScore(rawScore),
            missingFields,
            typeMismatches
        };
    }

    /**
     * Evaluates length sanity using a trapezoidal membership function.
     * Penalizes outputs that are absurdly short or unnecessarily verbose.
     * 
     * @private
     * @param {string} text - The string representation of the LLM output.
     * @returns {Object} Length evaluation metrics.
     */
    _evaluateLength(text) {
        const len = text.trim().length;
        const { lengthOptimalMin, lengthOptimalMax, lengthAbsoluteMax } = this.config.thresholds;

        if (len === 0) {
            return { score: 0.0, feedback: 'Summary is completely empty.' };
        }

        if (len < lengthOptimalMin) {
            const score = len / lengthOptimalMin;
            return { score: this._normalizeScore(score), feedback: `Summary is critically short (${len} chars). May lack necessary detail.` };
        }

        if (len >= lengthOptimalMin && len <= lengthOptimalMax) {
            return { score: 1.0, feedback: null }; // Perfect sweet spot
        }

        if (len > lengthOptimalMax && len <= lengthAbsoluteMax) {
            // Linear decay from 1.0 down to 0.2 as it approaches absolute max
            const excess = len - lengthOptimalMax;
            const range = lengthAbsoluteMax - lengthOptimalMax;
            const decay = (excess / range) * 0.8; 
            return { score: this._normalizeScore(1.0 - decay), feedback: `Summary is unusually verbose (${len} chars).` };
        }

        // Exceeds absolute max
        return { score: 0.1, feedback: `Summary exceeds absolute maximum length (${len} chars). Highly likely to contain hallucinations or regurgitated logs.` };
    }

    /**
     * Analyzes the git diff to extract core domain keywords and checks if the LLM 
     * summary actually references the work done. This is a critical anti-hallucination metric.
     * 
     * @private
     * @param {string} summary - The LLM generated summary.
     * @param {string} diff - The raw git diff.
     * @returns {Object} Diff coverage metrics.
     */
    _evaluateDiffCoverage(summary, diff) {
        if (!diff || diff.trim() === '') {
            // If there's no diff (e.g., empty commit), we can't measure coverage. 
            // Default to neutral/passing so we don't unfairly penalize.
            return { score: 1.0, missingKeywords: [] };
        }

        // 1. Extract added and removed lines from the diff (ignore context lines)
        const diffLines = diff.split('\n');
        const changedCode = diffLines
            .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
            .map(line => line.substring(1)) // Remove the +/- prefix
            .join(' ');

        // 2. Tokenize and extract keywords from the diff
        const diffTokens = this._tokenizeAndFilter(changedCode);
        const keywordFrequencies = this._calculateFrequencies(diffTokens);
        
        // 3. Get the top N most frequent domain words in the diff
        const topKeywords = Object.entries(keywordFrequencies)
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.config.thresholds.diffKeywordTopN)
            .map(entry => entry[0]);

        if (topKeywords.length === 0) {
            // Diff contained no identifiable keywords (e.g., just punctuation or stop words)
            return { score: 1.0, missingKeywords: [] };
        }

        // 4. Check presence of these top keywords in the summary
        const summaryTokens = new Set(this._tokenizeAndFilter(summary));
        let hits = 0;
        const missingKeywords = [];

        for (const keyword of topKeywords) {
            if (summaryTokens.has(keyword) || summary.toLowerCase().includes(keyword)) {
                hits++;
            } else {
                missingKeywords.push(keyword);
            }
        }

        // 5. Calculate coverage score
        // We don't expect *all* diff keywords to be in a high-level summary.
        // A 50% hit rate on the top N keywords is usually indicative of a perfect, grounded summary.
        // We scale the score so that hitting half the keywords gives a score of 1.0.
        const hitRatio = hits / topKeywords.length;
        const scaledScore = Math.min(1.0, hitRatio * 2.0);

        return {
            score: this._normalizeScore(scaledScore),
            missingKeywords
        };
    }

    /**
     * Tokenizes a string into words, converting to lowercase, removing punctuation, 
     * filtering out stop words, and dropping excessively short/long words.
     * 
     * @private
     * @param {string} text - The text to tokenize.
     * @returns {string[]} Array of valid tokens.
     */
    _tokenizeAndFilter(text) {
        if (!text) return [];
        
        // Replace non-alphanumeric characters with spaces, split by whitespace
        const rawTokens = text.replace(/[^a-zA-Z0-9_]/g, ' ').split(/\s+/);
        
        return rawTokens
            .map(token => token.toLowerCase())
            .filter(token => {
                const len = token.length;
                return len >= 3 && len <= 30 && !STOP_WORDS.has(token) && !/^\d+$/.test(token); // Filter numbers-only
            });
    }

    /**
     * Calculates the frequency of each token in an array.
     * 
     * @private
     * @param {string[]} tokens - Array of string tokens.
     * @returns {Object.<string, number>} Map of token to its frequency count.
     */
    _calculateFrequencies(tokens) {
        const freqs = {};
        for (const token of tokens) {
            freqs[token] = (freqs[token] || 0) + 1;
        }
        return freqs;
    }

    /**
     * Ensures a score is strictly bounded between 0.0 and 1.0.
     * 
     * @private
     * @param {number} score - The raw score.
     * @returns {number} The normalized score.
     */
    _normalizeScore(score) {
        if (Number.isNaN(score)) return 0.0;
        return Math.max(0.0, Math.min(1.0, score));
    }
}

/**
 * Convenience singleton instance for zero-config usage across the pipeline.
 */
export const defaultScorer = new ConfidenceScorer();

/**
 * Procedural helper wrapper for direct pipeline integration.
 * 
 * @param {Object|string} llmOutput - The generated summary payload.
 * @param {string} gitDiff - The original code changes.
 * @param {boolean} isDeterministic - Whether the generation was stable.
 * @param {Object} [schema] - Optional expected schema definition.
 * @returns {ScoringResult}
 */
export function gatekeeper(llmOutput, gitDiff, isDeterministic, schema = null) {
    return defaultScorer.evaluate(llmOutput, gitDiff, isDeterministic, schema);
}