/**
 * Rules for naming Hookdeck resources and for judging whether Hookdeck can
 * reach a given n8n instance.
 *
 * Both encode constraints that live outside this codebase — Hookdeck's name
 * pattern, and the fact that deliveries cross the public internet — so they are
 * kept together and covered by their own tests.
 */

/**
 * Hookdeck constrains source, destination and connection names to
 * `^[A-z0-9-_]+$` with a 155 character ceiling. n8n workflow and node IDs can
 * contain characters outside that set, so everything is normalised here.
 */
export function sanitizeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Build the deterministic resource name for a given workflow/node pair.
 *
 * Test and production registrations must never collide: n8n's test webhook URL
 * lives for 120 seconds only, so a connection provisioned against it would
 * silently start failing if it shared a name with the production connection.
 * The `-test` suffix keeps the two independent, and determinism means a
 * re-activation upserts the existing connection instead of creating a duplicate.
 */
export function buildResourceName(
	prefix: string,
	workflowId: string,
	nodeId: string,
	isTest: boolean,
): string {
	const suffix = isTest ? '-test' : '';
	const base = sanitizeName(`${prefix}-${workflowId}-${nodeId}`);
	// Trim the base, not the suffix, so the test/production distinction survives.
	return `${base.slice(0, 155 - suffix.length)}${suffix}`;
}

/**
 * n8n hands back `/webhook-test/...` while the editor is listening for a test
 * event and `/webhook/...` once the workflow is activated. That distinction
 * drives the connection naming above.
 */
export function isTestWebhookUrl(url: string): boolean {
	return url.includes('/webhook-test/');
}

/**
 * Whether a registration belongs to an editor test listen rather than a
 * published workflow.
 *
 * The execution mode is the authoritative signal — n8n reports `manual` only for
 * a test listen — and unlike the URL it is unaffected by an instance renaming
 * its test endpoint via `N8N_ENDPOINT_WEBHOOK_TEST`. The path check is kept as a
 * fallback in case a deployment reports some other mode.
 *
 * Getting this wrong is expensive: a test run filed as production repoints the
 * live connection at a URL that stops answering after 120 seconds.
 */
export function isTestRegistration(executionMode: string, webhookUrl: string): boolean {
	return executionMode === 'manual' || isTestWebhookUrl(webhookUrl);
}

/**
 * Reasons Hookdeck could not deliver to a given n8n URL, or undefined if it can.
 *
 * Hookdeck delivers over the public internet, so it rejects any destination it
 * cannot reach. Catching that here turns an opaque
 * "destination.config.url must be a valid uri" from the API into something the
 * user can act on.
 */
export function describeUnreachableWebhookUrl(webhookUrl: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(webhookUrl);
	} catch {
		return `n8n reported its webhook URL as "${webhookUrl}", which is not a valid URL.`;
	}

	// Node keeps the brackets on IPv6 hostnames ("[fc00::1]"), which would defeat
	// every prefix comparison below.
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

	const isLoopback =
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '::1' ||
		/^127\./.test(host) ||
		// Binding address, not a routable destination.
		host === '0.0.0.0' ||
		host === '::';
	// IPv6 literals only — a hostname is never checked against these, or a real
	// domain like "fc-example.com" would be wrongly rejected.
	const isIpv6 = host.includes(':');
	const isPrivateIpv6 =
		isIpv6 &&
		// Unique-local fc00::/7 and link-local fe80::/10.
		(/^f[cd]/.test(host) || /^fe[89ab]/.test(host));

	// RFC 1918 ranges, IPv4 link-local, and .local names from mDNS.
	const isPrivate =
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host) ||
		// CGNAT 100.64.0.0/10, which is what Tailscale hands out — a common way to
		// reach a self-hosted n8n, and not routable from Hookdeck.
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
		isPrivateIpv6 ||
		host.endsWith('.local');

	if (isLoopback || isPrivate) {
		return `Hookdeck delivers over the public internet and cannot reach "${parsed.host}".`;
	}

	return undefined;
}
