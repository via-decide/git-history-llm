/**
 * @fileoverview Determinism Engine for Git History LLM.
 * 
 * This module enforces strict determinism in Large Language Model (LLM) outputs
 * specifically tailored for git commit history reasoning and summarization. 
 * Because LLMs are inherently stochastic, this engine wraps LLM invocations with
 * a three-stage pipeline:
 * 
 * 1. Input Normalization: Strips non-functional whitespace, sorts diffs, and removes noise.
 * 2. Output Canonicalization: Enforces stable key ordering, normalizes casing, and maps enums.
 * 3. Double-Run Verification: Executes the LLM multiple times and demands hash consensus.
 * 
 * @module core/determinism
 * @requires crypto
 */

const crypto = require('crypto');

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base error class for all determinism-related exceptions.
 * @extends Error
 */
class DeterminismError extends Error {
    /**
     * @param {string} message - Error description.
     */
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Thrown when the input normalization process fails.
 * @extends DeterminismError
 */
class NormalizationError extends DeterminismError {
    /**
     * @param {string} message - Error description.
     * @param {string} rawInput - The input that failed normalization.
     */
    constructor(message, rawInput) {
        super(`Normalization failed: ${message}`);
        this.rawInput = rawInput;
    }
}

/**
 * Thrown when the output canonicalization process fails (e.g., invalid schema).
 * @extends DeterminismError
 */
class CanonicalizationError extends DeterminismError {
    /**
     * @param {string} message - Error description.
     * @param {any} rawOutput - The output that failed canonicalization.
     */
    constructor(message, rawOutput) {
        super(`Canonicalization failed: ${message}`);
        this.rawOutput = rawOutput;
    }
}

/**
 * Thrown when the double-run verification fails to achieve consensus.
 * @extends DeterminismError
 */
class NonDeterministicOutputError extends DeterminismError {
    /**
     * @param {string} hashA - SHA-256 hash of the first run.
     * @param {string} hashB - SHA-256 hash of the second run.
     * @param {any} outputA - Canonicalized output of the first run.
     * @param {any} outputB - Canonicalized output of the second run.
     */
    constructor(hashA, hashB, outputA, outputB) {
        super(`LLM consensus failure. Run 1 (${hashA}) does not match Run 2 (${hashB}).`);
        this.hashA = hashA;
        this.hashB = hashB;
        this.outputA = outputA;
        this.outputB = outputB;
    }
}

// ============================================================================
// CONSTANTS & ENUMS
// ============================================================================

/**
 * The strict set of allowed commit types based on Conventional Commits.
 * @type {Set<string>}
 */
const VALID_COMMIT_TYPES = new Set([
    'feat', 
    'fix', 
    'refactor', 
    'docs', 
    'chore', 
    'test', 
    'style', 
    'ci', 
    'perf', 
    'build',
    'revert'
]);

/**
 * Mapping of common LLM hallucinations or variations to strict commit types.
 * @type {Record<string, string>}
 */
const TYPE_ALIASES = {
    'feature': 'feat',
    'bugfix': 'fix',
    'bug': 'fix',
    'documentation': 'docs',
    'doc': 'docs',
    'optimization': 'perf',
    'performance': 'perf',
    'testing': 'test',
    'tests': 'test',
    'formatting': 'style',
    'maintenance': 'chore',
    'dependency': 'chore',
    'deps': 'chore'
};

// ============================================================================
// INPUT NORMALIZATION
// ============================================================================

/**
 * Handles the sanitization and normalization of raw Git inputs (diffs, logs).
 */
class InputNormalizer {
    /**
     * Normalizes a raw git diff to ensure identical functional changes always
     * produce the exact same input string, regardless of file order or metadata.
     * 
     * @param {string} rawDiff - The raw git diff string.
     * @returns {string} The normalized, deterministic git diff string.
     * @throws {NormalizationError} If the diff structure is entirely unrecognized.
     */
    static normalizeDiff(rawDiff) {
        if (typeof rawDiff !== 'string') {
            throw new NormalizationError('Input diff must be a string.', rawDiff);
        }

        if (!rawDiff.trim()) {
            return '';
        }

        try {
            // 1. Split diff into individual file chunks
            const fileChunks = this._splitDiffIntoFiles(rawDiff);

            // 2. Process and sanitize each chunk
            const sanitizedChunks = fileChunks.map(chunk => this._sanitizeFileChunk(chunk));

            // 3. Sort chunks deterministically by target file path
            sanitizedChunks.sort((a, b) => a.filepath.localeCompare(b.filepath));

            // 4. Recombine into a single normalized string
            return sanitizedChunks.map(chunk => chunk.content).join('\n\n');
        } catch (error) {
            throw new NormalizationError(error.message, rawDiff);
        }
    }

