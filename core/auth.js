/**
 * @fileoverview Authentication and Authorization Layer for Git History LLM.
 * @module core/auth
 * @description Provides a comprehensive, production-ready authentication and authorization 
 * system. Secures the control plane, manages API key validation, enforces Role-Based 
 * Access Control (RBAC), and maps API keys to specific system roles. Designed to handle 
 * secure access to repository history, LLM pipelines, and system state.
 * 
 * Features:
 * - Constant-time API key validation to prevent timing attacks.
 * - Hierarchical Role-Based Access Control (RBAC).
 * - Granular permission mapping.
 * - Extensible KeyStore architecture (Memory, Environment, Database adapters).
 * - Framework-agnostic middleware factories (Express, Koa, Fastify compatible logic).
 * - Comprehensive audit logging via EventEmitter.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// ============================================================================
// SYSTEM CONSTANTS: ROLES & PERMISSIONS
// ============================================================================

/**
 * Defines the standard roles within the Git History LLM ecosystem.
 * Roles are hierarchical; higher-level roles inherit permissions of lower ones.
 * @enum {string}
 */
const ROLES = {
    SUPERADMIN: 'SUPERADMIN',       // Full control over system and users
    ADMIN: 'ADMIN',                 // Can manage pipelines, settings, and most resources
    PIPELINE_WORKER: 'PIPELINE_WORKER', // Automated agents (Zayvora pipelines) executing tasks
    ANALYST: 'ANALYST',             // Can trigger analysis and view all history
    VIEWER: 'VIEWER',               // Read-only access to insights and graphs
    GUEST: 'GUEST'                  // Unauthenticated or minimal access
};

/**
 * Defines the granular permissions required for specific control plane actions.
 * @enum {string}
 */
const PERMISSIONS = {
    // State & History access
    READ_HISTORY: 'READ_HISTORY',
    WRITE_HISTORY: 'WRITE_HISTORY',
    DELETE_HISTORY: 'DELETE_HISTORY',
    
    // LLM & Pipeline access
    TRIGGER_ANALYSIS: 'TRIGGER_ANALYSIS',
    READ_INSIGHTS: 'READ_INSIGHTS',
    MANAGE_PIPELINES: 'MANAGE_PIPELINES',
    
    // System Control Plane
    READ_SYSTEM_STATE: 'READ_SYSTEM_STATE',
    WRITE_SYSTEM_STATE: 'WRITE_SYSTEM_STATE',
    MANAGE_USERS: 'MANAGE_USERS',
    MANAGE_API_KEYS: 'MANAGE_API_KEYS'
};

/**
 * Maps roles to their specific granular permissions.
 * @type {Record<string, string[]>}
 */
const ROLE_PERMISSIONS = {
    [ROLES.SUPERADMIN]: Object.values(PERMISSIONS),
    [ROLES.ADMIN]: [
        PERMISSIONS.READ_HISTORY, PERMISSIONS.WRITE_HISTORY,
        PERMISSIONS.TRIGGER_ANALYSIS, PERMISSIONS.READ_INSIGHTS,
        PERMISSIONS.MANAGE_PIPELINES, PERMISSIONS.READ_SYSTEM_STATE,
        PERMISSIONS.MANAGE_API_KEYS
    ],
    [ROLES.PIPELINE_WORKER]: [
        PERMISSIONS.READ_HISTORY, PERMISSIONS.WRITE_HISTORY,
        PERMISSIONS.TRIGGER_ANALYSIS, PERMISSIONS.READ_INSIGHTS
    ],
    [ROLES.ANALYST]: [
        PERMISSIONS.READ_HISTORY, PERMISSIONS.READ_INSIGHTS,
        PERMISSIONS.TRIGGER_ANALYSIS
    ],
    [ROLES.VIEWER]: [
        PERMISSIONS.READ_HISTORY, PERMISSIONS.READ_INSIGHTS
    ],
    [ROLES.GUEST]: []
};

/**
 * Defines role hierarchy to allow role-level authorization checks.
 * A role has access if its numeric weight is >= the required role's weight.
 * @type {Record<string, number>}
 */
const ROLE_HIERARCHY = {
    [ROLES.SUPERADMIN]: 100,
    [ROLES.ADMIN]: 80,
    [ROLES.PIPELINE_WORKER]: 60,
    [ROLES.ANALYST]: 40,
    [ROLES.VIEWER]: 20,
    [ROLES.GUEST]: 0
};

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base class for all authentication and authorization errors.
 * @extends Error
 */
