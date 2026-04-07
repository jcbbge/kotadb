/**
 * Authentication context types for KotaDB API authentication.
 *
 * These types define the structure of authenticated user context
 * that flows through the request lifecycle after successful API key validation.
 */

/**
 * User tier levels that determine rate limits and feature access.
 */
export type Tier = "free" | "solo" | "team";

/**
 * Authentication context attached to authenticated requests.
 * Contains user identity and authorization metadata.
 */
export interface AuthContext {
	/** User UUID from the users table */
	userId: string;

	/** User's subscription tier */
	tier: Tier;

	/** API key ID used for this request (for logging and rate limiting) */
	keyId: string;

	/** Rate limit threshold for this key (requests per hour) */
	rateLimitPerHour: number;
}
