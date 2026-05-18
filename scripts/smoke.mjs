const baseUrl = (process.env.CONTACTBRIDGE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

const readResponseSnippet = async (response) => {
  try {
    const body = (await response.text()).trim();
    if (!body) {
      return '';
    }

    const snippet = body.replace(/\s+/g, ' ').slice(0, 240);
    return `; body: ${snippet}`;
  } catch {
    return '';
  }
};

const ensureOkResponse = async (response, label, url) => {
  if (response.ok) {
    return;
  }

  const snippet = await readResponseSnippet(response);
  throw new Error(`Request failed for ${label} (${url}): HTTP ${response.status} ${response.statusText}${snippet}`);
};

const expectHeaderIncludes = (response, headerName, expectedValue) => {
  const value = response.headers.get(headerName);
  if (!value || !value.toLowerCase().includes(expectedValue.toLowerCase())) {
    throw new Error(`Expected ${headerName} to include ${expectedValue}, received ${value || 'missing header'}`);
  }
};

const fetchJson = async (path, label = path) => {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url);
  await ensureOkResponse(response, label, url);
  return response.json();
};

let runtimeStatus;

try {
  runtimeStatus = await fetchJson('/api/status', 'runtime status');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke setup failed for ${baseUrl}`);
  console.error(`  ${message}`);
  process.exit(1);
}

const checks = [
  {
    label: 'health',
    path: '/api/health',
    validate: async (response) => {
      const payload = await response.json();
      if (payload?.status !== 'ok') {
        throw new Error(`Expected status=ok but received ${JSON.stringify(payload)}`);
      }
    }
  },
  {
    label: 'status',
    path: '/api/status',
    validate: async (response) => {
      const payload = await response.json();
      if (!payload?.appMode) {
        throw new Error(`Expected appMode in status payload, received ${JSON.stringify(payload)}`);
      }
      if (payload?.localFirstBeta !== true) {
        throw new Error(`Expected localFirstBeta=true, received ${JSON.stringify(payload)}`);
      }
    }
  },
  {
    label: 'extension health',
    path: '/api/extension/health',
    validate: async (response) => {
      const payload = await response.json();
      if (payload?.appName !== 'ContactBridge') {
        throw new Error(`Expected appName=ContactBridge but received ${JSON.stringify(payload)}`);
      }
    }
  },
  {
    label: 'CSV export',
    path: '/api/exports/contacts.csv',
    validate: async (response) => {
      expectHeaderIncludes(response, 'content-type', 'text/csv');
      const body = await response.text();
      if (!body.startsWith('Name,Source,Handle,Profile URL,Notes')) {
        throw new Error('CSV export did not include the expected header row for an empty-or-approved export response.');
      }
    }
  },
  {
    label: 'JSON export',
    path: '/api/exports/contacts.json',
    validate: async (response) => {
      expectHeaderIncludes(response, 'content-type', 'application/json');
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`JSON export did not return an array: ${JSON.stringify(payload)}`);
      }
    }
  },
  {
    label: 'VCF export',
    path: '/api/exports/contacts.vcf',
    validate: async (response) => {
      expectHeaderIncludes(response, 'content-type', 'text/vcard');
      const body = await response.text();
      if (typeof body !== 'string' || (body.length > 0 && !body.includes('BEGIN:VCARD'))) {
        throw new Error('VCF export did not return text in the expected empty-or-vCard format.');
      }
    }
  }
];

if (runtimeStatus?.appMode === 'local' || runtimeStatus?.appMode === 'test') {
  checks.push({
    label: 'database backup (non-destructive)',
    path: '/api/database/backup',
    validate: async (response) => {
      expectHeaderIncludes(response, 'content-type', 'application/json');
      const payload = await response.json();
      if (payload?.format !== 'contactbridge-backup-v1') {
        throw new Error(`Expected backup format contactbridge-backup-v1, received ${JSON.stringify(payload)}`);
      }
      if (payload?.appMode !== runtimeStatus.appMode) {
        throw new Error(`Expected backup appMode=${runtimeStatus.appMode}, received ${JSON.stringify(payload)}`);
      }
    }
  });
}

console.log(`Smoke base URL: ${baseUrl}`);
console.log(`Smoke APP_MODE: ${runtimeStatus?.appMode || 'unknown'}`);
console.log('Smoke endpoints:');
for (const check of checks) {
  console.log(`- ${check.label}: ${check.path}`);
}

let failed = false;

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  try {
    const response = await fetch(url);
    await ensureOkResponse(response, check.label, url);

    await check.validate(response);
    console.log(`✓ ${check.label}: ${url}`);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ ${check.label}: ${url}`);
    console.error(`  ${message}`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`Smoke checks passed for ${baseUrl} (${runtimeStatus.appMode})`);
}
