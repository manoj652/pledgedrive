const baseUrl = process.env.PLEDGEDRIVE_BASE_URL || 'http://127.0.0.1:8787';

async function check(path, expectedStatus = 200) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(5000) });
  if (response.status !== expectedStatus) throw new Error(`${path} returned ${response.status}`);
  return response;
}

await check('/health');
await check('/ready');
await check('/metrics');
const dashboard = await (await check('/api/dashboard')).json();
if (!dashboard.quota || !Array.isArray(dashboard.nodes) || !Array.isArray(dashboard.files)) throw new Error('Dashboard response is missing required fields');
const openapi = await (await check('/openapi.json')).json();
if (openapi.openapi !== '3.0.3') throw new Error('OpenAPI document is missing or invalid');
console.log(`PledgeDrive smoke check passed at ${baseUrl}`);
