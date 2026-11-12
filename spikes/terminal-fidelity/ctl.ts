// Tiny client for the spike server's control API: node ctl.ts <method> <path> [json]
const [method = "GET", path = "/api/stats", body] = process.argv.slice(2);
const base = process.env["BZ_SPIKE_URL"] ?? "http://127.0.0.1:7681";
const res = await fetch(base + path, { method, body, headers: body ? { "content-type": "application/json" } : {} });
console.log(JSON.stringify(await res.json(), null, 1));
