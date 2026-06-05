/**
 * Provider Backend abstraction.
 *
 * Decouples the rotation proxy from the OpenAI-specific upstream so that
 * alternative backends (Kimi Code, future providers) can be plugged in
 * without touching the core routing, rate-limit, or account-selection logic.
 *
 * Each backend implements:
 *   - How to construct outbound headers (auth injection)
 *   - The upstream base URL
 *   - How to map the inbound request path to the upstream path
 *   - Optionally, request/response body transforms (protocol translation)
 */

import type { ManagedAccount } from "./accounts.js";
import {
	CODEX_BASE_URL,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
} from "./constants.js";

// ── Interface ─────────────────────────────────────────────────────────────

export interface ProviderBackend {
	/** Human-readable name for logs and status output. */
	readonly name: string;

	/** The upstream base URL to forward requests to. */
	readonly upstreamBaseUrl: string;

	/**
	 * Build outbound headers for the upstream request.
	 * The rotation proxy calls this after selecting an account and refreshing
	 * its access token.  The implementation injects auth and any
	 * provider-specific headers.
	 */
	createOutboundHeaders(
		incoming: Headers,
		account: ManagedAccount,
		accessToken: string,
		accountId: string,
	): Headers;

	/**
	 * Optional: transform the request body before sending upstream.
	 * Return null to send the original body unchanged.
	 * Use this for protocol translation (e.g. Responses API → Messages API).
	 */
	transformRequestBody?(body: Buffer, context: RequestTransformContext): Buffer | null;

	/**
	 * Optional: transform the response body/stream before sending to the client.
	 * Return null to pass the response through unchanged.
	 */
	transformResponseBody?(body: Buffer, context: ResponseTransformContext): Buffer | null;

	/**
	 * Optional: does this backend require OpenAI OAuth tokens?
	 * If false, the proxy can skip token refresh for this backend's accounts.
	 * Default: true (backward compatible with OpenAI).
	 */
	requiresOAuthTokens?: boolean;
}

export interface RequestTransformContext {
	method: string;
	path: string;
	model: string | null;
	stream: boolean;
}

export interface ResponseTransformContext {
	statusCode: number;
	path: string;
	stream: boolean;
}

// ── Built-in: OpenAI (default) ────────────────────────────────────────────

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
]);

export class OpenAIBackend implements ProviderBackend {
	readonly name = "openai";
	readonly upstreamBaseUrl: string;

	constructor(upstreamBaseUrl?: string) {
		this.upstreamBaseUrl = upstreamBaseUrl ?? CODEX_BASE_URL;
	}

	createOutboundHeaders(
		incoming: Headers,
		_account: ManagedAccount,
		accessToken: string,
		accountId: string,
	): Headers {
		const headers = new Headers(incoming);
		for (const name of HOP_BY_HOP_HEADERS) {
			headers.delete(name);
		}
		headers.delete("host");
		headers.delete("x-api-key");
		headers.delete("cookie");
		headers.delete("proxy-authorization");
		headers.set("authorization", `Bearer ${accessToken}`);
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
		headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
		headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		return headers;
	}
}

// ── Built-in: Kimi Code ───────────────────────────────────────────────────

/**
 * Kimi Code backend.
 *
 * Kimi's /coding/ endpoint speaks Anthropic Messages API natively but the
 * rotation proxy speaks Responses API.  The protocol translation is handled
 * by the kimi-codex-bridge (a separate sidecar process).  This backend
 * simply points the proxy at the bridge's localhost URL and injects
 * the bridge's bearer token instead of an OpenAI OAuth token.
 *
 * Architecture:
 *   rotation-proxy → kimi-codex-bridge:8766 → Kimi Code API
 *
 * The bridge handles:
 *   - Responses API → Messages API translation
 *   - apply_patch custom tool conversion
 *   - SSE event format adaptation
 */
export class KimiBackend implements ProviderBackend {
	readonly name = "kimi";
	readonly upstreamBaseUrl: string;
	readonly requiresOAuthTokens = false;
	private readonly bearerToken: string;

	constructor(options?: { bridgeUrl?: string; bearerToken?: string }) {
		this.upstreamBaseUrl = options?.bridgeUrl ?? "http://127.0.0.1:8766";
		this.bearerToken = options?.bearerToken ?? "kimi-bridge-token";
	}

	createOutboundHeaders(
		incoming: Headers,
		_account: ManagedAccount,
		_accessToken: string,
		_accountId: string,
	): Headers {
		const headers = new Headers(incoming);
		for (const name of HOP_BY_HOP_HEADERS) {
			headers.delete(name);
		}
		headers.delete("host");
		headers.delete("x-api-key");
		headers.delete("cookie");
		headers.delete("proxy-authorization");
		// Use the bridge token, not the OpenAI access token
		headers.set("authorization", `Bearer ${this.bearerToken}`);
		return headers;
	}
}

// ── Registry ──────────────────────────────────────────────────────────────

const backendRegistry = new Map<string, () => ProviderBackend>();

/** Register a named backend factory. */
export function registerBackend(name: string, factory: () => ProviderBackend): void {
	backendRegistry.set(name, factory);
}

/** Get a backend by name, falling back to OpenAI. */
export function getBackend(name?: string): ProviderBackend {
	if (!name || name === "openai") {
		return new OpenAIBackend();
	}
	const factory = backendRegistry.get(name);
	if (factory) return factory();

	// Check for Kimi by convention
	if (name === "kimi") {
		return new KimiBackend();
	}

	// Unknown backend — fall back to OpenAI
	return new OpenAIBackend();
}

// Register built-in backends
registerBackend("openai", () => new OpenAIBackend());
registerBackend("kimi", () => new KimiBackend());