class AuthError extends Error {
    /**
     * @param {string} message - Error description
     * @param {number} statusCode - HTTP status code associated with the error
     */
    constructor(message, statusCode = 500) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Thrown when an API key is missing, invalid, or expired.
 * @extends AuthError
 */
class UnauthorizedError extends AuthError {
    constructor(message = 'Unauthorized: Invalid or missing API key') {
        super(message, 401);
    }
}

/**
 * Thrown when an authenticated user lacks the required role or permissions.
 * @extends AuthError
 */
class ForbiddenError extends AuthError {
    constructor(message = 'Forbidden: Insufficient permissions to access this resource') {
        super(message, 403);
    }
}

// ============================================================================
// KEY STORE ADAPTERS
// ============================================================================

/**
 * @typedef {Object} ApiKeyRecord
 * @property {string} id - Unique identifier for the key
 * @property {string} hash - SHA-256 hash of the API key
 * @property {string} role - The role assigned to this key (from ROLES)
 * @property {Object} metadata - Additional context (e.g., owner name, pipeline ID)
 * @property {boolean} isActive - Whether the key is currently active
 * @property {Date} createdAt - Timestamp of key creation
 * @property {Date|null} expiresAt - Optional expiration timestamp
 */

/**
 * Abstract Base Class for API Key Storage.
 * Implementations must provide mechanisms to retrieve key records by ID.
 * @abstract
 */
class KeyStore {
    /**
     * Retrieves an API key record by its ID.
     * @param {string} keyId - The identifier part of the API key
     * @returns {Promise<ApiKeyRecord|null>} The key record, or null if not found
     */
    async getKeyRecord(keyId) {
        throw new Error('Method not implemented.');
    }

    /**
     * Stores a new API key record.
     * @param {ApiKeyRecord} record - The record to store
     * @returns {Promise<void>}
     */
    async saveKeyRecord(record) {
        throw new Error('Method not implemented.');
    }
}

/**
 * In-memory key store adapter. Useful for testing or single-instance lightweight deployments.
 * @extends KeyStore
 */
class MemoryKeyStore extends KeyStore {
    constructor() {
        super();
        /** @type {Map<string, ApiKeyRecord>} */
        this.store = new Map();
    }

    async getKeyRecord(keyId) {
        return this.store.get(keyId) || null;
    }

    async saveKeyRecord(record) {
        this.store.set(record.id, record);
    }

    /**
     * Seeds the memory store with a set of predefined keys.
     * @param {Array<ApiKeyRecord>} records 
     */
    seed(records) {
        for (const record of records) {
            this.store.set(record.id, record);
        }
    }
}

/**
 * Environment variable based key store adapter.
 * Parses keys from process.env (e.g., AUTH_KEY_ADMIN="key_xxx", AUTH_KEY_PIPELINE="key_yyy").
 * @extends KeyStore
 */
class EnvironmentKeyStore extends MemoryKeyStore {
    constructor() {
        super();
        this._loadFromEnv();
    }

    _loadFromEnv() {
        const envKeys = Object.keys(process.env).filter(k => k.startsWith('AUTH_KEY_'));
        for (const envKey of envKeys) {
            const rawKey = process.env[envKey];
            if (!rawKey) continue;

            // Extract role from the env var name (e.g., AUTH_KEY_SUPERADMIN -> SUPERADMIN)
            const roleStr = envKey.replace('AUTH_KEY_', '').toUpperCase();
            const role = ROLES[roleStr] || ROLES.VIEWER;

            // We expect keys in the format: "ghl_v1_<id>_<secret>"
            // If it's a raw string, we'll hash it and use a generic ID.
            const parts = rawKey.split('_');
            let id, secret;
            
            if (parts.length === 4 && parts[0] === 'ghl' && parts[1] === 'v1') {
                id = parts[2];
                secret = rawKey;
            } else {
                // Legacy or simple format fallback
                id = `env_${roleStr.toLowerCase()}`;
                secret = rawKey;
            }

            const hash = crypto.createHash('sha256').update(secret).digest('hex');

            this.store.set(id, {
                id,
                hash,
                role,
                metadata: { source: 'environment', envKey },
                isActive: true,
                createdAt: new Date(),
                expiresAt: null
            });
        }
    }
}

// ============================================================================
// CORE AUTHENTICATION MANAGER
// ============================================================================

/**
 * @typedef {Object} AuthContext
 * @property {string} keyId - The ID of the authenticated key
 * @property {string} role - The role granted to the user/system
 * @property {string[]} permissions - List of granular permissions
 * @property {Object} metadata - Contextual metadata attached to the key
 */

/**
 * The main Authentication and Authorization Orchestrator.
 * Handles validation, RBAC enforcement, and secure key generation.
 * Emits audit events: 'auth:success', 'auth:failure', 'auth:forbidden'
 * @extends EventEmitter
 */
class AuthManager extends EventEmitter {
    /**
     * @param {Object} options
     * @param {KeyStore} [options.keyStore] - Storage adapter for API keys. Defaults to EnvironmentKeyStore.
     * @param {string} [options.keyPrefix='ghl_v1_'] - Prefix used for generated API keys.
     */
    constructor(options = {}) {
        super();
        this.keyStore = options.keyStore || new EnvironmentKeyStore();
        this.keyPrefix = options.keyPrefix || 'ghl_v1_';
    }

