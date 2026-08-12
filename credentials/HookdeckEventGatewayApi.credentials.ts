import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HookdeckEventGatewayApi implements ICredentialType {
	name = 'hookdeckEventGatewayApi';

	displayName = 'Hookdeck Event Gateway API';

	documentationUrl = 'https://hookdeck.com/docs/api';

	icon = 'file:../nodes/Hookdeck/hookdeck.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'API key for a Hookdeck Event Gateway project. Find it under Project Settings → Secrets in the Hookdeck dashboard. Keys are scoped to one project, so everything these nodes create or read belongs to it.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// Kept in step with HOOKDECK_BASE_URL in nodes/Hookdeck/GenericFunctions.ts.
			// Credentials are loaded independently of the nodes, so this cannot import
			// it — an API version bump has to change both.
			baseURL: 'https://api.hookdeck.com/2025-07-01',
			url: '/sources',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}
