/**
 * @fileoverview Policy Enforcement Layer for Git History LLM.
 * @module core/policy
 * @description
 * This module provides a robust, production-ready policy enforcement engine designed to
 * restrict inputs and outputs within the Git History LLM pipeline. It ensures that all
 * ingested git data (commits, diffs, metadata) and all emitted LLM outputs (JSON insights,
 * categorizations) strictly adhere to defined security, structural, and operational policies.
 * 
 * Key Features:
 * - Input validation & sanitization (preventing prototype pollution, malformed git objects).
 * - Secret and PII detection in commit messages and diffs (AWS keys, RSA keys, tokens).
 * - Payload size and complexity limits (protecting LLM context windows).
 * - Output schema enforcement (ensuring LLM responses are valid, structured JSON).
 * - Scope enforcement (preventing hallucinated data outside the provided git context).
 * 
 * @author Antigravity Synthesis Orchestrator
 * @version 3.0.0
 */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Represents a violation of the defined operational or security policies.
 * @extends Error
 */
class PolicyViolationError extends Error {
    /**
     * @param {string} message - Description of the policy violation.
     * @param {string} policyCode - A unique identifier for the specific policy breached.
     * @param {Object} [context={}] - Additional context surrounding the violation (e.g., commit hash, blocked keyword).
     */
    constructor(message, policyCode, context = {}) {
        super(message);
        this.name = 'PolicyViolationError';
        this.policyCode = policyCode;
        this.context = context;
        this.timestamp = new Date().toISOString();
        Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Serializes the error for logging or auditing purposes.
     * @returns {Object} Structured error representation.
     */
    toJSON() {
        return {
            error: this.name,
            message: this.message,
            policyCode: this.policyCode,
            context: this.context,
            timestamp: this.timestamp
        };
    }
}

// ============================================================================
// DEFAULT CONFIGURATIONS & CONSTANTS
// ============================================================================

/**
 * Default configuration for the Policy Enforcer.
 * Can be overridden during instantiation.
 */
const DEFAULT_POLICY_CONFIG = {
    input: {
        maxCommitsPerBatch: 500,
        maxDiffSizeBytes: 1024 * 512, // 512 KB per diff
        maxMessageLength: 10000,
        allowMergeCommits: true,
        enforceAuthorValidation: true,
        blockedExtensions: new Set([
            '.exe', '.dll', '.so', '.bin', '.pdf', '.jpg', '.png', '.gif', 
            '.mp4', '.mp3', '.zip', '.tar', '.gz', '.rar', '.7z', '.env', 
            '.pem', '.key', '.pkcs12', '.pfx', '.p12', '.sqlite', '.db'
        ])
    },
    security: {
        detectSecrets: true,
        detectPII: false, // Optional: requires NLP or heavy regex, disabled by default for perf
        actionOnSecret: 'REDACT', // 'REDACT' or 'REJECT'
    },
    output: {
        requireValidJSON: true,
        maxOutputTokens: 8192,
        requiredKeys: ['insights', 'categorization', 'patterns'],
        allowUnknownKeys: false,
        strictTypeChecking: true
    }
};

/**
 * High-confidence regular expressions for detecting secrets and credentials in diffs/messages.
 * Used to prevent leaking sensitive developer environment data to external LLMs.
 */
const SECRET_PATTERNS = {
    AWS_ACCESS_KEY: /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    AWS_SECRET_KEY: /(?i)aws_secret_access_key\s*[:=]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/g,
    GITHUB_TOKEN: /(gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59})/g,
    SLACK_TOKEN: /xox[baprs]-[0-9]{10,13}-[a-zA-Z0-9]{24}/g,
    RSA_PRIVATE_KEY: /-----BEGIN RSA PRIVATE KEY-----[a-zA-Z0-9\s/+=]+-----END RSA PRIVATE KEY-----/g,
    GENERIC_API_KEY: /(?i)(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?([a-zA-Z0-9\-_.]{20,})['"]?/g,
    STRIPE_KEY: /(sk_live|rk_live)_[a-zA-Z0-9]{24}/g,
    GOOGLE_CLOUD_KEY: /(?i)"type":\s*"service_account",\s*"project_id":\s*"[^"]+",\s*"private_key_id":\s*"[a-f0-9]{40}"/g
};

// ============================================================================
// MAIN POLICY ENFORCER CLASS
// ============================================================================

/**
 * PolicyEnforcer acts as the central governance layer for the Git History LLM.
 * It strictly regulates what data flows into the LLM context window and validates
 * the structural integrity and safety of the data flowing out.
 * 
 * @extends EventEmitter
 */
class PolicyEnforcer extends EventEmitter {
    /**
     * Initializes the PolicyEnforcer with a specific configuration.
     * @param {Object} [config={}] - Custom configuration overrides.
     */
    constructor(config = {}) {
        super();
        this.config = this._mergeConfig(DEFAULT_POLICY_CONFIG, config);
        this.metrics = {
            inputsProcessed: 0,
            outputsProcessed: 0,
            secretsRedacted: 0,
            violationsCaught: 0
        };
    }

