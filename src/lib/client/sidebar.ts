export const SIDEBAR_STORAGE_KEY = 'sidebarOpen';
export const SIDEBAR_DESKTOP_MIN_WIDTH = 769;
export const SIDEBAR_MOBILE_MAX_WIDTH = 768;

export interface SidebarEnv {
	getStored: () => string | null;
	isDesktop: () => boolean;
}

/**
 * Resolve the initial `sidebarOpen` value on page load.
 * Prefers a persisted user choice; otherwise defaults to open on desktop
 * and closed on mobile so the sidebar never overlays content on reload.
 */
export function resolveInitialSidebarOpen(env: SidebarEnv): boolean {
	const stored = env.getStored();
	if (stored === 'true') return true;
	if (stored === 'false') return false;
	return env.isDesktop();
}
