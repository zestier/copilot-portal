// Compatibility facade for older imports. Copilot-specific SDK code lives in
// copilot-provider.ts behind the provider interface.

import type { ProviderOpenOptions, ProviderSession } from './provider';
import {
	copilotProvider,
	fetchAuthStatus,
	fetchModels,
	open,
	shutdownClient
} from './copilot-provider';

export type BridgeOpenOptions = ProviderOpenOptions;
export type ConversationSession = ProviderSession &
	Required<Pick<ProviderSession, 'setMode' | 'setApproveAll' | 'resetSessionApprovals'>>;

export { copilotProvider, fetchAuthStatus, fetchModels, open, shutdownClient };
