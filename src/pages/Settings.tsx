import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Shield } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy & Settings</h1>
        <p className="text-gray-500 mt-1">Understand how your data is managed.</p>
      </div>

      <Card className="border-blue-100 bg-blue-50/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-blue-900">
            <Shield className="w-5 h-5" />
            Privacy Principles
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-blue-800">
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>No silent syncing:</strong> Profiles are not automatically merged. Every contact requires review.</li>
            <li><strong>Explicit connection:</strong> Source connectors are isolated. We only request least-privilege access.</li>
            <li><strong>No scraping:</strong> We rely entirely on official APIs or explicit manual captures you trigger.</li>
            <li><strong>Deletable by default:</strong> You own your data. You can delete the database or disconnect sources at any time.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data Management</CardTitle>
          <CardDescription>Manage your entire dataset stored on this service.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 p-4 border rounded-md">
            <div>
              <p className="font-medium text-gray-900">Delete all data</p>
              <p className="text-sm text-gray-500">Permanently erases all synced candidates, contacts, and tokens.</p>
            </div>
            <button className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors shrink-0">
              Erase Database
            </button>
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader>
          <CardTitle>Consent Audit Log</CardTitle>
          <CardDescription>Record of permissions you've granted.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500">No consent events recorded yet.</p>
        </CardContent>
      </Card>
    </div>
  );
}
