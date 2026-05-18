import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';
import { getLastExportAttempt, setLastExportAttempt } from '@/lib/localBeta';

type ExportFormat = {
  format: string;
  path: string;
};

type RuntimeStatus = {
  exportFormats: ExportFormat[];
};

type DashboardStats = {
  approvedContacts: number;
};

const formatDescriptions: Record<string, string> = {
  csv: 'A standard comma-separated file usable in most spreadsheet and CRM tools.',
  json: 'Raw structured data for developers and custom integrations.',
  vcf: 'A vCard file for Apple Contacts, Google Contacts, and phones.'
};

const buttonVariants: Record<string, 'default' | 'outline' | 'secondary'> = {
  csv: 'default',
  vcf: 'outline',
  json: 'secondary'
};
const createExportAttempt = (format: string, ok: boolean) => ({
  format,
  ok,
  timestamp: new Date().toISOString()
});

export default function Exports() {
  const [exportFormats, setExportFormats] = useState<ExportFormat[]>([]);
  const [approvedContacts, setApprovedContacts] = useState(0);
  const [lastExportAttempt, setLastExportAttemptState] = useState(getLastExportAttempt());
  const [activeFormat, setActiveFormat] = useState('');

  useEffect(() => {
    Promise.all([
      fetch(apiUrl('/api/status')).then((r) => {
        if (!r.ok) throw new Error('Failed to load export status');
        return r.json() as Promise<RuntimeStatus>;
      }),
      fetch(apiUrl('/api/dashboard')).then((r) => {
        if (!r.ok) throw new Error('Failed to load dashboard stats');
        return r.json() as Promise<DashboardStats>;
      })
    ])
      .then(([statusData, dashboardData]) => {
        setExportFormats(statusData.exportFormats);
        setApprovedContacts(dashboardData.approvedContacts);
      })
      .catch(console.error);
  }, []);

  const handleExport = async ({ format, path }: ExportFormat) => {
    setActiveFormat(format);

    try {
      const res = await fetch(apiUrl(path));
      if (!res.ok) {
        throw new Error('Export request failed');
      }

      const blob = await res.blob();
      const filename = `contacts.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      const nextAttempt = createExportAttempt(format, true);
      setLastExportAttempt(nextAttempt);
      setLastExportAttemptState(nextAttempt);
      toast.success(`Downloaded ${format.toUpperCase()} export`);
    } catch (e) {
      const nextAttempt = createExportAttempt(format, false);
      setLastExportAttempt(nextAttempt);
      setLastExportAttemptState(nextAttempt);
      toast.error('Failed to export data');
    } finally {
      setActiveFormat('');
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Export Data</h1>
        <p className="text-gray-500 mt-1">Export backend-generated contact files once you approve the candidates you want to keep.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approved contacts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{approvedContacts}</div>
            <p className="mt-2 text-sm text-gray-500">Only approved candidates are exported.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Available formats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{exportFormats.length}</div>
            <p className="mt-2 text-sm text-gray-500">
              {exportFormats.map(({ format }) => format.toUpperCase()).join(', ') || 'No formats detected'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last export attempt</CardTitle>
          </CardHeader>
          <CardContent>
            {lastExportAttempt ? (
              <div className="space-y-2 text-sm">
                <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${lastExportAttempt.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  {lastExportAttempt.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                  {lastExportAttempt.ok ? 'Success' : 'Failed'}
                </div>
                <p className="text-gray-600">{lastExportAttempt.format.toUpperCase()} · {new Date(lastExportAttempt.timestamp).toLocaleString()}</p>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No export attempt recorded yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        {exportFormats.map((exportFormat) => (
          <Card key={exportFormat.format}>
            <CardHeader>
              <CardTitle>{exportFormat.format.toUpperCase()} Export</CardTitle>
              <CardDescription>{formatDescriptions[exportFormat.format] || 'Download the backend-generated export file.'}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => handleExport(exportFormat)}
                variant={buttonVariants[exportFormat.format] || 'default'}
                className="w-full"
                disabled={activeFormat === exportFormat.format}
              >
                <Download className="w-4 h-4 mr-2" />
                {activeFormat === exportFormat.format ? 'Exporting…' : `Download ${exportFormat.format.toUpperCase()}`}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
