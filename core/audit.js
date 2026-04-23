'use strict';

/**
 * @fileoverview Tamper-Evident Audit Logging System
 * 
 * Provides an immutable, cryptographically verifiable audit trail for all
 * control-plane and authentication events within the Git History LLM system.
 * Utilizes cryptographic hash chaining (similar to a blockchain) and optional
 * HMAC signing to ensure that once a log entry is written, it cannot be altered,
 * reordered, or removed without breaking the chain and raising a tamper alert.
 * 
 * Designed for compliance (SOC2, ISO27001) and forensic analysis.
 * 
 * @module core/audit
 * @requires crypto
 * @requires fs
 * @requires path
 * @requires os
 * @requires readline
 * @requires events
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { EventEmitter } = require('events');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {Object} AuditMetadata
 * @property {string} [ipAddress] - Originating IP address
 * @property {string} [userAgent] - Client user agent
 * @property {string} [sessionId] - Active session identifier
 * @property {Object} [changes] - Diff of changes for control plane events
 * @property {string} [reason] - Justification or context for the action
 * @property {Object} [additionalContext] - Any other relevant JSON-serializable data
 */

/**
 * @typedef {Object} AuditLogEntry
 * @property {string} eventId - Unique UUIDv4 for the event
 * @property {string} timestamp - ISO 8601 timestamp of when the event occurred
 * @property {string} category - Event category (e.g., AUTH, CONTROL_PLANE)
 * @property {string} action - Specific action taken (e.g., LOGIN, CONFIG_UPDATE)
 * @property {string} actor - Identity of the user/service performing the action
 * @property {string} resource - The system, file, or entity being acted upon
 * @property {string} status - Outcome of the action (SUCCESS, FAILURE, DENIED)
 * @property {AuditMetadata} metadata - Additional contextual data
 * @property {Object} systemContext - Hostname, PID, Node version, etc.
 * @property {string} previousHash - SHA-256 hash of the preceding log entry
 * @property {string} hash - SHA-256 hash of the current entry (including previousHash)
 * @property {string} [signature] - Optional HMAC signature of the hash using a secret key
 */

// ============================================================================
// Constants & Enums
// ============================================================================

const AUDIT_CATEGORIES = Object.freeze({
    AUTHENTICATION: 'AUTHENTICATION',
    AUTHORIZATION: 'AUTHORIZATION',
    CONTROL_PLANE: 'CONTROL_PLANE',
    DATA_ACCESS: 'DATA_ACCESS',
    SYSTEM: 'SYSTEM'
});

const AUDIT_ACTIONS = Object.freeze({
    // Authentication
    LOGIN_ATTEMPT: 'LOGIN_ATTEMPT',
    LOGIN_SUCCESS: 'LOGIN_SUCCESS',
    LOGIN_FAILURE: 'LOGIN_FAILURE',
    LOGOUT: 'LOGOUT',
    TOKEN_ISSUE: 'TOKEN_ISSUE',
    TOKEN_REVOKE: 'TOKEN_REVOKE',
    
    // Control Plane / Configuration
    CONFIG_READ: 'CONFIG_READ',
    CONFIG_UPDATE: 'CONFIG_UPDATE',
    PIPELINE_START: 'PIPELINE_START',
    PIPELINE_STOP: 'PIPELINE_STOP',
    MODEL_WEIGHTS_UPDATE: 'MODEL_WEIGHTS_UPDATE',
    PROMPT_TEMPLATE_MODIFIED: 'PROMPT_TEMPLATE_MODIFIED',
    
    // System
    SYSTEM_STARTUP: 'SYSTEM_STARTUP',
    SYSTEM_SHUTDOWN: 'SYSTEM_SHUTDOWN',
    AUDIT_CHAIN_VERIFY: 'AUDIT_CHAIN_VERIFY',
    AUDIT_LOG_ROTATED: 'AUDIT_LOG_ROTATED'
});

const AUDIT_STATUS = Object.freeze({
    SUCCESS: 'SUCCESS',
    FAILURE: 'FAILURE',
    DENIED: 'DENIED',
    PENDING: 'PENDING',
    ERROR: 'ERROR'
});

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
const DEFAULT_LOG_DIR = path.join(process.cwd(), 'logs', 'audit');
const DEFAULT_LOG_FILE = 'audit_chain.jsonl';

// ============================================================================
// Custom Error Classes
// ============================================================================

class AuditError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

class AuditTamperEvidentError extends AuditError {
    constructor(message, entryId, expectedHash, actualHash) {
        super(`Audit log tampering detected! ${message}`);
        this.entryId = entryId;
        this.expectedHash = expectedHash;
        this.actualHash = actualHash;
    }
}

