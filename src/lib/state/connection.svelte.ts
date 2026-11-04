// Session-only connection status for the model chip and the Model tab.
// Not persisted: a fresh visit starts 'untested' until a test runs.
export const connection = $state({
	status: 'untested' as 'untested' | 'ok' | 'error',
	models: [] as string[]
});
