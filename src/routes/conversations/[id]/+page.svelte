<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.conversation.title} — Copilot Portal</title>
</svelte:head>

<Chat
	conversation={data.conversation}
	initialMessages={data.messages}
	initialUsage={data.contextUsage}
/>
