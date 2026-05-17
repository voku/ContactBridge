import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { Check, X, GitMerge } from 'lucide-react';
import { toast } from 'sonner';

export default function ReviewQueue() {
  const [candidates, setCandidates] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isMerging, setIsMerging] = useState(false);

  useEffect(() => {
    fetchCandidates();
  }, []);

  const fetchCandidates = async () => {
    try {
      const res = await fetch('/api/candidates');
      const data = await res.json();
      setCandidates(data.filter((c: any) => c.status === 'pending'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleAction = async (id: string, action: 'approved' | 'ignored') => {
    try {
      await fetch(`/api/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: action })
      });
      toast.success(`Candidate ${action}`);
      setCandidates(candidates.filter(c => c.id !== id));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      toast.error('Failed to update candidate');
    }
  };

  const toggleSelect = (id: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleMerge = async () => {
    if (selectedIds.size < 2) return;
    setIsMerging(true);
    const ids = Array.from(selectedIds);
    const primaryCandidateId = ids[0];
    try {
      const res = await fetch('/api/candidates/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryCandidateId,
          secondaryCandidateIds: ids.slice(1)
        })
      });
      if (!res.ok) throw new Error('Merge failed');
      
      toast.success(`Merged ${ids.length} candidates together.`);
      setSelectedIds(new Set());
      fetchCandidates();
    } catch (e) {
      console.error(e);
      toast.error('Failed to merge candidates');
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review Queue</h1>
          <p className="text-gray-500 mt-1">
            Every imported identity becomes a candidate. Review them here before adding to your contacts.
          </p>
        </div>
        {selectedIds.size > 1 && (
          <Button onClick={handleMerge} disabled={isMerging} className="shrink-0 bg-indigo-600 hover:bg-indigo-700">
            <GitMerge className="w-4 h-4 mr-2" />
            Merge Selected ({selectedIds.size})
          </Button>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="text-center py-16 text-gray-500 border border-dashed rounded-lg bg-gray-50">
          No pending candidates to review.
        </div>
      ) : (
        <div className="grid gap-4">
          {candidates.map((c: any) => (
            <Card key={c.id} className={selectedIds.has(c.id) ? "ring-2 ring-indigo-500 bg-indigo-50/10" : ""}>
              <CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  <Checkbox 
                    checked={selectedIds.has(c.id)} 
                    onCheckedChange={(checked) => toggleSelect(c.id, checked === true)} 
                    className="mt-1 sm:mt-0"
                  />
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={c.profiles[0]?.avatarUrl} />
                    <AvatarFallback>{c.canonicalName?.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="space-y-1">
                    <h3 className="font-semibold text-gray-900">{c.canonicalName}</h3>
                    <div className="flex flex-wrap gap-2 text-sm text-gray-500">
                      {c.profiles.map((p: any) => (
                        <div key={p.id} className="flex flex-col">
                           <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full text-xs font-medium w-fit">
                             {p.sourceType}: {p.handle}
                           </span>
                           {p.bio && <span className="text-xs truncate max-w-xs mt-1">{p.bio}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 mt-4 sm:mt-0 ml-8 sm:ml-0">
                  <Button variant="outline" size="sm" onClick={() => handleAction(c.id, 'ignored')} className="flex-1 sm:flex-none text-red-600 hover:text-red-700 hover:bg-red-50">
                    <X className="w-4 h-4 mr-2" />
                    Ignore
                  </Button>
                  <Button size="sm" onClick={() => handleAction(c.id, 'approved')} className="flex-1 sm:flex-none">
                    <Check className="w-4 h-4 mr-2" />
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
