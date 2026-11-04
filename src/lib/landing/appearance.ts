// Theme engine: presets, CSS variables and root classes. The layout writes the
// variables on <html>, so every route shares one theme. Everything visual is
// driven by CSS variables and root classes, so a settings change never needs a
// re-render.
import type { Appearance } from '../types';

export const THEMES = [
	{ id: 'obsidian', label: 'Obsidian & Brass', accent: '#c9a45c', accent2: '#8a6a2f', bg: '#0d0c0a' },
	{ id: 'red', label: 'Crimson', accent: '#ff4d5e', accent2: '#d92c42', bg: '#16181d' },
	{ id: 'purple', label: 'Amethyst', accent: '#a78bfa', accent2: '#7c3aed', bg: '#15131d' },
	{ id: 'teal', label: 'Lagoon', accent: '#2dd4bf', accent2: '#0891b2', bg: '#0e1719' },
	{ id: 'orange', label: 'Sunset', accent: '#fb923c', accent2: '#e11d48', bg: '#1a1412' },
	{ id: 'sakura', label: 'Sakura', accent: '#f9a8d4', accent2: '#c084fc', bg: '#1a1419' },
	{ id: 'ocean', label: 'Ocean', accent: '#60a5fa', accent2: '#4f46e5', bg: '#0f1420' },
	{ id: 'emerald', label: 'Emerald', accent: '#34d399', accent2: '#059669', bg: '#0e1712' },
	{ id: 'gold', label: 'Gilded', accent: '#fbbf24', accent2: '#d97706', bg: '#17140e' },
	{ id: 'cyber', label: 'Cyberpunk', accent: '#f472b6', accent2: '#22d3ee', bg: '#0d0b17' },
	{ id: 'mono', label: 'Monochrome', accent: '#e5e7eb', accent2: '#6b7280', bg: '#111111' }
];

export const FONTS: Record<Appearance['font'], string> = {
	system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
	serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
	rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", system-ui, sans-serif',
	mono: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace'
};

const DENSITIES: Record<Appearance['density'], { gap: number; pad: number }> = {
	compact: { gap: 10, pad: 10 },
	comfortable: { gap: 16, pad: 14 },
	spacious: { gap: 24, pad: 18 }
};

export function getTheme(id: string) {
	return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// The colors actually in effect: the preset, overridden by custom picks
export function effectiveColors(a: Appearance) {
	const t = getTheme(a.theme);
	return {
		accent: a.accentColor || t.accent,
		accent2: a.accent2Color || t.accent2,
		bg: a.bgColor || t.bg
	};
}

function clamp(n: number, min: number, max: number, fallback: number): number {
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// WCAG relative luminance of a #rrggbb color (0 = black, 1 = white)
function luminance(hex: string): number {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return 0.3;
	const n = parseInt(m[1], 16);
	const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Dark text on light accents (Sakura, Gilded, Monochrome...), white otherwise
function onAccentColor(a: string, b: string): string {
	return (luminance(a) + luminance(b)) / 2 > 0.4 ? '#111318' : '#ffffff';
}

// CSS custom properties for the whole app. The layout writes these on <html>.
// Derived surfaces are color-mix() expressions over the live --lw-bg and
// --lw-text, so they follow any preset or custom palette, light or dark.
export function themeVars(a: Appearance): Record<string, string> {
	const { accent, accent2, bg } = effectiveColors(a);
	const density = DENSITIES[a.density] ?? DENSITIES.comfortable;
	const lightBg = luminance(bg) > 0.4;
	return {
		'--lw-accent': accent,
		'--lw-accent2': accent2,
		'--lw-bg': bg,
		'--lw-on-accent': onAccentColor(accent, accent2),
		'--lw-text': lightBg ? '#111318' : '#ece6d8',
		'--lw-text-dim': 'color-mix(in oklab, var(--lw-text) 62%, var(--lw-bg))',
		'--lw-surface': 'color-mix(in oklab, var(--lw-bg) 94%, var(--lw-text))',
		'--lw-surface-2': 'color-mix(in oklab, var(--lw-bg) 88%, var(--lw-text))',
		'--lw-border': 'color-mix(in oklab, var(--lw-text) 14%, transparent)',
		'--lw-hairline': 'color-mix(in oklab, var(--lw-text) 8%, transparent)',
		'--lw-danger': lightBg ? '#b42318' : '#e06c6c',
		'--lw-ok': lightBg ? '#067647' : '#6ccf8e',
		'--lw-overlay': String(clamp(a.overlayOpacity, 0, 100, 85) / 100),
		'--lw-blur': `${clamp(a.blur, 0, 40, 12)}px`,
		'--lw-radius': `${clamp(a.radius, 0, 32, 14)}px`,
		'--lw-card-art-height': `${clamp(a.cardHeight, 140, 520, 260)}px`,
		'--lw-card-min': `${clamp(a.cardMinWidth, 150, 400, 230)}px`,
		'--lw-chat-card-w': `${clamp(a.chatCardWidth, 240, 520, 340)}px`,
		'--lw-font': FONTS[a.font] ?? FONTS.system,
		'--lw-font-scale': String(clamp(a.fontScale, 75, 140, 100) / 100),
		'--lw-gap': `${density.gap}px`,
		'--lw-pad': `${density.pad}px`
	};
}

// Landing-only background image, applied as an inline style on .landing
export function backgroundStyle(a: Appearance): string {
	if (a.bgMode !== 'image' || !a.bgImageUrl) return '';
	const safe = a.bgImageUrl.replace(/["\\\n\r]/g, '');
	return `background-image: url("${safe}")`;
}

// Classes that switch whole families of styles on the root
export function rootClasses(a: Appearance): string {
	const classes = [`stlp-style-${a.cardStyle}`, `stlp-bgmode-${a.bgMode}`];
	if (a.sectionOrder === 'characters-first') classes.push('stlp-chars-first');
	if (!a.showHero) classes.push('stlp-hide-hero');
	if (!a.showStats) classes.push('stlp-hide-stats');
	if (!a.showDescription) classes.push('stlp-hide-desc');
	if (!a.showChatCount) classes.push('stlp-hide-chatcount');
	if (!a.ambient) classes.push('stlp-no-ambient');
	if (!a.glow) classes.push('stlp-no-glow');
	if (!a.animations) classes.push('stlp-no-anim');
	return classes.join(' ');
}

// ---------- color helpers (for the Randomize button) ----------

export function hslToHex(h: number, sat: number, light: number): string {
	const s = sat / 100;
	const l = light / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
	return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

export function randomPalette(): { accent: string; accent2: string; bg: string } {
	const h = Math.floor(Math.random() * 360);
	const shift = [30, 45, 60, 150, 180][Math.floor(Math.random() * 5)];
	return {
		accent: hslToHex(h, 85, 65),
		accent2: hslToHex((h + shift) % 360, 80, 52),
		bg: hslToHex(h, 25, 8)
	};
}