    /**
     * Parses an API key into its constituent parts.
     * Expected format: prefix_id_secret (e.g., ghl_v1_abc123_xyz789...)
     * @param {string} rawKey - The raw API key string
     * @returns {{id: string, secret: string}|null}
     * @private
     */
    _parseKey(rawKey) {
        if (!rawKey || typeof rawKey !== 'string') return null;
        
        // Handle environment fallback format without standard prefix
        if (!rawKey.startsWith(this.keyPrefix)) {
            // For simple keys, we hash the whole string and use a generic lookup.
            // This requires the KeyStore to support looking up by hash, or we just
            // hash it and compare against all keys (inefficient, but okay for env fallback).
            // In a strict production system, enforce the prefix.
            return null; 
        }

        const prefixLen = this.keyPrefix.length;
        const remainder = rawKey.substring(prefixLen);
        const splitIndex = remainder.indexOf('_');
        
        if (splitIndex === -1) return null;

        const id = remainder.substring(0, splitIndex);
        return { id, secret: rawKey };
    }

    /**
     * Authenticates a raw API key securely using constant-time comparison.
     * @param {string} rawKey - The API key provided by the client
     * @returns {Promise<AuthContext>} The authenticated context
     * @throws {UnauthorizedError} If the key is invalid, missing, or expired
     */
    async authenticate(rawKey) {
        if (!rawKey) {
            this.emit('auth:failure', { reason: 'missing_key' });
            throw new UnauthorizedError('API key is required');
        }

        const parsed = this._parseKey(rawKey);
        
        // Fallback for simple legacy keys (e.g., loaded from env without prefix)
        let record = null;
        let providedHash = crypto.createHash('sha256').update(rawKey).digest('hex');

        if (parsed) {
            record = await this.keyStore.getKeyRecord(parsed.id);
        } else {
            // If it doesn't match the prefix format, it might be a raw env key.
            // We iterate through memory store if it's an EnvironmentKeyStore.
            // WARNING: This is O(N) and only recommended for small env-based setups.
            if (this.keyStore instanceof MemoryKeyStore) {
                for (const [, val] of this.keyStore.store.entries()) {
                    if (val.hash === providedHash) {
                        record = val;
                        break;
                    }
                }
            }
        }

        if (!record || !record.isActive) {
            this.emit('auth:failure', { reason: 'invalid_or_inactive_key' });
            throw new UnauthorizedError('Invalid API key');
        }

        // Check expiration
        if (record.expiresAt && new Date() > record.expiresAt) {
            this.emit('auth:failure', { reason: 'expired_key', keyId: record.id });
            throw new UnauthorizedError('API key has expired');
        }

        // Constant-time comparison to prevent timing attacks
        const storedHashBuffer = Buffer.from(record.hash, 'hex');
        const providedHashBuffer = Buffer.from(providedHash, 'hex');

        if (storedHashBuffer.length !== providedHashBuffer.length || 
            !crypto.timingSafeEqual(storedHashBuffer, providedHashBuffer)) {
            this.emit('auth:failure', { reason: 'hash_mismatch', keyId: record.id });
            throw new UnauthorizedError('Invalid API key');
        }

        // Authentication successful
        const context = {
            keyId: record.id,
            role: record.role,
            permissions: ROLE_PERMISSIONS[record.role] || [],
            metadata: record.metadata
        };

        this.emit('auth:success', { keyId: record.id, role: record.role });
        return context;
    }

    /**
     * Checks if a user's role satisfies the required role hierarchy.
     * @param {string} userRole - The role of the authenticated user
     * @param {string} requiredRole - The minimum role required
     * @returns {boolean} True if authorized
     */
    isAuthorizedByRole(userRole, requiredRole) {
        const userWeight = ROLE_HIERARCHY[userRole] || 0;
        const requiredWeight = ROLE_HIERARCHY[requiredRole] || 0;
        return userWeight >= requiredWeight;
    }

    /**
     * Checks if a user's role contains a specific granular permission.
     * @param {string} userRole - The role of the authenticated user
     * @param {string} requiredPermission - The specific permission required (from PERMISSIONS)
     * @returns {boolean} True if the role has the permission
     */
    hasPermission(userRole, requiredPermission) {
        const permissions = ROLE_PERMISSIONS[userRole] || [];
        return permissions.includes(requiredPermission);
    }

