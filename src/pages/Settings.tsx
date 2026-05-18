import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Shield, Upload, Download } from 'lucide-react';
import { apiUrl } from '@/lib/api';

type RuntimeStatus = {
  appMode: 'local' | 'test' | 'hosted';
  supportsLocalBackupRestore: boolean;
};

export default function SettingsPage() {
  const [isErasing, setIsErasing] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(apiUrl('/api/status'))
      .then((r) => {
        if (!r.ok) {
          throw new Error('Failed to load runtime status');
        }
        return r.json() as Promise<RuntimeStatus>;
      })
      .then(setRuntimeStatus)
      .catch(console.error);
  }, []);

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    return fallback;
  };

  const handleEraseDatabase = async () => {
    if (isErasing) {
      return;
    }

    const confirmed = window.confirm(
      'Erase all synced candidates, contacts, source accounts, and tokens? This cannot be undone.'
    );

    if (!confirmed) {
      return;
    }

    setIsErasing(true);

    try {
      const res = await fetch(apiUrl('/api/database'), {
        method: 'DELETE',
        headers: { 'X-ContactBridge-Confirm-Reset': 'erase-local-data' }
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: 'Failed to erase database' }));
        throw new Error(error.error || 'Failed to erase database');
      }

      toast.success('All ContactBridge data was erased.');
      window.location.assign(import.meta.env.BASE_URL);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Unexpected error while erasing database'));
    } finally {
      setIsErasing(false);
    }
  };

  const handleBackupDatabase = async () => {
    if (isBackingUp) {
      return;
    }

    setIsBackingUp(true);

    try {
      const response = await fetch(apiUrl('/api/database/backup'));
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to back up database' }));
        throw new Error(error.error || 'Failed to back up database');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'contactbridge-backup.json';
      link.click();
      URL.revokeObjectURL(url);
      toast.success('Database backup downloaded.');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unexpected error while backing up database'));
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || isRestoring) {
      return;
    }

    const confirmed = window.confirm(
      'Restore this backup and replace all current local ContactBridge data? This cannot be undone.'
    );
    if (!confirmed) {
      event.target.value = '';
      return;
    }

    setIsRestoring(true);

    try {
      const backupPayload = JSON.parse(await file.text());
      const response = await fetch(apiUrl('/api/database/restore'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ContactBridge-Confirm-Restore': 'restore-local-data'
        },
        body: JSON.stringify(backupPayload)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to restore database' }));
        throw new Error(error.error || 'Failed to restore database');
      }

      toast.success('Database restore completed.');
      window.location.assign(import.meta.env.BASE_URL);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Unexpected error while restoring database'));
    } finally {
      event.target.value = '';
      setIsRestoring(false);
    }
  };

  const backupRestoreEnabled = runtimeStatus?.supportsLocalBackupRestore ?? false;

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
          <CardTitle>Local Backup & Restore</CardTitle>
          <CardDescription>
            Create or restore a local JSON backup in {runtimeStatus?.appMode || 'this'} mode. Hosted mode keeps restore blocked.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 p-4 border rounded-md">
            <div>
              <p className="font-medium text-gray-900">Download backup</p>
              <p className="text-sm text-gray-500">Exports the current local SQLite data as a JSON backup file.</p>
            </div>
            <Button type="button" variant="outline" disabled={!backupRestoreEnabled || isBackingUp} onClick={handleBackupDatabase}>
              <Download className="w-4 h-4 mr-2" />
              {isBackingUp ? 'Backing up…' : 'Download Backup'}
            </Button>
          </div>

          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 p-4 border rounded-md">
            <div>
              <p className="font-medium text-gray-900">Restore backup</p>
              <p className="text-sm text-gray-500">Requires explicit confirmation and replaces all current local data.</p>
            </div>
            <>
              <input
                ref={restoreInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={handleRestoreFile}
              />
              <Button type="button" variant="outline" disabled={!backupRestoreEnabled || isRestoring} onClick={() => restoreInputRef.current?.click()}>
                <Upload className="w-4 h-4 mr-2" />
                {isRestoring ? 'Restoring…' : 'Restore Backup'}
              </Button>
            </>
          </div>

          {!backupRestoreEnabled && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
              Backup and restore are only available in local or test mode.
            </p>
          )}
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
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-red-200 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700"
              disabled={isErasing}
              onClick={handleEraseDatabase}
            >
              {isErasing ? 'Erasing…' : 'Erase Database'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
