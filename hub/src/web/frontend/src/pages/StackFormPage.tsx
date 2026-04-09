import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, apiAuth } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { ServiceGroup } from '@/types/api';
import { useAuth } from '@/context/AuthContext';
import { useFormMessage } from '@/hooks/useFormMessage';
import { Card } from '@/components/Card';
import { FormField, Input, Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';
import { PageTitle } from '@/components/PageTitle';
import { BackLink } from '@/components/BackLink';

export function StackFormPage() {
  const { groupId } = useParams();
  const { isAuthenticated, token } = useAuth();
  const isEdit = !!groupId;

  const { data: existing, isLoading } = useQuery({
    queryKey: queryKeys.groupEdit(groupId),
    queryFn: () => api<ServiceGroup>(`/groups/${groupId}`),
    enabled: isEdit,
    refetchInterval: false,
  });

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (isEdit && isLoading) return null;

  return <StackForm key={groupId ?? 'new'} existing={existing} isEdit={isEdit} groupId={groupId} token={token} />;
}

function StackForm({ existing, isEdit, groupId, token }: { existing?: ServiceGroup; isEdit: boolean; groupId?: string; token: string | null }) {
  const navigate = useNavigate();

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '');
  const [color, setColor] = useState(existing?.color ?? '#3b82f6');
  const { msg, showSuccess, showError } = useFormMessage();

  const save = async () => {
    const body = { name, description: description || null, icon: icon || null, color: color || null };
    try {
      if (isEdit) {
        await apiAuth('PUT', `/groups/${groupId}`, body, token);
        showSuccess('Stack updated.');
      } else {
        const result = await apiAuth<{ id: number }>('POST', '/groups', body, token);
        showSuccess('Stack created.');
        setTimeout(() => navigate(`/stacks/${result.id}`), 500);
      }
    } catch (err) {
      showError(err);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this stack? Containers will not be affected.')) return;
    try {
      await apiAuth('DELETE', `/groups/${groupId}`, undefined, token);
      navigate('/stacks');
    } catch (err) {
      showError(err);
    }
  };

  return (
    <div className="space-y-6">
      <BackLink to={isEdit ? `/stacks/${groupId}` : '/stacks'} label="Back" />
      <PageTitle>{isEdit ? 'Edit Stack' : 'Create Stack'}</PageTitle>

      <Card className="max-w-xl">
        <div className="space-y-4">
          <FormField label="Name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Media Stack" maxLength={100} />
          </FormField>
          <FormField label="Description" description="Optional, shown on the stack card">
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Movies, TV, music apps" />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Icon" description="Emoji or text">
              <Input value={icon} onChange={e => setIcon(e.target.value)} placeholder="🎬" />
            </FormField>
            <FormField label="Color">
              <div className="flex gap-2">
                <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-10 w-10 cursor-pointer rounded border-0" />
                <Input value={color} onChange={e => setColor(e.target.value)} placeholder="#3b82f6" />
              </div>
            </FormField>
          </div>

          {msg && <AlertBanner message={msg.text} color={msg.color} />}

          <div className="flex gap-3">
            <Button onClick={save}>{isEdit ? 'Update' : 'Create'}</Button>
            {isEdit && <Button variant="danger" onClick={remove}>Delete</Button>}
          </div>
        </div>
      </Card>
    </div>
  );
}
