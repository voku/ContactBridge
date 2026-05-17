import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Users, AlertCircle, CheckCircle2, UserPlus, Clock, XCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { format, differenceInSeconds } from 'date-fns';
import { apiUrl } from '@/lib/api';

interface SyncJob {
  id: string;
  sourceType: string;
  displayName: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export default function Dashboard() {
  const [stats, setStats] = useState({ totalCandidates: 0, approvedContacts: 0, changedProfiles: 0, failedSyncJobs: 0 });
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);

  useEffect(() => {
    fetch(apiUrl('/api/dashboard'))
      .then(r => r.json())
      .then(setStats)
      .catch(console.error);

    fetch(apiUrl('/api/dashboard/sync-jobs'))
      .then(r => r.json())
      .then(setSyncJobs)
      .catch(console.error);
  }, []);

  const chartData = syncJobs.map(job => {
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
  }).reverse(); // chronological order for chart

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
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

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-gray-500 mt-1">Overview of your social contact hub.</p>
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
            <CardTitle className="text-sm font-medium text-gray-500">Changed Profiles</CardTitle>
            <UserPlus className="w-4 h-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.changedProfiles}</div>
            <p className="text-xs text-gray-400 mt-1">Profiles indexed</p>
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
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: '#F3F4F6' }} />
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