class AuditInitializationError extends AuditError {
    constructor(message, cause) {
        super(`Failed to initialize audit logger: ${message}`);
        this.cause = cause;
    }
}

// ============================================================================
// Main Audit Logger Class
// ============================================================================

/**
 * TamperEvidentAuditLogger
 * 
 * Manages the append-only, cryptographically linked audit log.
 * Emits events: 'entry', 'tamper_detected', 'error', 'initialized'
 */
class TamperEvidentAuditLogger extends EventEmitter {
    
    /**
     * @param {Object} options Configuration options
     * @param {string} [options.logDirectory] Directory to store audit logs
     * @param {string} [options.logFilename] Name of the audit log file
     * @param {string} [options.hmacSecret] Secret key for signing log entries (highly recommended)
     * @param {boolean} [options.syncWrites=false] If true, uses synchronous file writes (safer, but blocks event loop)
     */
    constructor(options = {}) {
        super();
        this.logDirectory = options.logDirectory || DEFAULT_LOG_DIR;
        this.logFilename = options.logFilename || DEFAULT_LOG_FILE;
        this.logFilePath = path.join(this.logDirectory, this.logFilename);
        this.hmacSecret = options.hmacSecret || process.env.AUDIT_HMAC_SECRET || null;
        this.syncWrites = options.syncWrites || false;
        
        this.lastHash = null;
        this.isInitialized = false;
        
        // Write queue to ensure strict sequential ordering for hash chaining
        // even during high-concurrency asynchronous logging events.
        this._writeQueue = Promise.resolve();
        
        // System context cached at startup
        this.systemContext = {
            hostname: os.hostname(),
            platform: os.platform(),
            release: os.release(),
            pid: process.pid,
            nodeVersion: process.version
        };
    }

