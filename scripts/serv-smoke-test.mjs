import { existsSync } from 'node:fs';
import { resolveAiConfig } from '../build/server/extraction/openai-compatible-provider.js';
import { buildExtractionPrompt } from '../build/server/extraction/extraction-prompt.js';
import { parseAiExtractionResponse } from '../build/server/extraction/extraction-schema.js';
import { validateQuotation } from '../build/server/extraction/quotation-validator.js';
import { analyzeDateText, dateTextSupportedByQuotation } from '../build/server/extraction/date-normalizer.js';
import { validateClaimSemantics } from '../build/server/extraction/claim-guards.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const resolution = resolveAiConfig(process.env);

if (!resolution.configured) {
  console.log('=======================================================');
  console.log('[SERV SMOKE TEST UNVERIFIED]');
  console.log('Reason:', resolution.reason);
  console.log('No OpenServ SERV API key is available in the local environment.');
  console.log('Automated tests with mocked responses pass, but live provider smoke test remains unverified.');
  console.log('To verify live SERV integration, set SERV_API_KEY in .env and rerun this command.');
  console.log('=======================================================');
  process.exit(0);
}

const config = resolution.config;
const endpoint = config.baseUrl.endsWith('/chat/completions')
  ? config.baseUrl
  : `${config.baseUrl}/chat/completions`;

console.log('=======================================================');
console.log('OpenServ SERV Reasoning — Live Integration Smoke Test');
console.log('Endpoint:', endpoint);
console.log('Model:', config.model);
console.log('Authentication: Bearer [REDACTED]');
console.log('Sending controlled manufacturer support sample...');
console.log('=======================================================');

const sampleSource = {
  url: 'https://support.northline.example/security/halo-s1',
  title: 'Northline Audio Security Commitment',
  relationshipType: 'support_page',
  manufacturerName: 'Northline Audio',
  productName: 'Halo S1',
  modelIdentifier: 'NL-S1',
  marketRegion: 'Global',
};

const sampleContent = `
Northline Audio Security Policy
Model: Halo S1 Home Speaker (NL-S1)

Security Lifecycle Commitment:
Security updates for the Halo S1 will be provided until 31 December 2030.
Vulnerability disclosures are patched within 30 days of discovery.
`;

const prompt = buildExtractionPrompt(sampleSource, sampleContent, 8_000);

const startTime = Date.now();
let response;
try {
  response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: prompt.systemPrompt },
        { role: 'user', content: prompt.userPrompt },
      ],
      temperature: 0.1,
      max_completion_tokens: 1_500,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
} catch (error) {
  console.error('[SERV SMOKE TEST FAILED] Network error or timeout contacting SERV:', error.message);
  process.exit(1);
}

const durationMs = Date.now() - startTime;

if (!response.ok) {
  const text = await response.text().catch(() => '');
  console.error(`[SERV SMOKE TEST FAILED] SERV API returned HTTP ${response.status}:`, text.slice(0, 300));
  process.exit(1);
}

let body;
try {
  body = await response.json();
} catch (error) {
  console.error('[SERV SMOKE TEST FAILED] SERV returned non-JSON response:', error.message);
  process.exit(1);
}

const rawText = body.choices?.[0]?.message?.content;
if (!rawText) {
  console.error('[SERV SMOKE TEST FAILED] SERV returned empty choice content');
  process.exit(1);
}

let parsed;
try {
  parsed = parseAiExtractionResponse(rawText, { sourceContent: sampleContent });
} catch (error) {
  console.error('Raw response from SERV was:', rawText);
  console.error('[SERV SMOKE TEST FAILED] Response failed Zod schema validation:', error.message);
  if (error.issues) console.error('Issues:', error.issues);
  process.exit(1);
}

if (!parsed.claims || parsed.claims.length === 0) {
  console.error('[SERV SMOKE TEST FAILED] Model returned zero claims for explicit commitment text');
  process.exit(1);
}

const claim = parsed.claims[0];
const quoteCheck = validateQuotation(claim.quotation, sampleContent);
if (!quoteCheck.matched) {
  console.error('[SERV SMOKE TEST FAILED] Extracted quotation was not found in source content:', claim.quotation);
  process.exit(1);
}

const dateCheck = analyzeDateText(claim.dateText);
const dateSupported = !dateCheck.dateText || dateTextSupportedByQuotation(dateCheck.dateText, claim.quotation);
if (!dateSupported) {
  console.error('[SERV SMOKE TEST FAILED] Stated date text was not found in supporting quotation');
  process.exit(1);
}

const semanticError = validateClaimSemantics(claim.claimType, claim.quotation, dateCheck.dateText);
if (semanticError) {
  console.error('[SERV SMOKE TEST FAILED] Semantic guard failed:', semanticError.message);
  process.exit(1);
}

console.log('[SERV SMOKE TEST SUCCESS] OpenServ SERV Reasoning extraction verified!');
console.log('HTTP Status: 200 OK');
console.log('Duration:', durationMs, 'ms');
console.log('Model returned:', body.model ?? config.model);
console.log('Request ID:', response.headers.get('x-request-id') ?? body.id ?? 'N/A');
console.log('Usage:', body.usage ? `${body.usage.prompt_tokens} prompt + ${body.usage.completion_tokens} completion tokens` : 'N/A');
console.log('Extracted Claim Type:', claim.claimType);
console.log('Extracted Statement:', claim.statement);
console.log('Exact Quotation:', `"${claim.quotation}"`);
console.log('Verified in Source:', quoteCheck.matched);
console.log('Date Text:', claim.dateText);
console.log('Normalized Date:', dateCheck.normalizedDate, `(precision: ${dateCheck.precision})`);
console.log('Confidence:', claim.confidence);
console.log('Human Review Status: pending (Strictly awaiting human verification; zero auto-approval)');
console.log('=======================================================');
console.log('OpenServ SERV Reasoning AI integration is working and fully validated.');