    /**
     * Splits a raw multi-file diff into an array of individual file diff chunks.
     * 
     * @private
     * @param {string} diff - The complete diff string.
     * @returns {Array<string>} Array of raw file diff strings.
     */
    static _splitDiffIntoFiles(diff) {
        const lines = diff.split('\n');
        const chunks = [];
        let currentChunk = [];

        for (const line of lines) {
            if (line.startsWith('diff --git ')) {
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk.join('\n'));
                }
                currentChunk = [line];
            } else {
                currentChunk.push(line);
            }
        }

        if (currentChunk.length > 0) {
            chunks.push(currentChunk.join('\n'));
        }

        return chunks;
    }

    /**
     * Sanitizes a single file's diff chunk, removing timestamps, index hashes,
     * and extracting the file path for sorting purposes.
     * 
     * @private
     * @param {string} chunk - A single file's diff string.
     * @returns {{filepath: string, content: string}} An object containing the sortable filepath and sanitized content.
     */
    static _sanitizeFileChunk(chunk) {
        const lines = chunk.split('\n');
        const sanitizedLines = [];
        let filepath = '';

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Extract filepath from the diff --git line for sorting
            if (line.startsWith('diff --git ')) {
                const parts = line.split(' ');
                // Format: diff --git a/path/to/file b/path/to/file
                filepath = parts.length > 2 ? parts[parts.length - 1].replace(/^b\//, '') : 'unknown';
                sanitizedLines.push(line);
                continue;
            }

            // Remove internal git index hashes (e.g., index 89abcdef..0123456 100644)
            if (line.startsWith('index ')) {
                // We keep the file mode if present, but strip the volatile hashes
                const match = line.match(/index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(.*)/);
                if (match) {
                    sanitizedLines.push(`index [HASH]..[HASH]${match[1]}`);
                } else {
                    sanitizedLines.push('index [HASH]..[HASH]');
                }
                continue;
            }

            // Remove timestamps from --- and +++ lines
            // e.g., --- a/file.txt 2023-10-12 10:00:00.000000000 +0000
            if (line.startsWith('--- a/') || line.startsWith('+++ b/') || line.startsWith('--- /dev/null') || line.startsWith('+++ /dev/null')) {
                const parts = line.split('\t'); // Git often uses tabs for timestamps
                sanitizedLines.push(parts[0].trim());
                continue;
            }

            // Strip trailing whitespace from functional diff lines to prevent token variations
            if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                sanitizedLines.push(line.trimEnd());
                continue;
            }

            sanitizedLines.push(line);
        }

        // Remove multiple consecutive blank lines
        const content = sanitizedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

        return { filepath, content };
    }

    /**
     * Normalizes commit metadata (author, date, etc.) to remove volatile elements.
     * 
     * @param {Record<string, any>} metadata - The raw commit metadata.
     * @returns {Record<string, any>} The deterministic metadata.
     */
    static normalizeMetadata(metadata) {
        if (!metadata || typeof metadata !== 'object') return {};

        const clean = { ...metadata };
        
        // Timestamps often cause LLM variability; remove them if they aren't strictly required
        delete clean.timestamp;
        delete clean.date;
        delete clean.authorDate;
        delete clean.committerDate;

        // Hashes should be truncated or removed to prevent LLMs from over-focusing on them
        if (clean.hash) {
            clean.hash = clean.hash.substring(0, 7);
        }

        return clean;
    }
}