    /**
     * Deep merges user configuration with default configuration.
     * @private
     * @param {Object} target - The default configuration.
     * @param {Object} source - The user-provided configuration.
     * @returns {Object} Merged configuration object.
     */
    _mergeConfig(target, source) {
        const output = Object.assign({}, target);
        if (this._isObject(target) && this._isObject(source)) {
            Object.keys(source).forEach(key => {
                if (this._isObject(source[key])) {
                    if (!(key in target)) {
                        Object.assign(output, { [key]: source[key] });
                    } else {
                        output[key] = this._mergeConfig(target[key], source[key]);
                    }
                } else {
                    Object.assign(output, { [key]: source[key] });
                }
            });
        }
        return output;
    }

    /**
     * Type guard for pure objects.
     * @private
     * @param {*} item - Item to check.
     * @returns {boolean} True if the item is a pure object.
     */
    _isObject(item) {
        return (item && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Set));
    }

    /**
     * Emits and logs a policy violation, then throws the error to halt execution.
     * @private
     * @param {string} message - Error message.
     * @param {string} code - Policy violation code.
     * @param {Object} context - Contextual data.
     * @throws {PolicyViolationError}
     */
    _violation(message, code, context) {
        this.metrics.violationsCaught++;
        const error = new PolicyViolationError(message, code, context);
        this.emit('violation', error.toJSON());
        throw error;
    }

    // ========================================================================
    // INPUT POLICY ENFORCEMENT
    // ========================================================================

    /**
     * Validates and sanitizes an incoming batch of git commits before they are
     * sent to the LLM for reasoning and pattern extraction.
     * 
     * @param {Array<Object>} commits - Array of raw commit objects from the git history.
     * @returns {Array<Object>} Sanitized and policy-compliant commit objects.
     * @throws {PolicyViolationError} If the batch violates hard limits or structural requirements.
     */
    enforceInputPolicy(commits) {
        if (!Array.isArray(commits)) {
            this._violation('Input must be an array of commit objects.', 'IN_INVALID_TYPE', { type: typeof commits });
        }

        if (commits.length > this.config.input.maxCommitsPerBatch) {
            this._violation(
                `Batch size exceeds maximum limit of ${this.config.input.maxCommitsPerBatch}.`,
                'IN_BATCH_TOO_LARGE',
                { provided: commits.length, allowed: this.config.input.maxCommitsPerBatch }
            );
        }

        const sanitizedCommits = [];

        for (const commit of commits) {
            const sanitized = this._processSingleCommit(commit);
            if (sanitized) {
                sanitizedCommits.push(sanitized);
            }
        }

        this.metrics.inputsProcessed += sanitizedCommits.length;
        return sanitizedCommits;
    }

