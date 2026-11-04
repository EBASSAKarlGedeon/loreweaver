// Small pure helpers for the landing page. No DOM, no database.

export function greeting(date = new Date()): string {
	const h = date.getHours();
	if (h < 5) return 'Up late';
	if (h < 12) return 'Good morning';
	if (h < 18) return 'Good afternoon';
	return 'Good evening';
}

export function timeAgo(ts: number, now = Date.now()): string {
	if (!Number.isFinite(ts) || ts <= 0) return '—';
	const mins = Math.floor((now - ts) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
	const years = Math.floor(months / 12);
	return `${years} year${years === 1 ? '' : 's'} ago`;
}

// Plain-text preview of a message: strips markup and formatting characters
export function messageSnippet(text: string | undefined): string {
	const raw = String(text ?? '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[*#`>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!raw) return 'No messages yet.';
	return raw.length > 220 ? raw.slice(0, 220) + '…' : raw;
}

export function descriptionSnippet(text: string | undefined): string {
	const raw = String(text ?? '')
		.replace(/[*#`>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return raw || 'No description available.';
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
	return `${n} ${n === 1 ? word : pluralWord}`;
}
