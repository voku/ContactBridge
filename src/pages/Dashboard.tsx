import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Users, AlertCircle, CheckCircle2, UserPlus, Clock, XCircle, Server, Database, Plug, Rocket } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { format, differenceInSeconds } from 'date-fns';
import { apiUrl, getHubUrl } from '@/lib/api';
import { getLastExportAttempt, isExtensionConfigured } from '@/lib/localBeta';

interface SyncJob {
  id: string;
  sourceType: string;
  displayName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

interface DashboardStats {
  totalCandidates: number;
  approvedContacts: number;
  indexedProfiles: number;
  failedSyncJobs: number;
}

interface SourceAccount {
  id: string;
}

interface ExportFormat {
  format: string;
  path: string;
}

interface RuntimeStatus {
  appMode: 'local' | 'test' | 'hosted';
  backendReachable: boolean;
  databaseReachable: boolean;
  demoDataConfigured: boolean;
  exportFormats: ExportFormat[];
  extensionHealthPath: string;
  hostedWarning: string | null;
}

interface ChartDatum {
  name: string;
  duration: number;
  status: string;
  startedAt: string;
  errorMessage: string | null;
  sourceType: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
}

const DashboardTooltip = ({ active, payload }: ChartTooltipProps) => {
  const data = payload?.[0]?.payload;
  if (active && data) {
    return (
      <div className="bg-white p-3 border rounded shadow-sm text-sm">
        <p className="font-semibold">{data.name}</p>
        <p>Status: <span className={data.status === 'failed' ? 'text-red-500 font-medium' : data.status === 'completed' ? 'text-green-500 font-medium' : 'text-blue-500 font-medium'}>{data.status}</span></p>
        <p>Started: {data.startedAt}</p>
        <p>Duration: {data.duration}s</p>
        {data.errorMessage && <p className="text-red-500 mt-1 max-w-xs">{data.errorMessage}</p>}
      </div>
    );
  }
  return null;
};

const defaultStats: DashboardStats = {
  totalCandidates: 0,
  approvedContacts: 0,
  indexedProfiles: 0,
  failedSyncJobs: 0
};

const statusClassName = (ok: boolean) => ok
  ? 'border-green-200 bg-green-50 text-green-700'
  : 'border-gray-200 bg-gray-50 text-gray-600';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>(defaultStats);
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [sourceAccountCount, setSourceAccountCount] = useState(0);
  const [exportsAvailable, setExportsAvailable] = useState<Record<string, boolean>>({});
  const [extensionHealthAvailable, setExtensionHealthAvailable] = useState(false);
  const [backendReachable, setBackendReachable] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lastExportAttempt, setLastExportAttempt] = useState(getLastExportAttempt());
  const [extensionConfigured, setExtensionConfiguredState] = useState(isExtensionConfigured());

  useEffect(() => {
    const load = async () => {
      try {
        const [statusData, statsData, syncJobsData, sourceAccountsData] = await Promise.all([
          fetch(apiUrl('/api/status')).then((r) => {
            if (!r.ok) throw new Error('Failed to load runtime status');
            return r.json() as Promise<RuntimeStatus>;
          }),
          fetch(apiUrl('/api/dashboard')).then((r) => {
            if (!r.ok) throw new Error('Failed to load dashboard stats');
            return r.json() as Promise<DashboardStats>;
          }),
          fetch(apiUrl('/api/dashboard/sync-jobs')).then((r) => {
            if (!r.ok) throw new Error('Failed to load sync jobs');
            return r.json() as Promise<SyncJob[]>;
          }),
          fetch(apiUrl('/api/source-accounts')).then((r) => {
            if (!r.ok) throw new Error('Failed to load source accounts');
            return r.json() as Promise<SourceAccount[]>;
          })
        ]);

        setRuntimeStatus(statusData);
        setStats(statsData);
        setSyncJobs(syncJobsData);
        setSourceAccountCount(sourceAccountsData.length);
        setBackendReachable(true);
        setLoadError('');

        const exportChecks = await Promise.all(
          statusData.exportFormats.map(async ({ format, path }) => {
            try {
              const response = await fetch(apiUrl(path), { method: 'HEAD' });
              return [format, response.ok] as const;
            } catch {
              return [format, false] as const;
            }
          })
        );
        setExportsAvailable(Object.fromEntries(exportChecks));

        try {
          const response = await fetch(apiUrl(statusData.extensionHealthPath));
          setExtensionHealthAvailable(response.ok);
        } catch {
          setExtensionHealthAvailable(false);
        }
      } catch (error) {
        console.error(error);
        setBackendReachable(false);
        setLoadError(error instanceof Error ? error.message : 'Failed to load dashboard');
      }
    };

    load();

    const onStorage = () => {
      setLastExportAttempt(getLastExportAttempt());
      setExtensionConfiguredState(isExtensionConfigured());
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onStorage);
    };
  }, []);

  const chartData: ChartDatum[] = syncJobs.map((job) => {
    const start = new Date(job.startedAt);
    const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
    const duration = Math.max(1, differenceInSeconds(end, start));
    return {
      name: job.displayName || job.sourceType,
      duration,
      status: job.status,
      startedAt: format(start, 'HH:mm:ss'),
      errorMessage: job.errorMessage,
      sourceType: job.sourceType,
    };
  }).reverse();

  const exportFormats = runtimeStatus?.exportFormats ?? [];
  const allExportsAvailable = exportFormats.length > 0 && exportFormats.every(({ format }) => exportsAvailable[format]);
  const checklistItems = [
    { label: 'Backend running', done: backendReachable },
    { label: 'Database reachable', done: runtimeStatus?.databaseReachable ?? false },
    { label: 'At least one source account configured', done: sourceAccountCount > 0 },
    { label: 'At least one profile imported or captured', done: stats.indexedProfiles > 0 },
    { label: 'At least one candidate approved', done: stats.approvedContacts > 0 },
    { label: 'Export tested', done: Boolean(lastExportAttempt?.ok) },
    { label: 'Extension configured (for manual capture)', done: extensionConfigured }
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-gray-500 mt-1">Local-first beta onboarding, setup state, and sync history.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr,0.8fr] gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-blue-600" />
              First-run onboarding
            </CardTitle>
            <CardDescription>Use this to confirm your local beta setup before importing, reviewing, and exporting contacts.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {loadError}
              </div>
            )}

            {runtimeStatus?.hostedWarning && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {runtimeStatus.hostedWarning}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div className={`rounded-md border px-4 py-3 ${statusClassName(Boolean(runtimeStatus))}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">APP_MODE</div>
                <div className="mt-1 text-sm font-semibold">{runtimeStatus?.appMode || 'unavailable'}</div>
              </div>
              <div className={`rounded-md border px-4 py-3 ${statusClassName(backendReachable)}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Backend</div>
                <div className="mt-1 text-sm font-semibold">{backendReachable ? 'Reachable' : 'Unavailable'}</div>
              </div>
              <div className={`rounded-md border px-4 py-3 ${statusClassName(runtimeStatus?.databaseReachable ?? false)}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Database</div>
                <div className="mt-1 text-sm font-semibold">{runtimeStatus?.databaseReachable ? 'Reachable' : 'Unavailable'}</div>
              </div>
              <div className={`rounded-md border px-4 py-3 ${statusClassName(allExportsAvailable)}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Export endpoints</div>
                <div className="mt-1 text-sm font-semibold">
                  {exportFormats.length > 0
                    ? exportFormats.map(({ format }) => `${format.toUpperCase()}:${exportsAvailable[format] ? 'ok' : 'down'}`).join(' · ')
                    : 'Unavailable'}
                </div>
              </div>
              <div className={`rounded-md border px-4 py-3 ${statusClassName(extensionHealthAvailable)}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Extension health</div>
                <div className="mt-1 text-sm font-semibold">{extensionHealthAvailable ? 'Available' : 'Unavailable'}</div>
              </div>
              <div className={`rounded-md border px-4 py-3 ${statusClassName(Boolean(runtimeStatus))}`}>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Runtime type</div>
                <div className="mt-1 text-sm font-semibold">
                  {runtimeStatus?.appMode === 'hosted'
                    ? 'Hosted mode'
                    : runtimeStatus?.appMode === 'test'
                      ? 'Test mode'
                      : runtimeStatus?.appMode === 'local'
                        ? 'Local mode'
                        : 'Unavailable'}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-md border bg-gray-50 px-4 py-3 text-sm text-gray-700">
                <div className="flex items-center gap-2 font-medium text-gray-900">
                  <Server className="w-4 h-4 text-blue-600" />
                  Demo fixtures
                </div>
                <p className="mt-2">{runtimeStatus?.demoDataConfigured ? 'Configured for safe demo walkthroughs.' : 'Not configured.'}</p>
              </div>
              <div className="rounded-md border bg-gray-50 px-4 py-3 text-sm text-gray-700">
                <div className="flex items-center gap-2 font-medium text-gray-900">
                  <Plug className="w-4 h-4 text-blue-600" />
                  Extension hub URL
                </div>
                <p className="mt-2 font-mono text-xs break-all">{getHubUrl()}</p>
              </div>
              <div className="rounded-md border bg-gray-50 px-4 py-3 text-sm text-gray-700">
                <div className="flex items-center gap-2 font-medium text-gray-900">
                  <Database className="w-4 h-4 text-blue-600" />
                  Last export attempt
                </div>
                <p className="mt-2">
                  {lastExportAttempt
                    ? `${lastExportAttempt.ok ? 'Passed' : 'Failed'} · ${lastExportAttempt.format.toUpperCase()} · ${format(new Date(lastExportAttempt.timestamp), 'MMM d, h:mm a')}`
                    : 'No export tested yet.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Local beta checklist</CardTitle>
            <CardDescription>Finish these steps to prove the local-first beta flow is working end to end.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {checklistItems.map((item) => (
              <div key={item.label} className="flex items-start gap-3 rounded-md border px-3 py-3">
                <div className={`mt-0.5 rounded-full p-1 ${item.done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                  <CheckCircle2 className="w-4 h-4" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{item.label}</p>
                  <p className="text-xs text-gray-500">{item.done ? 'Complete' : 'Pending'}</p>
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-500">
              Only approved candidates are exportable. Use demo fixtures or connect one source, then review and approve at least one candidate.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-gray-500">Total Candidates</CardTitle>
            <Users className="w-4 h-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCandidates}</div>
            <p className="text-xs text-gray-400 mt-1">Waiting in review queue</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-gray-500">Approved Contacts</CardTitle>
            <CheckCircle2 className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.approvedContacts}</div>
            <p className="text-xs text-gray-400 mt-1">Ready for export</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-gray-500">Indexed Profiles</CardTitle>
            <UserPlus className="w-4 h-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.indexedProfiles}</div>
            <p className="text-xs text-gray-400 mt-1">Profiles currently stored</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-gray-500">Failed Syncs</CardTitle>
            <AlertCircle className="w-4 h-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.failedSyncJobs}</div>
            <p className="text-xs text-gray-400 mt-1">All-time failed jobs</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Sync Duration History</CardTitle>
            <CardDescription>Duration of recent sync jobs (in seconds)</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-[300px]">
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                  <XAxis dataKey="startedAt" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip content={<DashboardTooltip />} cursor={{ fill: '#F3F4F6' }} />
                  <Bar dataKey="duration" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.status === 'failed' ? '#ef4444' : entry.status === 'running' ? '#3b82f6' : '#22c55e'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-gray-500">
                No sync jobs found.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Sync Jobs</CardTitle>
            <CardDescription>Timeline of the last 20 jobs</CardDescription>
          </CardHeader>
          <CardContent>
            {syncJobs.length > 0 ? (
              <div className="space-y-4 max-h-[350px] overflow-y-auto pr-2">
                {syncJobs.map((job) => (
                  <div key={job.id} className="flex items-start gap-4 text-sm border-b pb-4 last:border-0 last:pb-0">
                    <div className={`mt-0.5 p-1.5 rounded-full ${job.status === 'failed' ? 'bg-red-100 text-red-600' : job.status === 'completed' ? 'bg-green-100 text-green-600' : 'bg-blue-100 text-blue-600'}`}>
                      {job.status === 'failed' ? <XCircle className="w-4 h-4" /> : job.status === 'completed' ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                    </div>
                    <div className="flex-1">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                        <p className="font-medium text-gray-900">{job.displayName || job.sourceType} <span className="font-normal text-gray-500">({job.sourceType})</span></p>
                        <span className="text-xs text-gray-400 font-medium whitespace-nowrap">
                          {format(new Date(job.startedAt), 'MMM d, h:mm a')}
                        </span>
                      </div>
                      <div className="text-gray-500 mt-1 flex items-center gap-2">
                        <span>Status: <span className="font-medium capitalize">{job.status}</span></span>
                        {job.finishedAt && (
                          <>
                            <span className="text-gray-300">•</span>
                            <span>{differenceInSeconds(new Date(job.finishedAt), new Date(job.startedAt))}s</span>
                          </>
                        )}
                      </div>
                      {job.errorMessage && (
                        <p className="text-red-600 text-xs mt-1.5 bg-red-50 p-2 rounded truncate max-w-[280px] sm:max-w-xs">{job.errorMessage}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center p-8 text-sm text-gray-500">
                No sync history available.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
