/**
 * @file core/versioning.js
 * @description Versioned execution contracts and compatibility enforcement for Git History LLM.
 * This module guarantees that updates to the schema, logic, or pipeline do not silently break
 * existing outputs or stored summaries. It provides version tagging, strict schema validation,
 * semantic versioning compatibility checks, and automated data migration pipelines.
 * 
 * @module core/versioning
 * @requires crypto
 * @requires events
 */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

// ============================================================================
// CUSTOM ERROR DEFINITIONS
// ============================================================================

/**
 * Base error class for versioning-related exceptions.
 * @extends Error
 */
class VersioningError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = this.constructor.name;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Thrown when a stored summary's version is fundamentally incompatible with the current system.
 * @extends VersioningError
 */
class IncompatibleVersionError extends VersioningError {
    constructor(storedVersion, currentVersion, message) {
        super(message || `Version ${storedVersion} is incompatible with current version ${currentVersion}.`, {
            storedVersion,
            currentVersion
        });
    }
}

/**
 * Thrown when a payload fails to meet the structural requirements of its declared execution contract.
 * @extends VersioningError
 */
class SchemaViolationError extends VersioningError {
    constructor(version, violations) {
        super(`Schema validation failed for contract version ${version}.`, {
            version,
            violations
        });
    }
}

/**
 * Thrown when the integrity hash of a stored summary does not match its contents.
 * @extends VersioningError
 */
class IntegrityError extends VersioningError {
    constructor(expectedHash, actualHash) {
        super('Data integrity verification failed. The payload may have been tampered with or silently corrupted.', {
            expectedHash,
            actualHash
        });
    }
}

// ============================================================================
// SEMANTIC VERSIONING UTILITY
// ============================================================================

/**
 * Lightweight Semantic Versioning utility to avoid external dependencies.
 * Handles parsing, comparing, and compatibility checks.
 */
class SemVer {
    /**
     * Parses a semantic version string into its components.
     * @param {string} version - The version string (e.g., '1.2.3-alpha.1').
     * @returns {Object} Parsed version components.
     * @throws {VersioningError} If the version string is invalid.
     */
    static parse(version) {
        if (!version || typeof version !== 'string') {
            throw new VersioningError(`Invalid version format: ${version}`);
        }

        // Strip 'v' prefix if present
        const cleanVersion = version.startsWith('v') ? version.substring(1) : version;
        
        const regex = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;
        const match = cleanVersion.match(regex);

        if (!match) {
            throw new VersioningError(`Version string does not conform to SemVer: ${version}`);
        }

        return {
            raw: cleanVersion,
            major: parseInt(match[1], 10),
            minor: parseInt(match[2], 10),
            patch: parseInt(match[3], 10),
            prerelease: match[4] || null,
            build: match[5] || null
        };
    }

    /**
     * Compares two semantic versions.
     * @param {string} v1 - First version.
     * @param {string} v2 - Second version.
     * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
     */
    static compare(v1, v2) {
        const parsed1 = SemVer.parse(v1);
        const parsed2 = SemVer.parse(v2);

        if (parsed1.major !== parsed2.major) return parsed1.major > parsed2.major ? 1 : -1;
        if (parsed1.minor !== parsed2.minor) return parsed1.minor > parsed2.minor ? 1 : -1;
        if (parsed1.patch !== parsed2.patch) return parsed1.patch > parsed2.patch ? 1 : -1;

        // Simplified prerelease comparison (null prerelease is greater than any prerelease)
        if (!parsed1.prerelease && parsed2.prerelease) return 1;
        if (parsed1.prerelease && !parsed2.prerelease) return -1;
        if (parsed1.prerelease && parsed2.prerelease) {
            return parsed1.prerelease.localeCompare(parsed2.prerelease);
        }

        return 0;
    }

    /**
     * Determines if a stored version is compatible with the current version.
     * Assumes standard SemVer rules: Major version changes break compatibility.
     * @param {string} stored - The version of the stored data.
     * @param {string} current - The current system version.
     * @returns {boolean} True if compatible, false otherwise.
     */
    static isCompatible(stored, current) {
        const pStored = SemVer.parse(stored);
        const pCurrent = SemVer.parse(current);

        // If major versions differ, they are incompatible (unless a migration path exists)
        if (pStored.major !== pCurrent.major) {
            return false;
        }

        // If stored is a newer minor/patch than current, it might use features we don't know about
        if (SemVer.compare(stored, current) > 0) {
            return false;
        }

        return true;
    }
}

// ============================================================================
// SCHEMA VALIDATION ENGINE
// ============================================================================

