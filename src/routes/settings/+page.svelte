<script lang="ts">
	import { authLabel, type FormResult, type SettingsTab } from './settings-types';
	import type { PageData } from './$types';
	import ActivityPanel from './ActivityPanel.svelte';
	import GeneralSettings from './GeneralSettings.svelte';
	import PermissionGrants from './PermissionGrants.svelte';
	import SettingsTabs from './SettingsTabs.svelte';
	import UpdatePanel from './UpdatePanel.svelte';

	let { data, form }: { data: PageData; form: FormResult | null } = $props();

	const visibleTabs = $derived<SettingsTab[]>(
		data.enableRedeploy
			? ['general', 'permissions', 'activity', 'update']
			: ['general', 'permissions', 'activity']
	);
	let activeTab = $state<SettingsTab>('general');

	function selectTab(tab: SettingsTab) {
		activeTab = tab;
	}

	$effect(() => {
		if (form?.formId === 'save') activeTab = 'general';
		if (
			form?.formId === 'createGrant' ||
			form?.formId === 'updateGrant' ||
			form?.formId === 'revokeGrant' ||
			form?.formId === 'revokeAllGrants' ||
			form?.formId === 'restoreSeedGrants'
		) {
			activeTab = 'permissions';
		}
		if (!visibleTabs.includes(activeTab)) activeTab = 'general';
	});
</script>

<svelte:head><title>Settings — Copilot Portal</title></svelte:head>

<div class="wrap">
	<header class="settings-header">
		<div>
			<p class="eyebrow">Portal preferences</p>
			<h1>Settings</h1>
		</div>
		<span class="auth-pill" class:ok={data.copilot.auth.isAuthenticated}>
			Copilot: {authLabel(data.copilot.auth)}
		</span>
	</header>

	<SettingsTabs
		tabs={visibleTabs}
		{activeTab}
		grantCount={data.grants.length}
		onSelect={selectTab}
	/>

	{#if activeTab === 'general'}
		<GeneralSettings settings={data.settings} copilot={data.copilot} {form} />
	{:else if activeTab === 'permissions'}
		<PermissionGrants grants={data.grants} {form} />
	{:else if activeTab === 'activity'}
		<ActivityPanel decisions={data.recentDecisions} />
	{:else if activeTab === 'update' && data.enableRedeploy}
		<UpdatePanel />
	{/if}
</div>

<style>
	.wrap {
		width: 100%;
		max-width: 960px;
		min-width: 0;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 3rem;
		height: 100%;
		overflow-y: auto;
	}
	.settings-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	h1 {
		margin: 0;
	}
	.eyebrow {
		margin: 0 0 0.25rem;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.auth-pill {
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-muted);
		font-size: 0.85em;
		padding: 0.3rem 0.7rem;
		white-space: nowrap;
	}
	.auth-pill.ok {
		border-color: var(--success);
		color: var(--success);
	}
</style>
