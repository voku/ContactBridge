import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';

const getProfileUrl = (p: any) => {
  if (p.profileUrl) return p.profileUrl;
  try {
    const raw = p.rawPublicPayloadJson ? JSON.parse(p.rawPublicPayloadJson) : {};
    if (p.sourceType === 'mastodon' && raw.url) return raw.url;
    if (p.sourceType === 'github' && raw.html_url) return raw.html_url;
  } catch (e) {}

  switch (p.sourceType?.toLowerCase()) {
    case 'github': return `https://github.com/${p.handle}`;
    case 'x': case 'twitter': return `https://x.com/${p.handle}`;
    case 'bluesky': return `https://bsky.app/profile/${p.handle}`;
    case 'linkedin': return `https://linkedin.com/in/${p.handle}`;
    case 'xing': return `https://www.xing.com/profile/${p.handle}`;
    default: return '#';
  }
};

export default function Exports() {
  const handleExport = async (format: string) => {
    try {
      const res = await fetch(apiUrl('/api/candidates'));
      const data = await res.json();
      const approved = data.filter((c: any) => c.status === 'approved');
      
      let content = '';
      let filename = '';
      let mimeType = '';

      if (format === 'csv') {
        content = ['Name,Source,Handle'].join(',');
        content += '\n' + approved.map((c: any) => {
          const profile = c.profiles[0];
          return `"${c.canonicalName || ''}","${profile?.sourceType || ''}","${profile?.handle || ''}"`;
        }).join('\n');
        filename = 'contacts.csv';
        mimeType = 'text/csv';
      } else if (format === 'json') {
        content = JSON.stringify(approved, null, 2);
        filename = 'contacts.json';
        mimeType = 'application/json';
      } else if (format === 'vcf') {
        content = approved.map((c: any) => {
          let vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\n';
          vcard += `FN:${c.canonicalName || 'Unknown'}\r\n`;
          vcard += `N:${c.canonicalName || 'Unknown'};;;;\r\n`;
          c.profiles.forEach((p: any) => {
            const url = getProfileUrl(p);
            if (url && url !== '#') {
              vcard += `URL;type=${p.sourceType}:${url}\r\n`;
            }
            if (p.bio && vcard.indexOf('NOTE:') === -1) {
              const safeBio = p.bio.replace(/\n|\r/g, ' ').replace(/;/g, '\\;');
              vcard += `NOTE:${safeBio}\r\n`;
            }
          });
          vcard += 'END:VCARD\r\n';
          return vcard;
        }).join('');
        filename = 'contacts.vcf';
        mimeType = 'text/vcard';
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      
      toast.success(`Exported ${approved.length} contacts as ${format.toUpperCase()}`);
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