/**
 * Structural schema validator for enforcing execution contracts.
 */
class SchemaValidator {
    /**
     * Validates a data object against a defined schema.
     * @param {Object} data - The data to validate.
     * @param {Object} schema - The expected schema definition.
     * @param {string} path - Current validation path (used for error reporting).
     * @returns {Array<string>} An array of violation messages. Empty if valid.
     */
    static validate(data, schema, path = 'root') {
        let violations = [];

        if (schema.type === 'object') {
            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                violations.push(`${path}: Expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
                return violations;
            }

            // Check required fields
            if (schema.required && Array.isArray(schema.required)) {
                for (const req of schema.required) {
                    if (!(req in data)) {
                        violations.push(`${path}: Missing required property '${req}'`);
                    }
                }
            }

            // Check property schemas recursively
            if (schema.properties) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    if (key in data) {
                        violations = violations.concat(
                            SchemaValidator.validate(data[key], propSchema, `${path}.${key}`)
                        );
                    }
                }
            }
        } else if (schema.type === 'array') {
            if (!Array.isArray(data)) {
                violations.push(`${path}: Expected array, got ${typeof data}`);
                return violations;
            }
            if (schema.items) {
                data.forEach((item, index) => {
                    violations = violations.concat(
                        SchemaValidator.validate(item, schema.items, `${path}[${index}]`)
                    );
                });
            }
        } else if (schema.type === 'string' || schema.type === 'number' || schema.type === 'boolean') {
            if (typeof data !== schema.type) {
                violations.push(`${path}: Expected ${schema.type}, got ${typeof data}`);
            }
        }

        return violations;
    }
}

// ============================================================================
// EXECUTION CONTRACTS & REGISTRY
// ============================================================================

/**
 * Defines the structural requirements and migration paths for different versions
 * of the Git History LLM output formats.
 */
const CONTRACT_REGISTRY = {
    '1.0.0': {
        description: 'Initial Git History LLM structural output',
        schema: {
            type: 'object',
            required: ['repository', 'analysis_period', 'commits', 'insights'],
            properties: {
                repository: { type: 'string' },
                analysis_period: {
                    type: 'object',
                    required: ['start', 'end'],
                    properties: {
                        start: { type: 'string' },
                        end: { type: 'string' }
                    }
                },
                commits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['hash', 'author', 'message', 'timestamp'],
                        properties: {
                            hash: { type: 'string' },
                            author: { type: 'string' },
                            message: { type: 'string' },
                            timestamp: { type: 'string' }
                        }
                    }
                },
                insights: {
                    type: 'object',
                    required: ['summary', 'work_patterns'],
                    properties: {
                        summary: { type: 'string' },
                        work_patterns: { type: 'array' }
                    }
                }
            }
        },
        // Migration from 1.0.0 to 1.1.0
        up: (data) => {
            const migrated = { ...data };
            // Example migration: 1.1.0 introduces 'change_graphs' which is required.
            if (!migrated.change_graphs) {
                migrated.change_graphs = { nodes: [], edges: [] };
            }
            // 1.1.0 requires categorization in work_patterns
            if (migrated.insights && migrated.insights.work_patterns) {
                migrated.insights.work_patterns = migrated.insights.work_patterns.map(pattern => {
                    return typeof pattern === 'string' 
                        ? { category: 'uncategorized', description: pattern }
                        : pattern;
                });
            }
            return migrated;
        }
    },
    '1.1.0': {
        description: 'Added change graphs and structured work patterns',
        schema: {
            type: 'object',
            required: ['repository', 'analysis_period', 'commits', 'insights', 'change_graphs'],
            properties: {
                repository: { type: 'string' },
                analysis_period: {
                    type: 'object',
                    required: ['start', 'end'],
                    properties: { start: { type: 'string' }, end: { type: 'string' } }
                },
                commits: { type: 'array' }, // Simplified for brevity in registry, but would be deep
                insights: {
                    type: 'object',
                    required: ['summary', 'work_patterns'],
                    properties: {
                        summary: { type: 'string' },
                        work_patterns: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['category', 'description'],
                                properties: {
                                    category: { type: 'string' },
                                    description: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                change_graphs: {
                    type: 'object',
                    required: ['nodes', 'edges'],
                    properties: {
                        nodes: { type: 'array' },
                        edges: { type: 'array' }
                    }
                }
            }
        },
        up: null // Current latest version, no upward migration available
    }
};

// ============================================================================
// CORE VERSIONING ENGINE
// ============================================================================

/**
 * The Antigravity Versioning Engine for Git History LLM.
 * Orchestrates version tagging, compatibility checks, schema enforcement, and migrations.
 * @extends EventEmitter
 */
class VersioningEngine extends EventEmitter {
    /**
     * Initializes the Versioning Engine.
     * @param {Object} options - Configuration options.
     * @param {string} options.systemVersion - The current version of the system/schema (e.g., '1.1.0').
     * @param {string} options.secretKey - Secret key used for HMAC integrity hashing.
     */
    constructor(options = {}) {
        super();
        this.systemVersion = options.systemVersion || '1.1.0';
        this.secretKey = options.secretKey || process.env.GIT_HISTORY_LLM_SECRET || 'antigravity-default-secret-key';
        
        // Ensure the current system version exists in the registry
        if (!CONTRACT_REGISTRY[this.systemVersion]) {
            throw new VersioningError(`System version ${this.systemVersion} is not defined in the Contract Registry.`);
        }

        this.currentContract = CONTRACT_REGISTRY[this.systemVersion];
    }

    /**
     * Generates an HMAC SHA-256 hash of the payload to ensure integrity.
     * @param {Object} payload - The data payload to hash.
     * @returns {string} The hex-encoded hash.
     * @private
     */
    _generateIntegrityHash(payload) {
        const dataString = JSON.stringify(payload, Object.keys(payload).sort());
        return crypto.createHmac('sha256', this.secretKey)
                     .update(dataString)
                     .digest('hex');
    }

    /**
     * Extracts the raw payload by removing versioning metadata.
     * @param {Object} taggedData - Data containing `__contract` metadata.
     * @returns {Object} The raw data payload.
     * @private
     */
    _extractPayload(taggedData) {
        const { __contract, ...payload } = taggedData;
        return payload;
    }

    /**
     * Tags a raw output summary with the current execution contract metadata.
     * This assigns the system version and an integrity hash to the stored summary.
     * 
     * @param {Object} data - The raw Git History LLM output to be stored.
     * @returns {Object} The version-tagged data object.
     * @throws {SchemaViolationError} If the data does not match the current schema.
     */
    tagSummary(data) {
        // 1. Enforce current contract schema before tagging
        const violations = SchemaValidator.validate(data, this.currentContract.schema);
        if (violations.length > 0) {
            this.emit('schema_violation', { version: this.systemVersion, violations });
            throw new SchemaViolationError(this.systemVersion, violations);
        }

        // 2. Generate Integrity Hash
        const integrityHash = this._generateIntegrityHash(data);

        // 3. Construct Contract Metadata
        const contractMetadata = {
            version: this.systemVersion,
            timestamp: new Date().toISOString(),
            integrity: integrityHash,
            engine: 'Antigravity Synthesis Orchestrator v3.0.0-beast'
        };

        // 4. Attach and return
        const taggedData = {
            __contract: contractMetadata,
            ...data
        };

        this.emit('summary_tagged', { version: this.systemVersion, timestamp: contractMetadata.timestamp });
        return taggedData;
    }

    /**
     * Verifies the integrity of a stored summary to prevent silent corruption or tampering.
     * @param {Object} taggedData - The stored summary with `__contract` metadata.
     * @returns {boolean} True if integrity is verified.
     * @throws {IntegrityError} If the hash does not match the payload.
     * @throws {VersioningError} If the data lacks contract metadata.
     */
    verifyIntegrity(taggedData) {
        if (!taggedData || !taggedData.__contract) {
            throw new VersioningError('Cannot verify integrity: Missing __contract metadata.');
        }

        const expectedHash = taggedData.__contract.integrity;
        const payload = this._extractPayload(taggedData);
        const actualHash = this._generateIntegrityHash(payload);

        if (expectedHash !== actualHash) {
            this.emit('integrity_failure', { expectedHash, actualHash });
            throw new IntegrityError(expectedHash, actualHash);
        }

        return true;
    }

    /**
     * Checks compatibility of a stored summary with the current system version.
     * Detects schema or structure changes and determines if migration is required.
     * 
     * @param {Object} taggedData - The stored summary with `__contract` metadata.
     * @returns {Object} Status object: { isCompatible: boolean, requiresMigration: boolean, storedVersion: string }
     */
    checkCompatibility(taggedData) {
        if (!taggedData || !taggedData.__contract) {
            // Unversioned legacy data
            return {
                isCompatible: false,
                requiresMigration: true,
                storedVersion: 'legacy_unversioned'
            };
        }

        const storedVersion = taggedData.__contract.version;
        
        // Exact match
        if (storedVersion === this.systemVersion) {
            return { isCompatible: true, requiresMigration: false, storedVersion };
        }

        // Check SemVer compatibility
        const isCompatible = SemVer.isCompatible(storedVersion, this.systemVersion);
        
        // If it's an older version, it requires migration to match the current execution contract
        const requiresMigration = SemVer.compare(this.systemVersion, storedVersion) > 0;

        return { isCompatible, requiresMigration, storedVersion };
    }

    /**
     * Safely loads, verifies, and (if necessary) migrates a stored summary to the current version.
     * This is the primary entry point for reading historical data back into the pipeline.
     * 
     * @param {Object} taggedData - The stored data retrieved from storage.
     * @returns {Object} The verified, migrated, and fully compatible data payload.
     * @throws {IncompatibleVersionError} If the data cannot be safely migrated.
     * @throws {IntegrityError} If the data has been corrupted.
     * @throws {SchemaViolationError} If the post-migration data fails schema checks.
     */
    loadAndEnforce(taggedData) {
        // 1. Verify Integrity
        this.verifyIntegrity(taggedData);

        // 2. Check Compatibility
        const compatStatus = this.checkCompatibility(taggedData);
        let payload = this._extractPayload(taggedData);

        // 3. Migrate if necessary
        if (compatStatus.requiresMigration) {
            this.emit('migration_started', { from: compatStatus.storedVersion, to: this.systemVersion });
            payload = this.migrateData(payload, compatStatus.storedVersion, this.systemVersion);
            this.emit('migration_completed', { version: this.systemVersion });
        } else if (!compatStatus.isCompatible) {
            // Data is from a newer, incompatible version
            throw new IncompatibleVersionError(
                compatStatus.storedVersion, 
                this.systemVersion, 
                `Cannot load data from future major version ${compatStatus.storedVersion} into system version ${this.systemVersion}.`
            );
        }

        // 4. Final Schema Enforcement against Current Contract
        const violations = SchemaValidator.validate(payload, this.currentContract.schema);
        if (violations.length > 0) {
            throw new SchemaViolationError(this.systemVersion, violations);
        }

        // Return the raw, verified, and upgraded payload ready for pipeline consumption
        return payload;
    }

    /**
     * Executes the sequential migration pipeline to upgrade data from an old version to the current version.
     * @param {Object} payload - The raw data payload to migrate.
     * @param {string} fromVersion - The version the data is currently in.
     * @param {string} toVersion - The target version (usually current system version).
     * @returns {Object} The migrated data payload.
     * @throws {VersioningError} If no migration path exists.
     */
    migrateData(payload, fromVersion, toVersion) {
        if (fromVersion === 'legacy_unversioned') {
            // Assume legacy maps to 1.0.0 as a baseline, or apply specific legacy transformations here
            fromVersion = '1.0.0'; 
        }

        let currentData = { ...payload };
        let currentVer = fromVersion;

        // Ensure both versions exist in registry
        if (!CONTRACT_REGISTRY[fromVersion] && fromVersion !== 'legacy_unversioned') {
            throw new VersioningError(`Unknown source version for migration: ${fromVersion}`);
        }

        // Traverse the upgrade path
        while (SemVer.compare(currentVer, toVersion) < 0) {
            const contract = CONTRACT_REGISTRY[currentVer];
            
            if (!contract || typeof contract.up !== 'function') {
                throw new VersioningError(`Dead end in migration path. No upward migration defined for version ${currentVer}.`);
            }

            try {
                // Execute the migration step
                currentData = contract.up(currentData);
                
                // Find the next version chronologically in the registry
                const sortedVersions = Object.keys(CONTRACT_REGISTRY).sort(SemVer.compare);
                const currentIndex = sortedVersions.indexOf(currentVer);
                currentVer = sortedVersions[currentIndex + 1];

                if (!currentVer) {
                    throw new VersioningError('Reached end of registry before reaching target version.');
                }
            } catch (error) {
                throw new VersioningError(`Migration failed at step ${currentVer}: ${error.message}`);
            }
        }

        return currentData;
    }

    /**
     * Returns the current system version and schema definitions.
     * Useful for API endpoints or debugging.
     * @returns {Object} System version info.
     */
    getSystemInfo() {
        return {
            version: this.systemVersion,
            contractDescription: this.currentContract.description,
            supportedContracts: Object.keys(CONTRACT_REGISTRY)
        };
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    VersioningEngine,
    SemVer,
    SchemaValidator,
    CONTRACT_REGISTRY,
    // Export Errors for external catch blocks
    VersioningError,
    IncompatibleVersionError,
    SchemaViolationError,
    IntegrityError
};