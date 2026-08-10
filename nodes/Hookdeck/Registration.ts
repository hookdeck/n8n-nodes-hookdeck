import { isTestWebhookUrl } from './Naming';

/** What the trigger remembers about one provisioned Hookdeck connection. */
export interface HookdeckRegistration {
	connectionId?: string;
	sourceId?: string;
	sourceUrl?: string;
	signingSecret?: string;
	destinationUrl?: string;
}

/**
 * Values persisted between activations. Static data is the only place a webhook
 * lifecycle can keep state, and it is what `checkExists` reads to decide whether
 * provisioning is still valid.
 *
 * Test and production must stay in separate slots. n8n registers them as
 * different webhooks against different URLs, so each is backed by its own
 * Hookdeck connection; a shared slot would let one overwrite the other's
 * connection ID and send teardown at the wrong connection.
 *
 * The flat fields are an older layout, migrated on first read.
 */
export interface HookdeckStaticData extends HookdeckRegistration {
	production?: HookdeckRegistration;
	test?: HookdeckRegistration;
}

/**
 * Work out which registration a lifecycle call refers to, and hand back its slot.
 *
 * Three signals, most reliable first:
 *
 * 1. The URL already recorded against a slot. Each registration stores the
 *    destination it was provisioned with, so an exact match names the slot
 *    outright — regardless of how the instance is configured.
 * 2. The execution mode. n8n reports `manual` when it registers a test webhook,
 *    but *not* when it tears one down, so this cannot stand alone.
 * 3. The webhook path, which an instance can rename via
 *    `N8N_ENDPOINT_WEBHOOK_TEST`.
 *
 * Getting this wrong is expensive in both directions: a test run filed as
 * production repoints or pauses the live connection, and a production call filed
 * as test leaves the real connection untouched.
 */
export function registrationFor(
	staticData: HookdeckStaticData,
	webhookUrl: string | undefined,
	executionMode: string,
): { registration: HookdeckRegistration; isTest: boolean } {
	migrateFlatLayout(staticData);

	const isTest = resolveIsTest(staticData, webhookUrl, executionMode);
	const key = isTest ? 'test' : 'production';
	staticData[key] ??= {};

	return { registration: staticData[key] as HookdeckRegistration, isTest };
}

function resolveIsTest(
	staticData: HookdeckStaticData,
	webhookUrl: string | undefined,
	executionMode: string,
): boolean {
	if (webhookUrl) {
		if (staticData.test?.destinationUrl === webhookUrl) return true;
		if (staticData.production?.destinationUrl === webhookUrl) return false;
	}

	if (executionMode === 'manual') return true;

	return webhookUrl ? isTestWebhookUrl(webhookUrl) : false;
}

/** Fold a pre-split flat registration into the production slot. */
function migrateFlatLayout(staticData: HookdeckStaticData): void {
	if (staticData.connectionId) {
		// Older layout: a single flat registration, which was always production.
		staticData.production = {
			connectionId: staticData.connectionId,
			sourceId: staticData.sourceId,
			sourceUrl: staticData.sourceUrl,
			signingSecret: staticData.signingSecret,
			destinationUrl: staticData.destinationUrl,
		};
		delete staticData.connectionId;
		delete staticData.sourceId;
		delete staticData.sourceUrl;
		delete staticData.signingSecret;
		delete staticData.destinationUrl;
	}
}