// ============================================================================
// OUTPUT CANONICALIZATION
// ============================================================================

/**
 * Handles the stabilization and canonicalization of LLM outputs.
 */
class OutputCanonicalizer {
    /**
     * Canonicalizes an LLM output payload.
     * Ensures consistent JSON formatting, key ordering, and enum mappings.
     * 
     * @param {string|object} llmOutput - The raw output from the LLM.
     * @returns {string} A strictly formatted, deterministic JSON string.
     * @throws {CanonicalizationError} If the output cannot be parsed or canonicalized.
     */
    static canonicalize(llmOutput) {
        let parsed;

        try {
            parsed = typeof llmOutput === 'string' ? JSON.parse(llmOutput) : llmOutput;
        } catch (err) {
            // Attempt to extract JSON from markdown code blocks if raw parsing fails
            const extracted = this._extractJsonFromMarkdown(llmOutput);
            if (extracted) {
                try {
                    parsed = JSON.parse(extracted);
                } catch (innerErr) {
                    throw new CanonicalizationError('Output is not valid JSON even after markdown extraction.', llmOutput);
                }
            } else {
                throw new CanonicalizationError('Output is not valid JSON.', llmOutput);
            }
        }

        if (parsed === null || typeof parsed !== 'object') {
            throw new CanonicalizationError('Output must be a JSON object or array.', parsed);
        }

        const stabilized = this._deepCanonicalize(parsed);
        
        // Return stringified version with 0 spaces to ensure deterministic hashing
        return JSON.stringify(stabilized);
    }

    /**
     * Attempts to find and extract a JSON block from a markdown-formatted string.
     * 
     * @private
     * @param {string} text - The raw LLM text response.
     * @returns {string|null} The extracted JSON string, or null if not found.
     */
    static _extractJsonFromMarkdown(text) {
        if (typeof text !== 'string') return null;
        const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        return match ? match[1].trim() : null;
    }

    /**
     * Recursively processes objects and arrays to enforce determinism.
     * 
     * @private
     * @param {any} node - The current node in the JSON tree.
     * @returns {any} The canonicalized node.
     */
    static _deepCanonicalize(node) {
        if (Array.isArray(node)) {
            // For arrays, we canonicalize each element.
            // Note: We do NOT sort arrays by default unless they are arrays of primitive strings,
            // because array order is often semantically meaningful (e.g., chronological steps).
            const canonicalArray = node.map(item => this._deepCanonicalize(item));
            
            if (canonicalArray.length > 0 && typeof canonicalArray[0] === 'string') {
                return canonicalArray.sort();
            }
            return canonicalArray;
        }

        if (node !== null && typeof node === 'object') {
            const sortedKeys = Object.keys(node).sort();
            const canonicalObj = {};

            for (const key of sortedKeys) {
                let value = node[key];

                // Apply domain-specific normalizations
                if (key === 'type' && typeof value === 'string') {
                    value = this._normalizeCommitType(value);
                } else if (key === 'scope' && typeof value === 'string') {
                    value = value.toLowerCase().trim();
                } else if (typeof value === 'string') {
                    value = value.trim();
                }

                canonicalObj[key] = this._deepCanonicalize(value);
            }

            return canonicalObj;
        }

        // Primitives are returned as-is (with strings already trimmed above if in an object)
        if (typeof node === 'string') {
            return node.trim();
        }

        return node;
    }

    /**
     * Maps an arbitrary commit type string to a strict conventional commit enum.
     * 
     * @private
     * @param {string} rawType - The raw type string from the LLM.
     * @returns {string} The canonical commit type.
     */
    static _normalizeCommitType(rawType) {
        const normalized = rawType.toLowerCase().trim();
        
        if (VALID_COMMIT_TYPES.has(normalized)) {
            return normalized;
        }

        if (TYPE_ALIASES[normalized]) {
            return TYPE_ALIASES[normalized];
        }

        // Fallback for unknown types to maintain strict schema compliance
        // If the LLM generates something completely wild, we default to 'chore'
        return 'chore';
    }
}

