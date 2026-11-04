import type { PageLoad } from './$types';

// The chat is loaded from IndexedDB in the page itself; the route only passes the id.
export const load: PageLoad = ({ params }) => ({ chatId: Number(params.id) });
