<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		resolveInitialSidebarOpen,
		SIDEBAR_DESKTOP_MIN_WIDTH,
		SIDEBAR_MOBILE_MAX_WIDTH,
		SIDEBAR_STORAGE_KEY
	} from '$lib/client/sidebar';

	let { data, children } = $props();

	// Default to open for SSR; the real value is resolved on mount where
	// localStorage and matchMedia are available.
	let sidebarOpen = $state(true);
	let hydrated = $state(false);

	const isLoginPage = $derived($page.url.pathname === '/login');

	onMount(() => {
		sidebarOpen = resolveInitialSidebarOpen({
			getStored: () => localStorage.getItem(SIDEBAR_STORAGE_KEY),
			isDesktop: () => window.matchMedia(`(min-width: ${SIDEBAR_DESKTOP_MIN_WIDTH}px)`).matches
		});
		hydrated = true;
	});

	$effect(() => {
		if (hydrated) {
			localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
		}
	});
</script>

{#if isLoginPage || !data.user}
	{@render children()}
{:else}
	<div class="layout" class:collapsed={!sidebarOpen} class:preload={!hydrated}>
		<button
			class="btn icon ghost hamburger"
			aria-label="Toggle sidebar"
			onclick={() => (sidebarOpen = !sidebarOpen)}
		>
			☰
		</button>
		<aside class="sidebar" class:open={sidebarOpen}>
			<Sidebar
				conversations={data.conversations}
				user={data.user}
				onnavigate={() => {
					if (window.matchMedia(`(max-width: ${SIDEBAR_MOBILE_MAX_WIDTH}px)`).matches) {
						sidebarOpen = false;
					}
				}}
			/>
		</aside>
		<main class="main">
			{@render children()}
		</main>
	</div>
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: 280px 1fr;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		transition: grid-template-columns 150ms ease-out;
	}
	.layout.collapsed {
		grid-template-columns: 0 1fr;
	}
	.sidebar {
		background: var(--surface);
		border-right: 1px solid var(--border);
		overflow-y: auto;
		overflow-x: hidden;
	}
	.main {
		overflow: hidden;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.layout.preload,
	.layout.preload .sidebar {
		transition: none;
	}
	/* Pre-hydration: force collapsed visuals if the inline script flagged the
	   sidebar as closed, so the SSR markup (which assumes open) doesn't flash. */
	:global(html[data-sidebar='closed']) .layout.preload {
		grid-template-columns: 0 1fr;
	}
	.hamburger {
		position: fixed;
		top: var(--space-2);
		left: var(--space-2);
		z-index: 20;
	}

	@media (max-width: 768px) {
		.layout,
		.layout.collapsed {
			grid-template-columns: 1fr;
		}
		.sidebar {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			width: 80%;
			max-width: 320px;
			transform: translateX(-100%);
			transition: transform 150ms ease-out;
			z-index: 15;
		}
		.sidebar.open {
			transform: translateX(0);
		}
		:global(html[data-sidebar='closed']) .layout.preload .sidebar {
			transform: translateX(-100%);
		}
	}
</style>