// ============================================================================
// VERIFICATION ENGINE
// ============================================================================

/**
 * Orchestrates the double-run verification process to guarantee consensus.
 */
class DeterminismEngine {
    /**
     * Executes an LLM function with strict determinism guarantees.
     * The engine will run the function twice. If the canonicalized outputs
     * match, it succeeds. If they differ, it will retry up to `maxRetries`.
     * 
     * @param {Function} llmCallable - An async function that takes normalized input and returns LLM output.
     * @param {string} rawDiff - The raw git diff input.
     * @param {Record<string, any>} [rawMetadata={}] - Optional commit metadata.
     * @param {Object} [options] - Configuration options.
     * @param {number} [options.maxRetries=2] - Maximum number of verification retries.
     * @param {boolean} [options.throwOnFailure=true] - Whether to throw an error if consensus is never reached.
     * @returns {Promise<Object>} The final, canonicalized parsed JSON object.
     * @throws {NonDeterministicOutputError} If consensus cannot be reached and throwOnFailure is true.
     */
    static async executeStrict(llmCallable, rawDiff, rawMetadata = {}, options = {}) {
        const config = {
            maxRetries: 2,
            throwOnFailure: true,
            ...options
        };

        // 1. Normalize Inputs
        const normalizedDiff = InputNormalizer.normalizeDiff(rawDiff);
        const normalizedMetadata = InputNormalizer.normalizeMetadata(rawMetadata);
        
        const payload = {
            diff: normalizedDiff,
            metadata: normalizedMetadata
        };

        let attempts = 0;

        while (attempts <= config.maxRetries) {
            attempts++;

            try {
                // 2. Execute Double Run Concurrently
                const [rawOutputA, rawOutputB] = await Promise.all([
                    llmCallable(payload),
                    llmCallable(payload)
                ]);

                // 3. Canonicalize Outputs
                const canonicalA = OutputCanonicalizer.canonicalize(rawOutputA);
                const canonicalB = OutputCanonicalizer.canonicalize(rawOutputB);

                // 4. Hash Generation
                const hashA = this._generateHash(canonicalA);
                const hashB = this._generateHash(canonicalB);

                // 5. Consensus Verification
                if (hashA === hashB) {
                    // Consensus reached! Parse the canonical string back to an object for the consumer.
                    return JSON.parse(canonicalA);
                }

                // If hashes don't match, log the deviation (in a real system, use a logger)
                console.warn(`[DeterminismEngine] Consensus failure on attempt ${attempts}.`);
                console.warn(`Hash A: ${hashA}`);
                console.warn(`Hash B: ${hashB}`);

                if (attempts > config.maxRetries && config.throwOnFailure) {
                    throw new NonDeterministicOutputError(
                        hashA, 
                        hashB, 
                        JSON.parse(canonicalA), 
                        JSON.parse(canonicalB)
                    );
                }

            } catch (error) {
                // If the error is a canonicalization error (e.g., LLM returned garbage),
                // we treat it as a failed attempt and retry.
                if (error instanceof CanonicalizationError) {
                    console.warn(`[DeterminismEngine] Canonicalization failure on attempt ${attempts}: ${error.message}`);
                    if (attempts > config.maxRetries && config.throwOnFailure) {
                        throw error;
                    }
                } else {
                    // For unexpected errors (network, auth, etc.), fail immediately
                    throw error;
                }
            }
        }

        // If throwOnFailure is false and we exhausted retries, return null
        return null;
    }

    /**
     * Generates a SHA-256 hash of a string.
     * 
     * @private
     * @param {string} data - The data to hash.
     * @returns {string} The hex representation of the SHA-256 hash.
     */
    static _generateHash(data) {
        return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    DeterminismEngine,
    InputNormalizer,
    OutputCanonicalizer,
    DeterminismError,
    NormalizationError,
    CanonicalizationError,
    NonDeterministicOutputError,
    VALID_COMMIT_TYPES
};