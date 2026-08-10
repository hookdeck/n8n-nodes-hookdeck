import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HookdeckApi implements ICredentialType {
	name = 'hookdeckApi';

	displayName = 'Hookdeck API';

	documentationUrl = 'https://hookdeck.com/docs/api';

	icon = {
		light: 'file:../nodes/Hookdeck/hookdeck.svg',
		dark: 'file:../nodes/Hookdeck/hookdeck.dark.svg',
	} as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Project API key from Hookdeck. Find it under Project Settings → Secrets in the Hookdeck dashboard.',
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
			baseURL: 'https://api.hookdeck.com/2025-07-01',
			url: '/sources',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}