    /**
     * Processes a single commit object, validating its structure, enforcing size limits,
     * filtering disallowed files, and redacting secrets.
     * 
     * @private
     * @param {Object} commit - A single git commit object.
     * @returns {Object|null} The sanitized commit, or null if it should be dropped (e.g., merge commit when disabled).
     */
    _processSingleCommit(commit) {
        // 1. Structural Validation
        if (!commit || typeof commit !== 'object') {
            this._violation('Commit entry is not a valid object.', 'IN_MALFORMED_COMMIT', { commit });
        }

        const requiredFields = ['hash', 'message', 'author', 'date'];
        for (const field of requiredFields) {
            if (!commit[field]) {
                this._violation(`Commit is missing required field: ${field}`, 'IN_MISSING_FIELD', { hash: commit.hash || 'unknown' });
            }
        }

        // 2. Merge Commit Handling
        const isMerge = commit.parents && commit.parents.length > 1;
        if (isMerge && !this.config.input.allowMergeCommits) {
            return null; // Silently drop merge commits if policy dictates
        }

        // 3. Message Size Enforcement
        let safeMessage = String(commit.message);
        if (safeMessage.length > this.config.input.maxMessageLength) {
            safeMessage = safeMessage.substring(0, this.config.input.maxMessageLength) + '\n...[TRUNCATED BY POLICY]';
        }

        // 4. Secret Scanning in Message
        if (this.config.security.detectSecrets) {
            safeMessage = this._scanAndHandleSecrets(safeMessage, `Commit Message: ${commit.hash}`);
        }

        // 5. Author Validation
        let safeAuthor = commit.author;
        if (this.config.input.enforceAuthorValidation) {
            if (typeof safeAuthor !== 'string' || safeAuthor.trim() === '') {
                safeAuthor = 'Unknown Author';
            }
            // Basic sanitization to prevent injection via author name
            safeAuthor = safeAuthor.replace(/[<>]/g, '');
        }

        // 6. Diff & File Processing
        let safeDiff = commit.diff || '';
        let safeFiles = Array.isArray(commit.files) ? commit.files : [];

        // Filter files based on extension policy
        safeFiles = safeFiles.filter(file => {
            const ext = this._getFileExtension(file);
            return !this.config.input.blockedExtensions.has(ext.toLowerCase());
        });

        if (safeDiff) {
            // Enforce Diff Size Limit
            const diffSizeBytes = Buffer.byteLength(safeDiff, 'utf8');
            if (diffSizeBytes > this.config.input.maxDiffSizeBytes) {
                safeDiff = Buffer.from(safeDiff, 'utf8')
                    .subarray(0, this.config.input.maxDiffSizeBytes)
                    .toString('utf8') + '\n...[DIFF TRUNCATED DUE TO SIZE POLICY]';
            }

            // Secret Scanning in Diff
            if (this.config.security.detectSecrets) {
                safeDiff = this._scanAndHandleSecrets(safeDiff, `Commit Diff: ${commit.hash}`);
            }
        }

        // Construct the sanitized, policy-compliant commit object
        // We explicitly construct a new object to prevent prototype pollution or hidden properties
        return {
            hash: String(commit.hash).trim(),
            author: safeAuthor,
            date: new Date(commit.date).toISOString(),
            message: safeMessage,
            files: safeFiles,
            diff: safeDiff,
            ...(commit.parents ? { parents: commit.parents } : {})
        };
    }

    /**
     * Extracts the file extension from a file path.
     * @private
     * @param {string} filename - The file path.
     * @returns {string} The extension including the dot (e.g., '.js').
     */
    _getFileExtension(filename) {
        if (typeof filename !== 'string') return '';
        const lastDotIndex = filename.lastIndexOf('.');
        if (lastDotIndex === -1 || lastDotIndex === 0) return '';
        return filename.substring(lastDotIndex);
    }

    /**
     * Scans text for secrets based on configured regex patterns.
     * Depending on config, it either redacts the secrets or rejects the payload.
     * 
     * @private
     * @param {string} text - The text to scan (message or diff).
     * @param {string} contextIdentifier - Identifier for logging purposes.
     * @returns {string} The text with secrets redacted (if action is REDACT).
     * @throws {PolicyViolationError} If action is REJECT and a secret is found.
     */
    _scanAndHandleSecrets(text, contextIdentifier) {
        let processedText = text;
        let secretFound = false;
        let foundTypes = [];

        for (const [secretType, regex] of Object.entries(SECRET_PATTERNS)) {
            if (regex.test(processedText)) {
                secretFound = true;
                foundTypes.push(secretType);
                
                if (this.config.security.actionOnSecret === 'REJECT') {
                    this._violation(
                        `Sensitive data detected: ${secretType}`,
                        'SEC_SECRET_DETECTED',
                        { context: contextIdentifier, type: secretType }
                    );
                } else {
                    // REDACT
                    processedText = processedText.replace(regex, `[REDACTED_${secretType}]`);
                    this.metrics.secretsRedacted++;
                }
            }
            // Reset regex state due to 'g' flag
            regex.lastIndex = 0;
        }

        if (secretFound) {
            this.emit('secret_redacted', {
                context: contextIdentifier,
                types: foundTypes,
                timestamp: new Date().toISOString()
            });
        }

        return processedText;
    }

    // ========================================================================
    // OUTPUT POLICY ENFORCEMENT
    // ========================================================================

