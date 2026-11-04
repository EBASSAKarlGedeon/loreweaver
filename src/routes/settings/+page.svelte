<script lang="ts">
	// /settings used to be a form. Connection settings now live in Studio's Model
	// tab, so this route opens Studio there and goes home.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { openStudio } from '$lib/state/ui.svelte';

	onMount(() => {
		openStudio('model');
		goto('/', { replaceState: true });
	});
</script>
