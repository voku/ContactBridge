const baseUrl = (process.env.CONTACTBRIDGE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

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
      const body = await response.text();
      if (!body.startsWith('Name,Source,Handle,Profile URL,Notes')) {
        throw new Error('CSV export did not include the expected header row.');
      }
    }
  },
  {
    label: 'JSON export',
    path: '/api/exports/contacts.json',
    validate: async (response) => {
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
      const body = await response.text();
      if (typeof body !== 'string') {
        throw new Error('VCF export did not return text.');
      }
    }
  }
];

const run = async () => {
  let failed = false;

  for (const check of checks) {
    const url = `${baseUrl}${check.path}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

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
    return;
  }

  console.log(`Smoke checks passed for ${baseUrl}`);
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