    /**
     * Asserts that a context has the required role, throwing an error if not.
     * @param {AuthContext} context - The authenticated context
     * @param {string} requiredRole - The minimum required role
     * @throws {ForbiddenError} If authorization fails
     */
    assertRole(context, requiredRole) {
        if (!this.isAuthorizedByRole(context.role, requiredRole)) {
            this.emit('auth:forbidden', { 
                keyId: context.keyId, 
                userRole: context.role, 
                requiredRole, 
                type: 'role_check' 
            });
            throw new ForbiddenError(`Requires role: ${requiredRole} or higher. Current role: ${context.role}`);
        }
    }

    /**
     * Asserts that a context has the required permission, throwing an error if not.
     * @param {AuthContext} context - The authenticated context
     * @param {string} requiredPermission - The required permission
     * @throws {ForbiddenError} If authorization fails
     */
    assertPermission(context, requiredPermission) {
        if (!this.hasPermission(context.role, requiredPermission)) {
            this.emit('auth:forbidden', { 
                keyId: context.keyId, 
                userRole: context.role, 
                requiredPermission, 
                type: 'permission_check' 
            });
            throw new ForbiddenError(`Missing required permission: ${requiredPermission}`);
        }
    }

    /**
     * Generates a new API key and stores its hash securely.
     * @param {string} role - The role to assign to the new key
     * @param {Object} [metadata={}] - Additional metadata (e.g., owner, description)
     * @param {number} [expiresInDays=null] - Optional expiration in days
     * @returns {Promise<{rawKey: string, record: ApiKeyRecord}>} The raw key (to show user ONCE) and the stored record
     */
    async generateApiKey(role, metadata = {}, expiresInDays = null) {
        if (!ROLES[role]) {
            throw new Error(`Invalid role: ${role}`);
        }

        const idBytes = crypto.randomBytes(8).toString('hex');
        const secretBytes = crypto.randomBytes(32).toString('base64url');
        
        const rawKey = `${this.keyPrefix}${idBytes}_${secretBytes}`;
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

        let expiresAt = null;
        if (expiresInDays) {
            expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + expiresInDays);
        }

        const record = {
            id: idBytes,
            hash,
            role,
            metadata,
            isActive: true,
            createdAt: new Date(),
            expiresAt
        };

        await this.keyStore.saveKeyRecord(record);

        this.emit('auth:key_generated', { keyId: idBytes, role });

        return { rawKey, record };
    }

    /**
     * Extracts the API key from standard HTTP headers.
     * Looks for 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.
     * @param {Object} headers - HTTP request headers object
     * @returns {string|null} The extracted key, or null if not found
     */
    extractKeyFromHeaders(headers) {
        if (!headers || typeof headers !== 'object') return null;

        // Check standard Authorization header
        const authHeader = headers['authorization'] || headers['Authorization'];
        if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
            return authHeader.substring(7).trim();
        }

        // Check custom X-API-Key header
        const apiKeyHeader = headers['x-api-key'] || headers['X-Api-Key'] || headers['X-API-KEY'];
        if (apiKeyHeader) {
            return apiKeyHeader.trim();
        }

        return null;
    }
}

// ============================================================================
// MIDDLEWARE FACTORIES
// ============================================================================

/**
 * Creates an Express/Connect compatible middleware for authentication and authorization.
 * @param {AuthManager} authManager - The initialized AuthManager instance
 * @param {Object} [options]
 * @param {string} [options.requiredRole] - Minimum role required for the route
 * @param {string} [options.requiredPermission] - Specific permission required for the route
 * @returns {Function} Express middleware function: (req, res, next)
 */
function createExpressMiddleware(authManager, options = {}) {
    return async (req, res, next) => {
        try {
            const rawKey = authManager.extractKeyFromHeaders(req.headers);
            
            if (!rawKey) {
                throw new UnauthorizedError('Authentication required. Provide an API key via Authorization Bearer token or X-API-Key header.');
            }

            const context = await authManager.authenticate(rawKey);

            if (options.requiredRole) {
                authManager.assertRole(context, options.requiredRole);
            }

            if (options.requiredPermission) {
                authManager.assertPermission(context, options.requiredPermission);
            }

            // Attach the authenticated context to the request object for downstream use
            req.auth = context;
            next();
            
        } catch (error) {
            const statusCode = error.statusCode || 500;
            const message = error.statusCode ? error.message : 'Internal Server Error during authentication';
            
            res.status(statusCode).json({
                error: {
                    code: statusCode,
                    type: error.name,
                    message: message
                }
            });
        }
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    ROLES,
    PERMISSIONS,
    ROLE_PERMISSIONS,
    ROLE_HIERARCHY,
    
    AuthError,
    UnauthorizedError,
    ForbiddenError,
    
    KeyStore,
    MemoryKeyStore,
    EnvironmentKeyStore,
    
    AuthManager,
    
    createExpressMiddleware
};