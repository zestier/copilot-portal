import { copilotProvider } from './bridge';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

export type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderCapabilities,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

// Provider selection is intentionally centralized here. Copilot stays the
// default while future OpenAI-compatible providers can register behind the same
// pool/turn-runner boundary without changing the PortalEvent stream contract.
export function getDefaultProvider(): ModelBackendProvider {
	return copilotProvider;
}

export async function fetchAuthStatus(
	userId: string,
	authToken?: string
): Promise<ProviderAuthStatus> {
	return getDefaultProvider().fetchAuthStatus(userId, authToken);
}

export async function fetchModels(
	userId: string,
	authToken?: string
): Promise<ProviderModelInfo[]> {
	return getDefaultProvider().listModels(userId, authToken);
}

export async function open(opts: ProviderOpenOptions): Promise<ProviderSession> {
	return getDefaultProvider().openSession(opts);
}

export async function shutdownProviders(): Promise<void> {
	await getDefaultProvider().shutdown?.();
}
