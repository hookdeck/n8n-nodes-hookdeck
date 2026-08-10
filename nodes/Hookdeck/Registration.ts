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

/** Get the registration slot for a mode, migrating any pre-split state into it. */
export function registrationFor(
	staticData: HookdeckStaticData,
	isTest: boolean,
): HookdeckRegistration {
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

	const key = isTest ? 'test' : 'production';
	staticData[key] ??= {};
	return staticData[key] as HookdeckRegistration;
}
