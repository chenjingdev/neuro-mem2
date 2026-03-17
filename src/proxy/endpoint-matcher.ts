/**
 * Matches incoming requests against known LLM API endpoints.
 *
 * Supports exact hostname matching and wildcard patterns (e.g., "*.openai.azure.com").
 */

import { BUILTIN_LLM_ENDPOINTS, type LLMEndpoint } from './types.js';

/**
 * Checks if a hostname matches a pattern (supports leading wildcard *.example.com)
 */
export function matchHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

/**
 * Checks if a URL path matches any of the chat completion patterns for an endpoint.
 */
export function matchChatPath(path: string, endpoint: LLMEndpoint): boolean {
  // Strip query string for matching
  const cleanPath = path.split('?')[0];
  return endpoint.chatPaths.some((re) => re.test(cleanPath));
}

export class EndpointMatcher {
  private readonly endpoints: LLMEndpoint[];

  constructor(customEndpoints: LLMEndpoint[] = []) {
    // Custom endpoints take priority (checked first)
    this.endpoints = [...customEndpoints, ...BUILTIN_LLM_ENDPOINTS];
  }

  /**
   * Find the matching LLM endpoint for a given hostname.
   * Returns null if no match.
   */
  matchHost(hostname: string): LLMEndpoint | null {
    for (const ep of this.endpoints) {
      for (const pattern of ep.hostPatterns) {
        if (matchHostPattern(hostname, pattern)) {
          return ep;
        }
      }
    }
    return null;
  }

  /**
   * Check if a request targets a known LLM API chat/completion endpoint.
   * Returns { endpoint, isChatCompletion } or null if not an LLM API.
   */
  match(
    hostname: string,
    path: string,
  ): { endpoint: LLMEndpoint; isChatCompletion: boolean } | null {
    const endpoint = this.matchHost(hostname);
    if (!endpoint) return null;
    const isChatCompletion = matchChatPath(path, endpoint);
    return { endpoint, isChatCompletion };
  }

  /** Get all configured endpoints */
  getEndpoints(): readonly LLMEndpoint[] {
    return this.endpoints;
  }
}
