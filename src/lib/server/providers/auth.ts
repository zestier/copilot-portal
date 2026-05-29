import type { BackendProviderId } from '$lib/types';
import { getProvider } from '.';

export function providerAuthToken(provider: BackendProviderId, userId: string): string | undefined {
	return getProvider(provider).resolveAuthToken?.(userId);
}
