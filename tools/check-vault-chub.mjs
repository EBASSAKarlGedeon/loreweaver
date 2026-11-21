// Weaver's Vault M1: live chub.ai adapter check (plain Node, no server needed).
// Verifies: search params build + normalization, tag index, character detail mapping.
// Usage: node tools/check-vault-chub.mjs
const problems = [];
const ok = (cond, msg) => { if (cond) console.log("  ok:", msg); else { problems.push(msg); console.log("  FAIL:", msg); } };

const { normalizeChubNode, chubCharacterData } = await (async () => {
    // secrets.js reads config.yaml at import time — point it at the repo config first.
    const path = await import("node:path");
    const { setConfigFilePath } = await import("../src/util.js");
    setConfigFilePath(path.default.resolve(import.meta.dirname, "..", "config.yaml"));
    return import("../src/endpoints/weavers-vault.js");
})();

const VAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CHUB_API = "https://api.chub.ai";
const headers = {
    Accept: "application/json",
    "User-Agent": VAULT_UA,
    Origin: "https://chub.ai",
    Referer: "https://chub.ai/",
};

// buildChubSearchQuery isn't exported; exercise it via a shim that stubs user dirs.
// Simpler: re-create the query exactly as the module does for one canonical case and
// assert the module's URL-building rules by importing the router-less helpers indirectly.
// (M2 will cover the route; here we prove the API contract + normalizers.)

console.log("1) live chub search (popular, page 1, anon)");
const qs = "first=24&page=1&sort=download_count&nsfw=false&nsfl=false&include_forks=true&min_tokens=50&venus=false";
const res = await fetch(`${CHUB_API}/search?${qs}`, { headers });
ok(res.ok, `search HTTP ${res.status}`);
const data = await res.json();
const nodes = data?.nodes ?? data?.data?.nodes ?? [];
ok(nodes.length > 0, `search returned ${nodes.length} nodes, total=${data?.data?.count ?? data?.total}`);
const norm = normalizeChubNode(nodes[0]);
ok(norm.id && norm.name && norm.source === "chub" && typeof norm.tokens === "number", `normalized node: ${norm.name} (${norm.id.slice(0, 40)})`);
ok(norm.creator && norm.creator.length > 0, `creator=${norm.creator}`);
ok(norm.avatarUrl && norm.avatarUrl.startsWith("http"), "avatarUrl present");

console.log("2) live chub search with query + filters (mirrors buildChubSearchQuery)");
const qs2 = "first=10&page=1&sort=star_count&nsfw=true&nsfl=false&include_forks=true&min_tokens=50&venus=false&search=elf&max_tokens=50000&topics=Fantasy";
const res2 = await fetch(`${CHUB_API}/search?${qs2}`, { headers });
ok(res2.ok, `filtered search HTTP ${res2.status}`);
const data2 = await res2.json();
const nodes2 = data2?.nodes ?? data2?.data?.nodes ?? [];
ok(Array.isArray(nodes2), `filtered search returned ${nodes2.length}`);

console.log("3) live chub tag index (POST /tags)");
const res3 = await fetch(`${CHUB_API}/tags`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 40, sort: "n_projects", nsfw: true, nsfl: true }),
});
ok(res3.ok, `tags HTTP ${res3.status}`);
const data3 = await res3.json();
const raw3 = Array.isArray(data3) ? data3 : (data3?.tags ?? data3?.data?.tags ?? []);
ok(raw3.length > 0, `tag index returned ${raw3.length} entries; first=${JSON.stringify(raw3[0]).slice(0, 80)}`);

console.log("4) live chub character detail (full=true)");
if (nodes[0]?.fullPath || nodes[0]?.full_path) {
    const fp = nodes[0].fullPath ?? nodes[0].full_path;
    const res4 = await fetch(`${CHUB_API}/api/characters/${encodeURIComponent(fp)}?full=true`, { headers });
    ok(res4.ok, `detail HTTP ${res4.status} for ${fp}`);
    const data4 = await res4.json();
    const node = data4?.node ?? data4;
    const card = chubCharacterData(node);
    ok(card.spec === "chara_card_v2" && card.data.name, `card mapped: ${card.data.name}`);
    ok(typeof card.data.description === "string" && card.data.first_mes !== undefined, "card fields present");
    ok(card.data.extensions?.vault_source === "chub" && card.data.extensions?.vault_full_path === fp, "provenance stamped");
    ok(card.data.creator === String(fp).split("/")[0], `creator=${card.data.creator}`);
    ok(card.data.tags.length > 0, `tags: ${card.data.tags.slice(0, 4).join(", ")}${card.data.tags.length > 4 ? "…" : ""}`);
    console.log(`  (embedded lorebook: ${card.data.character_book ? "yes" : "none"})`);
    console.log(`  (alternates: ${card.data.alternate_greetings.length}, first_mes ${card.data.first_mes.length} chars)`);
} else {
    ok(false, "first node lacks fullPath — cannot test detail");
}

console.log(problems.length ? `\nVAULT CHUB FAILURES: ${problems.length}` : "\nVAULT CHUB OK");
process.exit(problems.length ? 1 : 0);
