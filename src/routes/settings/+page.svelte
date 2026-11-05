<script lang="ts">
	// /settings used to be a form. Connection settings now live in Studio's Model
	// tab, so this route opens Studio there and goes home.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { openModel, openStudio } from '$lib/state/ui.svelte';

	onMount(() => {
		openModel();
		goto('/', { replaceState: true });
	});
</script>
