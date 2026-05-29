<script lang="ts">
	import type { InteractiveExitPlanModeView, InteractiveResponse } from '$lib/types';

	let {
		request,
		busy,
		onRespond
	}: {
		request: InteractiveExitPlanModeView & { requestId: string };
		busy: boolean;
		onRespond: (r: InteractiveResponse) => void;
	} = $props();
</script>

<div class="head">Ready to exit plan mode?</div>
<div class="body">
	<p>{request.summary}</p>
	{#if request.planContent}<pre>{request.planContent}</pre>{/if}
</div>
<div class="actions">
	<button
		class="btn"
		disabled={busy}
		onclick={() => onRespond({ kind: 'exit_plan_mode', approved: false })}>Stay in plan mode</button
	>
	{#each request.actions as action}
		<button
			class="btn"
			class:primary={action === request.recommendedAction}
			disabled={busy}
			onclick={() => onRespond({ kind: 'exit_plan_mode', approved: true, selectedAction: action })}
			>{action}</button
		>
	{/each}
</div>