    /**
     * Initializes the logger. Ensures directory exists, opens the file,
     * and reads the last entry to recover the hash chain state.
     * Must be called before logging.
     * 
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            // Ensure directory exists
            if (!fs.existsSync(this.logDirectory)) {
                fs.mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 }); // Restrictive permissions
            }

            // Check if file exists. If not, create it and write the genesis block
            if (!fs.existsSync(this.logFilePath)) {
                fs.writeFileSync(this.logFilePath, '', { mode: 0o600 });
                this.lastHash = GENESIS_HASH;
                await this._writeGenesisBlock();
            } else {
                // Recover last hash from the existing file
                this.lastHash = await this._recoverLastHash();
                if (!this.lastHash) {
                    this.lastHash = GENESIS_HASH;
                    await this._writeGenesisBlock();
                }
            }

            this.isInitialized = true;
            this.emit('initialized', { logFilePath: this.logFilePath, lastHash: this.lastHash });
            
            // Log the startup event securely
            await this.logSystemEvent(
                AUDIT_ACTIONS.SYSTEM_STARTUP,
                'SYSTEM',
                'AuditLogger',
                AUDIT_STATUS.SUCCESS,
                { message: 'Tamper-evident audit logger initialized successfully' }
            );

        } catch (error) {
            throw new AuditInitializationError(error.message, error);
        }
    }

    /**
     * Recovers the hash of the last entry in the log file to resume the chain.
     * @private
     * @returns {Promise<string|null>} The last hash, or null if file is empty
     */
    _recoverLastHash() {
        return new Promise((resolve, reject) => {
            let lastLine = '';
            const stream = fs.createReadStream(this.logFilePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (line.trim()) {
                    lastLine = line;
                }
            });

            rl.on('close', () => {
                if (!lastLine) {
                    resolve(null);
                    return;
                }
                try {
                    const lastEntry = JSON.parse(lastLine);
                    resolve(lastEntry.hash);
                } catch (err) {
                    // If the last line is corrupted, the chain is broken.
                    reject(new AuditTamperEvidentError('Log file corruption detected during initialization. Last line is not valid JSON.'));
                }
            });

            rl.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Writes the initial genesis block to start the hash chain.
     * @private
     * @returns {Promise<void>}
     */
    async _writeGenesisBlock() {
        const genesisEntry = {
            eventId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            category: AUDIT_CATEGORIES.SYSTEM,
            action: 'GENESIS_BLOCK_CREATED',
            actor: 'SYSTEM',
            resource: 'AuditLog',
            status: AUDIT_STATUS.SUCCESS,
            metadata: { message: 'Initialization of tamper-evident log chain' },
            systemContext: this.systemContext,
            previousHash: GENESIS_HASH
        };

        const { hash, signature } = this._computeHashAndSignature(genesisEntry);
        genesisEntry.hash = hash;
        if (signature) genesisEntry.signature = signature;

        this.lastHash = hash;
        
        const line = JSON.stringify(genesisEntry) + '\n';
        if (this.syncWrites) {
            fs.appendFileSync(this.logFilePath, line, { mode: 0o600 });
        } else {
            await fs.promises.appendFile(this.logFilePath, line, { mode: 0o600 });
        }
    }

    /**
     * Computes the SHA-256 hash of an entry, and optionally an HMAC signature.
     * @private
     * @param {Object} entryData The log entry data without the hash/signature fields
     * @returns {{hash: string, signature: string|null}}
     */
    _computeHashAndSignature(entryData) {
        // Deterministic serialization: sort keys to ensure consistent hashing
        const sortedData = Object.keys(entryData).sort().reduce((obj, key) => {
            obj[key] = entryData[key];
            return obj;
        }, {});
        
        const serializedData = JSON.stringify(sortedData);
        
        // Compute SHA-256 Hash
        const hash = crypto.createHash('sha256')
                           .update(serializedData)
                           .digest('hex');
        
        // Compute HMAC Signature if secret is provided
        let signature = null;
        if (this.hmacSecret) {
            signature = crypto.createHmac('sha512', this.hmacSecret)
                              .update(hash)
                              .digest('hex');
        }

        return { hash, signature };
    }

    /**
     * Core logging function. Enqueues the write operation to maintain chain integrity.
     * 
     * @param {string} category From AUDIT_CATEGORIES
     * @param {string} action From AUDIT_ACTIONS or custom string
     * @param {string} actor Identity of the user/process
     * @param {string} resource The target of the action
     * @param {string} status From AUDIT_STATUS
     * @param {AuditMetadata} [metadata={}] Additional context
     * @returns {Promise<AuditLogEntry>} The completed log entry
     */
    log(category, action, actor, resource, status, metadata = {}) {
        if (!this.isInitialized) {
            return Promise.reject(new AuditError('Audit logger must be initialized before logging.'));
        }

        const task = async () => {
            const entry = {
                eventId: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                category,
                action,
                actor,
                resource,
                status,
                metadata,
                systemContext: this.systemContext,
                previousHash: this.lastHash
            };

            const { hash, signature } = this._computeHashAndSignature(entry);
            entry.hash = hash;
            if (signature) entry.signature = signature;

            const line = JSON.stringify(entry) + '\n';

            try {
                if (this.syncWrites) {
                    fs.appendFileSync(this.logFilePath, line);
                } else {
                    await fs.promises.appendFile(this.logFilePath, line);
                }
                
                // Update the chain state ONLY after successful write
                this.lastHash = hash;
                this.emit('entry', entry);
                return entry;
            } catch (error) {
                this.emit('error', new AuditError(`Failed to write audit log entry: ${error.message}`));
                throw error;
            }
        };

        // Enqueue the task to ensure strict sequential processing
        this._writeQueue = this._writeQueue.then(task).catch(err => {
            console.error('[AuditLogger] CRITICAL ERROR in write queue:', err);
            throw err;
        });

        return this._writeQueue;
    }

    // ========================================================================
    // Convenience Wrappers for Specific Event Types
    // ========================================================================

    /**
     * Logs an authentication or authorization event.
     * 
     * @param {string} action e.g., LOGIN_SUCCESS, TOKEN_ISSUE
     * @param {string} actor User ID or Service Principal
     * @param {string} status SUCCESS, FAILURE, DENIED
     * @param {AuditMetadata} metadata IP, UserAgent, etc.
     * @returns {Promise<AuditLogEntry>}
     */
    logAuthEvent(action, actor, status, metadata = {}) {
        return this.log(
            AUDIT_CATEGORIES.AUTHENTICATION,
            action,
            actor,
            'AuthenticationService',
            status,
            metadata
        );
    }

    /**
     * Logs a control plane or configuration change event.
     * 
     * @param {string} action e.g., CONFIG_UPDATE, PIPELINE_START
     * @param {string} actor User ID or Admin identity
     * @param {string} resource The specific config key, pipeline ID, or system component
     * @param {string} status SUCCESS, FAILURE
     * @param {AuditMetadata} metadata Should ideally include a 'changes' object showing diffs
     * @returns {Promise<AuditLogEntry>}
     */
    logControlPlaneEvent(action, actor, resource, status, metadata = {}) {
        return this.log(
            AUDIT_CATEGORIES.CONTROL_PLANE,
            action,
            actor,
            resource,
            status,
            metadata
        );
    }

    /**
     * Logs a data access event (e.g., reading sensitive repo history).
     * 
     * @param {string} action e.g., REPO_HISTORY_READ
     * @param {string} actor User ID or Service
     * @param {string} resource Repository URI or specific data asset
     * @param {string} status SUCCESS, DENIED
     * @param {AuditMetadata} metadata Query parameters, filters applied
     * @returns {Promise<AuditLogEntry>}
     */
    logDataAccessEvent(action, actor, resource, status, metadata = {}) {
        return this.log(
            AUDIT_CATEGORIES.DATA_ACCESS,
            action,
            actor,
            resource,
            status,
            metadata
        );
    }

    /**
     * Logs internal system events.
     * 
     * @param {string} action e.g., SYSTEM_SHUTDOWN
     * @param {string} actor Usually 'SYSTEM'
     * @param {string} resource Component name
     * @param {string} status SUCCESS, FAILURE, ERROR
     * @param {AuditMetadata} metadata Error stacks, signals, etc.
     * @returns {Promise<AuditLogEntry>}
     */
    logSystemEvent(action, actor, resource, status, metadata = {}) {
        return this.log(
            AUDIT_CATEGORIES.SYSTEM,
            action,
            actor,
            resource,
            status,
            metadata
        );
    }

    // ========================================================================
    // Verification and Integrity
    // ========================================================================

    /**
     * Verifies the cryptographic integrity of the entire audit log file.
     * Reads the file line-by-line, recomputes hashes, and checks the chain.
     * 
     * @returns {Promise<{valid: boolean, entriesChecked: number, error?: string}>}
     */
    verifyLogIntegrity() {
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this.logFilePath)) {
                return resolve({ valid: false, entriesChecked: 0, error: 'Log file does not exist.' });
            }

            let expectedPreviousHash = GENESIS_HASH;
            let entriesChecked = 0;
            let isFirstLine = true;

            const stream = fs.createReadStream(this.logFilePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (!line.trim()) return;

                try {
                    const entry = JSON.parse(line);
                    
                    // 1. Verify Hash Chain Link
                    if (isFirstLine) {
                        if (entry.previousHash !== GENESIS_HASH) {
                            throw new AuditTamperEvidentError('Genesis block previousHash mismatch.', entry.eventId, GENESIS_HASH, entry.previousHash);
                        }
                        isFirstLine = false;
                    } else {
                        if (entry.previousHash !== expectedPreviousHash) {
                            throw new AuditTamperEvidentError('Chain broken! previousHash does not match actual previous hash.', entry.eventId, expectedPreviousHash, entry.previousHash);
                        }
                    }

                    // Extract stored hash and signature
                    const storedHash = entry.hash;
                    const storedSignature = entry.signature;
                    
                    // Remove them for re-computation
                    delete entry.hash;
                    delete entry.signature;

                    // 2. Recompute and Verify Current Hash
                    const { hash: computedHash, signature: computedSignature } = this._computeHashAndSignature(entry);
                    
                    if (computedHash !== storedHash) {
                        throw new AuditTamperEvidentError('Data payload tampering detected! Hash mismatch.', entry.eventId, storedHash, computedHash);
                    }

                    // 3. Verify HMAC Signature (if secret is configured and signature exists)
                    if (this.hmacSecret && storedSignature) {
                        if (computedSignature !== storedSignature) {
                            throw new AuditTamperEvidentError('HMAC Signature verification failed! Key mismatch or tampering.', entry.eventId, storedSignature, computedSignature);
                        }
                    }

                    // Update expected hash for the next iteration
                    expectedPreviousHash = storedHash;
                    entriesChecked++;

                } catch (error) {
                    rl.close();
                    stream.destroy();
                    this.emit('tamper_detected', error);
                    resolve({ valid: false, entriesChecked, error: error.message, details: error });
                }
            });

            rl.on('close', () => {
                // If we reach here without resolving false, the chain is valid.
                this.logSystemEvent(
                    AUDIT_ACTIONS.AUDIT_CHAIN_VERIFY,
                    'SYSTEM',
                    'AuditLog',
                    AUDIT_STATUS.SUCCESS,
                    { entriesChecked, result: 'VALID' }
                ).catch(console.error); // Non-blocking log of the verification

                resolve({ valid: true, entriesChecked });
            });

            rl.on('error', (err) => {
                reject(new AuditError(`Error reading log file during verification: ${err.message}`));
            });
        });
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

// Provide a default singleton instance, but also export the class and constants
// for advanced usage or testing.
const defaultLogger = new TamperEvidentAuditLogger();

module.exports = {
    auditLogger: defaultLogger,
    TamperEvidentAuditLogger,
    AUDIT_CATEGORIES,
    AUDIT_ACTIONS,
    AUDIT_STATUS,
    AuditError,
    AuditTamperEvidentError,
    AuditInitializationError
};