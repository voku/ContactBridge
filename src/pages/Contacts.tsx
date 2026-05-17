import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Search, Github, Twitter, Linkedin, Link2, Hash, CheckSquare, Trash2, Download, StickyNote, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { apiUrl } from '@/lib/api';

const getSourceIcon = (sourceType: string) => {
  switch (sourceType?.toLowerCase()) {
    case 'github': return <Github className="w-3.5 h-3.5" />;
    case 'x': case 'twitter': return <Twitter className="w-3.5 h-3.5" />;
    case 'linkedin': return <Linkedin className="w-3.5 h-3.5" />;
    case 'bluesky': return <Hash className="w-3.5 h-3.5" />;
    case 'mastodon': return <Hash className="w-3.5 h-3.5" />;
    case 'google': return <Mail className="w-3.5 h-3.5" />;
    default: return <Link2 className="w-3.5 h-3.5" />;
  }
};

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
    default: return '#';
  }
};

export default function Contacts() {
  const [contacts, setContacts] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  const [selectedContact, setSelectedContact] = useState<any | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  useEffect(() => {
    fetchContacts();
  }, []);

  const fetchContacts = async () => {
    try {
      const res = await fetch(apiUrl('/api/candidates'));
      const data = await res.json();
      setContacts(data.filter((c: any) => c.status === 'approved'));
    } catch (e) {
      console.error(e);
      toast.error('Failed to load contacts');
    }
  };

  const handleSaveNotes = async () => {
    if (!selectedContact) return;
    setIsSavingNotes(true);
    try {
      const res = await fetch(apiUrl(`/api/candidates/${selectedContact.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: notesDraft })
      });
      if (!res.ok) throw new Error('Failed to save');
      
      setContacts(prev => prev.map(c => c.id === selectedContact.id ? { ...c, notes: notesDraft } : c));
      toast.success('Notes saved successfully');
      setSelectedContact(null);
    } catch (e) {
      toast.error('Failed to save notes');
    } finally {
      setIsSavingNotes(false);
    }
  };

  const filteredContacts = contacts.filter(c => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const nameMatch = c.canonicalName?.toLowerCase().includes(query);
    const handleMatch = c.profiles?.some((p: any) => p.handle?.toLowerCase().includes(query));
    return nameMatch || handleMatch;
  });

  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      for (const id of Array.from(selectedIds)) {
        await fetch(apiUrl(`/api/candidates/${id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ignored' })
        });
      }
      toast.success(`Removed ${selectedIds.size} contacts.`);
      setSelectedIds(new Set());
      setIsSelectionMode(false);
      fetchContacts();
    } catch (e) {
      console.error(e);
      toast.error('Failed to remove some contacts');
    }
  };

  const handleBulkExportVcf = () => {
    if (selectedIds.size === 0) return;
      const selectedContacts = contacts.filter(c => selectedIds.has(c.id));
      const content = selectedContacts.map((c: any) => {
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
      
      const blob = new Blob([content], { type: 'text/vcard' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contacts_export_${new Date().getTime()}.vcf`;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success(`Exported ${selectedIds.size} contacts to vCard.`);
      setSelectedIds(new Set());
      setIsSelectionMode(false);
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approved Contacts</h1>
          <p className="text-gray-500 mt-1">
            Your clean, merged social address book mapped from your connections.
          </p>
        </div>
        {contacts.length > 0 && (
          <Button 
            variant={isSelectionMode ? "secondary" : "outline"} 
            onClick={toggleSelectionMode}
          >
            <CheckSquare className="w-4 h-4 mr-2" />
            {isSelectionMode ? "Cancel Selection" : "Select Contacts"}
          </Button>
        )}
      </div>

      {isSelectionMode && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4 flex items-center justify-between animate-in fade-in slide-in-from-top-4">
          <span className="text-sm font-medium text-indigo-900">
            {selectedIds.size} contact(s) selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => {
              if (selectedIds.size === filteredContacts.length) {
                setSelectedIds(new Set());
              } else {
                setSelectedIds(new Set(filteredContacts.map(c => c.id)));
              }
            }}>
              {selectedIds.size === filteredContacts.length ? "Deselect All" : "Select All"}
            </Button>
            <Button size="sm" variant="outline" disabled={selectedIds.size === 0} onClick={handleBulkExportVcf}>
              <Download className="w-4 h-4 mr-2" />
              Export
            </Button>
            <Button size="sm" variant="destructive" disabled={selectedIds.size === 0} onClick={handleBulkDelete}>
              <Trash2 className="w-4 h-4 mr-2" />
              Remove
            </Button>
          </div>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input 
          className="pl-9 bg-white" 
          placeholder="Search by name or handle..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {contacts.length === 0 ? (
        <div className="text-center py-16 text-gray-500 border border-dashed rounded-lg bg-gray-50">
          No approved contacts yet. Head over to the Review Queue to approve some candidates.
        </div>
      ) : filteredContacts.length === 0 ? (
        <div className="text-center py-16 text-gray-500 border border-dashed rounded-lg bg-gray-50">
          No contacts match your search.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredContacts.map((c: any) => (
            <Card 
              key={c.id} 
              className={`overflow-hidden transition-all ${isSelectionMode ? 'cursor-pointer hover:border-indigo-300' : 'cursor-pointer hover:shadow-md'} ${selectedIds.has(c.id) ? 'ring-2 ring-indigo-500 bg-indigo-50/10' : ''}`}
              onClick={() => {
                if (isSelectionMode) {
                  toggleSelect(c.id, !selectedIds.has(c.id));
                } else {
                  setSelectedContact(c);
                  setNotesDraft(c.notes || '');
                }
              }}
            >
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4 relative">
                {isSelectionMode && (
                  <div className="absolute top-4 left-4">
                    <Checkbox
                      checked={selectedIds.has(c.id)}
                      onCheckedChange={(checked) => toggleSelect(c.id, checked === true)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}
                <Avatar className="h-20 w-20">
                  <AvatarImage src={c.profiles[0]?.avatarUrl} />
                  <AvatarFallback>{c.canonicalName?.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="font-semibold text-gray-900 text-lg">{c.canonicalName}</h3>
                  <div className="flex flex-col items-center gap-2 mt-3 cursor-default" onClick={e => e.stopPropagation()}>
                    {c.profiles.map((p: any) => {
                      const url = getProfileUrl(p);
                      return (
                        <a 
                          key={p.id} 
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium transition-colors bg-gray-100 hover:bg-gray-200 text-gray-700 w-fit"
                        >
                          {getSourceIcon(p.sourceType)}
                          <span className="truncate max-w-[180px]">{p.handle || p.displayName}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
                {(() => {
                  const bio = c.profiles.find((p: any) => p.bio)?.bio;
                  if (!bio) return null;
                  return (
                    <p className="text-sm text-gray-500 line-clamp-3 text-ellipsis overflow-hidden mt-4 px-2" title={bio}>
                      {bio}
                    </p>
                  );
                })()}
                
                {c.notes && (
                  <div className="absolute top-4 right-4 text-amber-500" title="Has private notes">
                    <StickyNote className="w-5 h-5 fill-amber-100/50" />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selectedContact && (
        <Dialog open={!!selectedContact} onOpenChange={(open) => !open && setSelectedContact(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Contact Details</DialogTitle>
              <DialogDescription>
                Private notes for {selectedContact.canonicalName}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="notes">Private Notes</Label>
                <Textarea 
                  id="notes" 
                  placeholder="Add notes, ideas, or reminders about this contact..." 
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={6}
                />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setSelectedContact(null)}>Cancel</Button>
              <Button onClick={handleSaveNotes} disabled={isSavingNotes}>
                {isSavingNotes ? "Saving..." : "Save Notes"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
