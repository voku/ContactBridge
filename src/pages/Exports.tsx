import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';

export default function Exports() {
  const handleExport = async (format: string) => {
    try {
      const exportPathByFormat: Record<string, string> = {
        csv: '/api/exports/contacts.csv',
        json: '/api/exports/contacts.json',
        vcf: '/api/exports/contacts.vcf'
      };

      const exportPath = exportPathByFormat[format];
      if (!exportPath) {
        throw new Error('Unsupported export format');
      }

      const res = await fetch(apiUrl(exportPath));
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

      toast.success(`Downloaded ${format.toUpperCase()} export`);
    } catch (e) {
      toast.error('Failed to export data');
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Export Data</h1>
        <p className="text-gray-500 mt-1">Export your approved social contacts into standard formats.</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>CSV Export</CardTitle>
            <CardDescription>A standard comma-separated file usable in almost any spreadsheet or CRM app.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => handleExport('csv')} className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Download CSV
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>vCard / VCF</CardTitle>
            <CardDescription>Import directly into Apple Contacts, Google Contacts, and phones.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => handleExport('vcf')} variant="outline" className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Download vCard
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>JSON Export</CardTitle>
            <CardDescription>Raw data export for developers and custom integrations.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => handleExport('json')} variant="secondary" className="w-full">
              <Download className="w-4 h-4 mr-2" />
              Download JSON
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
