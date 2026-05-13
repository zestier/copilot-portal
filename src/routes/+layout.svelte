<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import { page } from '$app/stores';

	let { data, children } = $props();

	let sidebarOpen = $state(true);

	const isLoginPage = $derived($page.url.pathname === '/login');
</script>

{#if isLoginPage || !data.user}
	{@render children()}
{:else}
	<div class="layout" class:collapsed={!sidebarOpen}>
		<button
			class="hamburger"
			aria-label="Toggle sidebar"
			onclick={() => (sidebarOpen = !sidebarOpen)}
		>
			☰
		</button>
		<aside class="sidebar" class:open={sidebarOpen}>
			<Sidebar
				conversations={data.conversations}
				user={data.user}
				onnavigate={() => (sidebarOpen = false)}
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
	.hamburger {
		position: fixed;
		top: 0.5rem;
		left: 0.5rem;
		z-index: 20;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.25rem 0.55rem;
		cursor: pointer;
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
	}
</style>