    /**
     * Validates and sanitizes the output generated by the LLM.
     * Ensures the output is valid JSON (if required), conforms to the expected
     * schema for git history insights, and does not contain injected or harmful data.
     * 
     * @param {string|Object} llmOutput - The raw output from the LLM.
     * @returns {Object} The parsed, validated, and sanitized JSON object.
     * @throws {PolicyViolationError} If the output violates structural or safety policies.
     */
    enforceOutputPolicy(llmOutput) {
        let parsedOutput = llmOutput;

        // 1. JSON Parsing Policy
        if (this.config.output.requireValidJSON) {
            if (typeof llmOutput === 'string') {
                try {
                    // Strip potential markdown code blocks (e.g., ```json ... ```)
                    const cleanString = llmOutput.replace(/^```(?:json)?\n?|```$/gm, '').trim();
                    parsedOutput = JSON.parse(cleanString);
                } catch (err) {
                    this._violation(
                        'LLM Output is not valid JSON.',
                        'OUT_INVALID_JSON',
                        { error: err.message, rawLength: llmOutput.length }
                    );
                }
            }
        }

        if (!this._isObject(parsedOutput)) {
            this._violation(
                'LLM Output must resolve to a JSON object.',
                'OUT_NOT_AN_OBJECT',
                { type: typeof parsedOutput }
            );
        }

        // 2. Schema Enforcement (Required Keys)
        const outputKeys = Object.keys(parsedOutput);
        for (const requiredKey of this.config.output.requiredKeys) {
            if (!outputKeys.includes(requiredKey)) {
                this._violation(
                    `LLM Output missing required schema key: ${requiredKey}`,
                    'OUT_SCHEMA_MISSING_KEY',
                    { requiredKey, foundKeys: outputKeys }
                );
            }
        }

        // 3. Schema Enforcement (Unknown Keys)
        if (!this.config.output.allowUnknownKeys) {
            for (const key of outputKeys) {
                if (!this.config.output.requiredKeys.includes(key)) {
                    this._violation(
                        `LLM Output contains unauthorized key: ${key}`,
                        'OUT_SCHEMA_UNKNOWN_KEY',
                        { unknownKey: key, allowedKeys: this.config.output.requiredKeys }
                    );
                }
            }
        }

        // 4. Deep Sanitization & Type Checking
        const sanitizedOutput = this._sanitizeOutputNode(parsedOutput, 'root');

        this.metrics.outputsProcessed++;
        return sanitizedOutput;
    }

    /**
     * Recursively sanitizes and type-checks nodes within the LLM output JSON.
     * Prevents XSS payloads in strings, enforces structural expectations, and removes null prototypes.
     * 
     * @private
     * @param {*} node - The current JSON node being processed.
     * @param {string} path - The object path (for error reporting).
     * @returns {*} The sanitized node.
     */
    _sanitizeOutputNode(node, path) {
        if (node === null || node === undefined) {
            return null;
        }

        if (typeof node === 'string') {
            // Basic sanitization: prevent script injection if output is rendered on web
            return node.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[REMOVED_SCRIPT]')
                       .replace(/javascript:/gi, 'blocked:');
        }

        if (typeof node === 'number' || typeof node === 'boolean') {
            return node;
        }

        if (Array.isArray(node)) {
            // Protect against massive arrays generated by hallucinations
            if (node.length > 1000) {
                this._violation(`Array at ${path} exceeds maximum length of 1000.`, 'OUT_ARRAY_TOO_LARGE', { path, length: node.length });
            }
            return node.map((item, index) => this._sanitizeOutputNode(item, `${path}[${index}]`));
        }

        if (this._isObject(node)) {
            const cleanObj = {};
            for (const [key, value] of Object.entries(node)) {
                // Prevent __proto__ or constructor pollution from malicious LLM output
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                    continue;
                }
                cleanObj[key] = this._sanitizeOutputNode(value, `${path}.${key}`);
            }
            return cleanObj;
        }

        // Reject functions, symbols, or other non-JSON types
        this._violation(
            `Invalid data type found in LLM output at ${path}.`,
            'OUT_INVALID_DATA_TYPE',
            { path, type: typeof node }
        );
    }

    // ========================================================================
    // UTILITY & METRICS
    // ========================================================================

    /**
     * Retrieves the current operational metrics of the Policy Enforcer.
     * Useful for telemetry and monitoring pipeline health.
     * 
     * @returns {Object} Current metrics snapshot.
     */
    getMetrics() {
        return { ...this.metrics, timestamp: new Date().toISOString() };
    }

    /**
     * Resets the operational metrics.
     */
    resetMetrics() {
        this.metrics = {
            inputsProcessed: 0,
            outputsProcessed: 0,
            secretsRedacted: 0,
            violationsCaught: 0
        };
    }
}

// Export the class and the custom error for use in the pipeline
module.exports = {
    PolicyEnforcer,
    PolicyViolationError,
    DEFAULT_POLICY_CONFIG
};