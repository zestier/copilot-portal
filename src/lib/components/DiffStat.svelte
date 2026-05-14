<script lang="ts">
	let {
		added,
		removed,
		compact = false
	}: { added: number | null; removed: number | null; compact?: boolean } = $props();
</script>

{#if added != null && removed != null && (added > 0 || removed > 0)}
	<span class="diffstat" class:compact title={`+${added} added, −${removed} removed`}>
		{#if added > 0}<span class="added">+{added}</span>{/if}
		{#if removed > 0}<span class="removed">−{removed}</span>{/if}
	</span>
{:else if added == null && removed == null}
	<!-- no stats available -->
{/if}

<style>
	.diffstat {
		display: inline-flex;
		gap: 0.25rem;
		font-family: var(--mono);
		font-size: 0.85em;
		font-variant-numeric: tabular-nums;
	}
	.diffstat.compact {
		font-size: 0.78em;
	}
	.added {
		color: var(--success);
	}
	.removed {
		color: var(--danger);
	}
</style>
