import React, { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { apiUrl, getAllowedPopupOrigins, getHubUrl } from '@/lib/api';
import { setExtensionConfigured } from '@/lib/localBeta';
import { runSyncTask } from '@/lib/syncUtils';

const parseSyncError = (platform: string, rawError: string) => {
  const errorMsg = rawError || 'Unknown error';
  let hint = 'Please check your connection and try again.';
  let helpLink;
  
  switch (platform) {
    case 'bluesky':
      if (errorMsg.toLowerCase().includes('password') || errorMsg.toLowerCase().includes('auth')) {
        hint = 'Make sure you are using an App Password, not your main account password.';
      } else if (errorMsg.toLowerCase().includes('not found')) {
        hint = 'Check if the handle is correct and exists on Bluesky.';
      }
      break;
    case 'x':
      if (errorMsg.toLowerCase().includes('auth') || errorMsg.toLowerCase().includes('token')) {
        hint = 'Please reconnect your X account or verify your app OAuth settings.';
      } else if (errorMsg.toLowerCase().includes('rate limit')) {
        hint = 'API rate limit exceeded. Please wait 15 minutes before trying again.';
      }
      break;
    case 'linkedin':
      hint = 'Make sure you have correctly configured the API or consider using the Chrome extension if the API is restricted.';
      if (errorMsg.toLowerCase().includes('permission') || errorMsg.toLowerCase().includes('unauthorized')) {
        hint = 'LinkedIn API requires approved partner access for full connection scraping.';
      }
      break;
    case 'mastodon':
      if (errorMsg.toLowerCase().includes('fetch') || errorMsg.toLowerCase().includes('network')) {
        hint = `Make sure the instance URL is correct, online, and doesn't require "https://" prefix if added.`;
      } else if (errorMsg.toLowerCase().includes('auth') || errorMsg.toLowerCase().includes('token')) {
        hint = `Ensure your access token is valid and generated for the specific instance.`;
      }
      break;
    case 'github':
      hint = 'Please review your GitHub token and try again.';
      if (errorMsg.toLowerCase().includes('bad credentials') || errorMsg.toLowerCase().includes('unauthorized')) {
        hint = 'Double check the Personal Access Token. Has it expired?';
        helpLink = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';
      } else if (errorMsg.toLowerCase().includes('rate limit')) {
        hint = 'GitHub API rate limit exceeded. You may need to wait before trying again.';
      }
      break;
    case 'google':
      hint = 'Please review your Google Access Token.';
      if (errorMsg.toLowerCase().includes('unauthorized') || errorMsg.toLowerCase().includes('401')) {
        hint = 'Your token may have expired. Google Access Tokens typically expire in 1 hour.';
      }
      break;
  }

  const titleMap: Record<string, string> = {
    bluesky: 'Bluesky sync failed',
    x: 'X (Twitter) sync failed',
    linkedin: 'LinkedIn connection failed',
    mastodon: 'Mastodon sync failed',
    github: 'GitHub sync failed',
    google: 'Google Contacts sync failed'
  };

  return {
    title: titleMap[platform] || 'Sync failed',
    description: `${errorMsg}. ${hint}`,
    helpLink
  };
};

const showErrorToast = (platform: string, rawError: string) => {
  const { title, description, helpLink } = parseSyncError(platform, rawError);
  toast.error(title, {
    description: helpLink ? (
      <div className="flex flex-col gap-2 mt-1">
        <p>{description}</p>
        <a 
          href={helpLink} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="text-blue-500 hover:text-blue-600 hover:underline inline-flex items-center gap-1 text-sm font-medium"
        >
          Learn more <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    ) : description
  });
};

const ExtensionSetupDialog = ({ triggerLabel = 'Extension Setup' }: { triggerLabel?: string }) => (
  <Dialog>
    <DialogTrigger render={<Button variant="secondary" />}>
      {triggerLabel}
    </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extension Setup</DialogTitle>
            <DialogDescription>
              To capture individual profiles from supported networks, or import the visible people on supported LinkedIn overview pages, follow these instructions:
            </DialogDescription>
          </DialogHeader>
      <div className="space-y-4 py-4 text-sm text-gray-700">
        <ol className="list-decimal pl-5 space-y-3">
          <li>Download the <code>extension</code> folder included in this source code.</li>
          <li>Open Chrome and navigate to <strong>chrome://extensions</strong></li>
          <li>Enable <strong>Developer mode</strong> in the top right.</li>
          <li>Click <strong>Load unpacked</strong> and select the <code>extension</code> folder.</li>
          <li>Click the ContactBridge extension button in Chrome (pin it first if it is only visible in the extensions menu) to open the Side Panel.</li>
          <li>Enter the following local hub URL when prompted:</li>
        </ol>
        <div className="bg-gray-100 p-3 rounded-md flex items-center justify-between">
          <code className="text-blue-600 font-mono text-xs">{getHubUrl()}</code>
          <Button size="sm" variant="outline" onClick={() => {
            navigator.clipboard.writeText(getHubUrl());
            setExtensionConfigured(true);
            toast.success('Hub URL copied');
          }}>Copy</Button>
        </div>
        <div className="space-y-2 text-xs text-gray-500 mt-2">
          <p>The extension validates <code>{`${getHubUrl()}/api/extension/health`}</code> before saving the hub.</p>
          <p>The extension uses Optional Permissions. You only grant it access to the specific sites you want to capture from.</p>
          <p>Packaged production extension builds must explicitly include any non-local hub origins before distribution.</p>
        </div>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setExtensionConfigured(true);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          }}
        >
          Mark setup reviewed
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default function Sources() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [bskyId, setBskyId] = useState('');
  const [bskyPass, setBskyPass] = useState('');
  const [bskySyncStatus, setBskySyncStatus] = useState('');
  const [xHandle, setXHandle] = useState('');
  const [xClientId, setXClientId] = useState('');
  const [xClientSecret, setXClientSecret] = useState('');
  const [xSyncStatus, setXSyncStatus] = useState('');
  const [linkedinHandle, setLinkedinHandle] = useState('');
  const [linkedinToken, setLinkedinToken] = useState('');
  const [linkedinSyncStatus, setLinkedinSyncStatus] = useState('');
  const [isXDialogOpen, setIsXDialogOpen] = useState(false);
  const [xSyncOutcome, setXSyncOutcome] = useState('');
  const [isLinkedinDialogOpen, setIsLinkedinDialogOpen] = useState(false);
  const [linkedinSyncOutcome, setLinkedinSyncOutcome] = useState('');
  const [isBskyDialogOpen, setIsBskyDialogOpen] = useState(false);
  const [bskySyncOutcome, setBskySyncOutcome] = useState('');
  const [mastodonInstance, setMastodonInstance] = useState('');
  const [mastodonToken, setMastodonToken] = useState('');
  const [mastodonSyncStatus, setMastodonSyncStatus] = useState('');
  const [isMastodonDialogOpen, setIsMastodonDialogOpen] = useState(false);
  const [mastodonSyncOutcome, setMastodonSyncOutcome] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubSyncStatus, setGithubSyncStatus] = useState('');
  const [isGithubDialogOpen, setIsGithubDialogOpen] = useState(false);
  const [githubSyncOutcome, setGithubSyncOutcome] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [googleSyncStatus, setGoogleSyncStatus] = useState('');
  const [isGoogleDialogOpen, setIsGoogleDialogOpen] = useState(false);
  const [googleSyncOutcome, setGoogleSyncOutcome] = useState('');

  useEffect(() => {
    fetchAccounts();
  }, []);

  const fetchAccounts = async () => {
    try {
      const res = await fetch(apiUrl('/api/source-accounts'));
      const data = await res.json();
      setAccounts(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      const res = await fetch(apiUrl(`/api/source-accounts/${id}`), {
        method: 'DELETE'
      });
      if (res.ok) {
        toast.success('Account disconnected successfully');
        fetchAccounts();
      } else {
        const error = await res.json();
        toast.error(`Failed to disconnect: ${error.error}`);
      }
    } catch (e: any) {
      console.error(e);
      toast.error(`Error disconnecting account: ${e.message}`);
    }
  };

  const handleConnectBluesky = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsBskyDialogOpen(false);
    setBskySyncOutcome('');
    try {
      // 1. Create source account
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'bluesky',
          accountIdentifier: bskyId,
          displayName: bskyId,
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      // 2. Trigger sync
      const syncData = await runSyncTask('/api/sync/bluesky', {
        sourceAccountId: id,
        identifier: bskyId,
        password: bskyPass
      }, setBskySyncStatus);
      
      if (syncData.success) {
        const msg = `Bluesky sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
        toast.success(msg);
        setBskySyncOutcome(msg);
        setBskyId('');
        setBskyPass('');
      }
      
      fetchAccounts();

    } catch (e: any) {
      showErrorToast('bluesky', e.message);
      setBskySyncOutcome(`Sync failed.`);
    } finally {
      setBskySyncStatus('');
    }
  };

  const handleConnectX = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'x',
          accountIdentifier: 'X OAuth',
          displayName: 'X (Twitter)',
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      const response = await fetch(apiUrl('/api/auth/x/url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: id,
          clientId: xClientId,
          clientSecret: xClientSecret,
          popupOrigin: window.location.origin
        })
      });
      if (!response.ok) {
        let msg = 'Failed to get auth URL';
        try { const errObj = await response.json(); msg = errObj.error || msg; } catch(e){}
        throw new Error(msg);
      }
      const { url } = await response.json();
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        toast.error('Please allow popups for this site to connect your X account.');
      }
    } catch (error: any) {
      toast.error('X OAuth setup error: ' + error.message);
    }
  };

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const allowedOrigins = getAllowedPopupOrigins();
      if (!allowedOrigins.has(event.origin)) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS_GOOGLE') {
        const { sourceAccountId } = event.data;
        setIsGoogleDialogOpen(false);
        setGoogleSyncOutcome('');
        
        try {
          if (!sourceAccountId) {
            throw new Error('Missing Google source account after OAuth callback.');
          }
          const syncData = await runSyncTask('/api/sync/google', {
            sourceAccountId
          }, setGoogleSyncStatus);
          
          if (syncData.success) {
            const msg = `Google Contacts sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
            toast.success(msg);
            setGoogleSyncOutcome(msg);
            setGoogleClientId('');
            setGoogleClientSecret('');
          }
          fetchAccounts();
        } catch (e: any) {
          showErrorToast('google', e.message);
          setGoogleSyncOutcome(`Sync failed.`);
        } finally {
          setGoogleSyncStatus('');
        }
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS_X') {
        const { sourceAccountId } = event.data;
        setIsXDialogOpen(false);
        setXSyncOutcome('');
        
        try {
          if (!sourceAccountId) {
            throw new Error('Missing X source account after OAuth callback.');
          }
          const syncData = await runSyncTask('/api/sync/x', {
            sourceAccountId
          }, setXSyncStatus);
          
          if (syncData.success) {
            const msg = `X sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
            toast.success(msg);
            setXSyncOutcome(msg);
            setXClientId('');
            setXClientSecret('');
          }
          fetchAccounts();
        } catch (e: any) {
          showErrorToast('x', e.message);
          setXSyncOutcome(`Sync failed.`);
        } finally {
          setXSyncStatus('');
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleConnectLinkedin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLinkedinDialogOpen(false);
    setLinkedinSyncOutcome('');
    try {
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'linkedin',
          accountIdentifier: 'LinkedIn API App',
          displayName: 'LinkedIn',
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      // 2. Trigger sync
      const syncData = await runSyncTask('/api/sync/linkedin', {
        sourceAccountId: id,
        handle: linkedinHandle,
        token: linkedinToken
      }, setLinkedinSyncStatus);
      
      if (syncData.success) {
        const msg = `LinkedIn sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
        toast.success(msg);
        setLinkedinSyncOutcome(msg);
        setLinkedinToken('');
        setLinkedinHandle('');
      }
      
      fetchAccounts();

    } catch (e: any) {
      showErrorToast('linkedin', e.message);
      setLinkedinSyncOutcome(`Sync failed.`);
    } finally {
      setLinkedinSyncStatus('');
    }
  };

  const handleConnectMastodon = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Client-side validation for instance URL
    let validateUrl = mastodonInstance.trim();
    if (!validateUrl.startsWith('http://') && !validateUrl.startsWith('https://')) {
      validateUrl = `https://${validateUrl}`;
    }
    try {
      new URL(validateUrl);
    } catch (_) {
      toast.error('Please enter a valid Mastodon instance URL.');
      return;
    }
    
    setIsMastodonDialogOpen(false);
    setMastodonSyncOutcome('');
    try {
      // 1. Create source account
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'mastodon',
          accountIdentifier: mastodonInstance,
          displayName: `Mastodon (${mastodonInstance})`,
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      // 2. Trigger sync
      const syncData = await runSyncTask('/api/sync/mastodon', {
        sourceAccountId: id,
        instance: mastodonInstance,
        token: mastodonToken
      }, setMastodonSyncStatus);
      
      if (syncData.success) {
        const msg = `Mastodon sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
        toast.success(msg);
        setMastodonSyncOutcome(msg);
        setMastodonInstance('');
        setMastodonToken('');
      }
      
      fetchAccounts();

    } catch (e: any) {
      showErrorToast('mastodon', e.message);
      setMastodonSyncOutcome(`Sync failed.`);
    } finally {
      setMastodonSyncStatus('');
    }
  };

  const handleConnectGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGithubDialogOpen(false);
    setGithubSyncOutcome('');
    try {
      // 1. Create source account
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'github',
          accountIdentifier: 'GitHub',
          displayName: 'GitHub',
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      // 2. Trigger sync
      const syncData = await runSyncTask('/api/sync/github', {
        sourceAccountId: id,
        token: githubToken
      }, setGithubSyncStatus);
      
      if (syncData.success) {
        const msg = `GitHub sync complete: ${syncData.insertedCount || 0} profiles imported, ${syncData.updatedCount || 0} updated.`;
        toast.success(msg);
        setGithubSyncOutcome(msg);
        setGithubToken('');
      }
      
      fetchAccounts();

    } catch (e: any) {
      showErrorToast('github', e.message);
      setGithubSyncOutcome(`Sync failed.`);
    } finally {
      setGithubSyncStatus('');
    }
  };

  const handleConnectGoogle = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const accRes = await fetch(apiUrl('/api/source-accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: 'google',
          accountIdentifier: 'Google Contacts',
          displayName: 'Google',
          authStatus: 'pending'
        })
      });
      const { id } = await accRes.json();

      const response = await fetch(apiUrl('/api/auth/google/url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAccountId: id,
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          popupOrigin: window.location.origin
        })
      });
      if (!response.ok) {
        let msg = 'Failed to get auth URL';
        try { const errObj = await response.json(); msg = errObj.error || msg; } catch(e){}
        throw new Error(msg);
      }
      const { url } = await response.json();
      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        toast.error('Please allow popups for this site to connect your Google Contacts.');
      }
    } catch (error: any) {
      toast.error('Google OAuth setup error: ' + error.message);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data Sources</h1>
        <p className="text-gray-500 mt-1">Connect your social networks to import contacts.</p>
      </div>
      
      <div className="grid gap-6">
        {/* Bluesky */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">Bluesky</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Import your followers and follows via the public AT Protocol endpoints. Uses an app password.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {bskySyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{bskySyncStatus}</span>}
              {!bskySyncStatus && bskySyncOutcome && <span className="text-sm font-medium text-gray-700">{bskySyncOutcome}</span>}
              <Dialog open={isBskyDialogOpen} onOpenChange={setIsBskyDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Connect Bluesky
                </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Connect Bluesky</DialogTitle>
                  <DialogDescription>
                    Enter your handle and an App Password. Do not use your main account password.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleConnectBluesky} className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="handle">Handle</Label>
                    <Input id="handle" placeholder="alice.bsky.social" value={bskyId} onChange={e => setBskyId(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">App Password</Label>
                    <Input id="password" type="password" value={bskyPass} onChange={e => setBskyPass(e.target.value)} required />
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={!!bskySyncStatus}>
                      {bskySyncStatus ? 'Syncing...' : 'Connect & Sync'}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
            </div>
          </div>
        </Card>

        {/* Mastodon */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">Mastodon</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                OAuth login per instance. Imports your follows and followers.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {mastodonSyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{mastodonSyncStatus}</span>}
              {!mastodonSyncStatus && mastodonSyncOutcome && <span className="text-sm font-medium text-gray-700">{mastodonSyncOutcome}</span>}
              <Dialog open={isMastodonDialogOpen} onOpenChange={setIsMastodonDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Connect Mastodon
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Connect Mastodon</DialogTitle>
                    <DialogDescription>
                      Enter your Mastodon instance URL and an access token.
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleConnectMastodon} className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="mastodonInstance">Instance URL</Label>
                      <Input id="mastodonInstance" placeholder="e.g. mastodon.social" value={mastodonInstance} onChange={e => setMastodonInstance(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="mastodonToken">Access Token</Label>
                      <Input id="mastodonToken" type="password" placeholder="Your Access Token" value={mastodonToken} onChange={e => setMastodonToken(e.target.value)} required />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={!!mastodonSyncStatus}>
                        {mastodonSyncStatus ? 'Syncing...' : 'Connect & Sync'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Card>

        {/* X / Twitter */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">X (Twitter)</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Connect via OAuth to sync your network.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              {xSyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{xSyncStatus}</span>}
              {!xSyncStatus && xSyncOutcome && <span className="text-sm font-medium text-gray-700">{xSyncOutcome}</span>}
              <Dialog open={isXDialogOpen} onOpenChange={setIsXDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Connect X (Twitter)
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                     <DialogTitle>Connect X (Twitter)</DialogTitle>
                     <DialogDescription>
                       Enter your X Client ID and Client Secret to authenticate via OAuth. 
                     </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleConnectX} className="space-y-4 py-4">
                    <div className="space-y-2">
                       <Label htmlFor="xClientId">Client ID</Label>
                       <Input id="xClientId" placeholder="Your X App Client ID" value={xClientId} onChange={e => setXClientId(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                       <Label htmlFor="xClientSecret">Client Secret</Label>
                       <Input id="xClientSecret" type="password" placeholder="Your X App Client Secret" value={xClientSecret} onChange={e => setXClientSecret(e.target.value)} required />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={!!xSyncStatus}>
                        {xSyncStatus ? 'Connecting...' : 'Connect & Sync'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Card>

        {/* LinkedIn */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">LinkedIn</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Explicit browser-extension capture is the primary path, including visible-profile import from supported LinkedIn overview pages. Official API sync is restricted to approved LinkedIn partner access.
              </CardDescription>
            </div>
            
            <div className="flex items-center gap-3">
              {linkedinSyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{linkedinSyncStatus}</span>}
              {!linkedinSyncStatus && linkedinSyncOutcome && <span className="text-sm font-medium text-gray-700">{linkedinSyncOutcome}</span>}
              <Dialog open={isLinkedinDialogOpen} onOpenChange={setIsLinkedinDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  LinkedIn API (restricted / partner access)
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>LinkedIn API (restricted / partner access)</DialogTitle>
                    <DialogDescription>
                      Only use this if you have approved LinkedIn partner API access. Otherwise, use the extension setup for manual capture.
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleConnectLinkedin} className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="linkedinHandle">Handle</Label>
                      <Input id="linkedinHandle" placeholder="e.g. reidhoffman" value={linkedinHandle} onChange={e => setLinkedinHandle(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="linkedinToken">Personal Access Token</Label>
                      <Input id="linkedinToken" type="password" placeholder="AQ..." value={linkedinToken} onChange={e => setLinkedinToken(e.target.value)} required />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={!!linkedinSyncStatus}>
                        {linkedinSyncStatus ? 'Syncing...' : 'Connect restricted API'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
              <ExtensionSetupDialog />
            </div>
            
          </div>
        </Card>

        {/* XING */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">XING</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Manual capture via the browser extension. XING does not expose a public contacts or network API that ContactBridge can sync directly.
              </CardDescription>
            </div>

            <div className="flex items-center gap-3">
              <ExtensionSetupDialog triggerLabel="Open Extension Setup" />
            </div>
          </div>
        </Card>

        {/* GitHub */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">GitHub</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Sync your GitHub followers and following using a Personal Access Token.
              </CardDescription>
            </div>
            
            <div className="flex items-center gap-3">
              {githubSyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{githubSyncStatus}</span>}
              {!githubSyncStatus && githubSyncOutcome && <span className="text-sm font-medium text-gray-700">{githubSyncOutcome}</span>}
              <Dialog open={isGithubDialogOpen} onOpenChange={setIsGithubDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Connect GitHub
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Connect GitHub</DialogTitle>
                    <DialogDescription>
                      Enter your GitHub Personal Access Token (requires read:user).
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleConnectGithub} className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="githubToken">Personal Access Token</Label>
                      <Input id="githubToken" placeholder="ghp_..." value={githubToken} onChange={e => setGithubToken(e.target.value)} required />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={!!githubSyncStatus}>
                        {githubSyncStatus ? 'Syncing...' : 'Connect & Sync'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Card>
        {/* Google Contacts */}
        <Card>
          <div className="flex flex-col sm:flex-row p-6 gap-6 items-start sm:items-center justify-between">
            <div>
              <CardTitle className="text-lg">Google Contacts</CardTitle>
              <CardDescription className="mt-2 text-sm max-w-md">
                Sync your Google Contacts using an Access Token (requires contacts.readonly scope).
              </CardDescription>
            </div>
            
            <div className="flex items-center gap-3">
              {googleSyncStatus && <span className="text-sm text-blue-600 font-medium animate-pulse">{googleSyncStatus}</span>}
              {!googleSyncStatus && googleSyncOutcome && <span className="text-sm font-medium text-gray-700">{googleSyncOutcome}</span>}
              <Dialog open={isGoogleDialogOpen} onOpenChange={setIsGoogleDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  Connect Google
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Connect Google Contacts</DialogTitle>
                    <DialogDescription>
                      Enter your Google Client ID and Client Secret to authenticate via OAuth. (Requires Google People API enabled and the Contacts API scopes)
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleConnectGoogle} className="space-y-4 py-4">
                    <div className="space-y-2">
                       <Label htmlFor="googleClientId">Client ID</Label>
                       <Input id="googleClientId" placeholder="Your Google App Client ID" value={googleClientId} onChange={e => setGoogleClientId(e.target.value)} required />
                    </div>
                    <div className="space-y-2">
                       <Label htmlFor="googleClientSecret">Client Secret</Label>
                       <Input id="googleClientSecret" type="password" placeholder="Your Google App Client Secret" value={googleClientSecret} onChange={e => setGoogleClientSecret(e.target.value)} required />
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={!!googleSyncStatus}>
                        {googleSyncStatus ? 'Syncing...' : 'Connect & Sync'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Card>
      </div>
      
      {accounts.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-semibold mb-4">Connected Accounts</h2>
          <Card>
            <div className="divide-y">
              {accounts.map(acc => (
                <div key={acc.id} className="p-4 flex justify-between items-center">
                  <div>
                    <div className="font-medium">{acc.displayName} <span className="text-xs ml-2 px-2 py-0.5 bg-gray-100 rounded-full">{acc.sourceType}</span></div>
                    <div className="text-sm mt-1">
                      Status: <span className={acc.authStatus === 'connected' ? 'text-green-600 font-medium' : 'text-gray-500 capitalize'}>{acc.authStatus}</span>
                    </div>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-red-500 hover:text-red-600 hover:bg-red-50"
                    onClick={() => handleDisconnect(acc.id)}
                  >
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
